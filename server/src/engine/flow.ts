/**
 * Flow classification — the single source of truth for what a transaction IS.
 *
 * Every transaction gets a persisted `flow_type`:
 *
 *   income        real money earned (paycheck, freelance, interest earned)
 *   expense       real money spent on goods/services
 *   transfer      internal move between owned accounts, or the funding leg of a
 *                 card payment (principal is a balance-sheet move, not spending)
 *   debt_payment  money arriving ON a liability account (credit/loan/mortgage)
 *                 that pays the balance down — never income
 *   interest_fee  interest/fees charged — a true expense
 *   refund        reversal of a prior purchase — nets against the original
 *                 category, never income
 *
 * Aggregation contract (used by every report/insight/budget query):
 *   income   = sqlIncome()    — SUM(amount) over flow_type = 'income'
 *   expenses = sqlExpenses()  — SUM(ABS) over expense+interest_fee, MINUS refunds
 *
 * Headline totals and category rollups call the SAME two helpers, so a refund
 * can never make the summary card and the category table disagree.
 *
 * This module replaces the three divergent transfer keyword lists that used to
 * live in analysis.ts (x2) and reports.ts. Nothing may infer income from
 * `amount > 0` any more.
 *
 * Decision table (applied in order; first match wins):
 *
 *   1. PAIRED  opposite-sign rows, equal |amount| (±1¢), different owned
 *      accounts, ≤3 days apart, transfer-eligible (a transfer/card-payment-like
 *      name on either leg, a Transfer/CC-PMT category, or the positive leg
 *      landing on a liability account):
 *        - positive leg on credit/loan/mortgage  → debt_payment
 *        - every other leg                       → transfer
 *      Both legs get transfer_pair_id = the other leg's id.
 *   2. amount < 0, name matches the interest/fee library      → interest_fee
 *   3. amount < 0, transfer-like name or Transfer/CC PMT cat. → transfer
 *   4. amount < 0 on a liability account (card purchase)      → expense
 *   5. amount < 0, card-payment-like name AND the user owns a
 *      liability account (unmatched card-payment leg)         → transfer
 *   6. amount < 0                                             → expense
 *   7. amount > 0 on a liability account:
 *        refund-like name, or prior debit at the same merchant
 *        within 90 days of comparable size                    → refund
 *        otherwise (a payment received on the card)           → debt_payment
 *   8. amount > 0, refund-like name                           → refund
 *   9. amount > 0, transfer-like name or Transfer category    → transfer
 *  10. amount > 0, prior debit at the same merchant within
 *      90 days of comparable size                             → refund
 *  11. amount > 0                                             → income
 *  (amount = 0 → expense; contributes nothing to any sum)
 *
 * Where a card payment's principal/interest split is unknowable the whole
 * payment is a transfer, and the card's own interest charges are interest_fee —
 * the payment and the purchases it settles are never both counted.
 */
import { db as defaultDb } from '../db/database.js';
import type { Sql } from '../db/sql.js';

export const FLOW_TYPES = ['income', 'expense', 'transfer', 'debt_payment', 'interest_fee', 'refund'] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/** Account types whose balance is owed, not owned. */
export const LIABILITY_ACCOUNT_TYPES = ['credit', 'loan', 'mortgage'] as const;

/** SQL fragments so every aggregate spells the contract identically. */
export const SQL_INCOME_FLOW = `flow_type = 'income'`;
export const SQL_EXPENSE_FLOWS = `flow_type IN ('expense', 'interest_fee')`;
/** Rows that participate in the spending total: outflows AND their reversals. */
export const SQL_SPEND_FLOWS = `flow_type IN ('expense', 'interest_fee', 'refund')`;

const col = (alias: string) => (alias ? `${alias}.` : '');

/**
 * THE income expression. `SUM(amount)` over income rows — transfers between
 * Marcelo's own accounts, credit-card payments and refunds are never income.
 */
export function sqlIncome(alias = ''): string {
  const c = col(alias);
  return `COALESCE(SUM(CASE WHEN ${c}flow_type = 'income' THEN ${c}amount ELSE 0 END), 0)`;
}

/**
 * THE spending expression — real outflows NET OF REFUNDS.
 *
 * Audit finding H6: category rollups already netted refunds while every
 * headline "total expenses" card ignored them, so an Amazon return made the
 * category table and the summary card disagree inside a single response and
 * overstated spending by the gross refund total. Both now call this.
 *
 * ABS() on both legs so the sum is sign-convention-proof: a refund stored as a
 * negative (some card exports do) still reduces spending rather than adding to
 * it.
 */
export function sqlExpenses(alias = ''): string {
  const c = col(alias);
  return `COALESCE(SUM(CASE WHEN ${c}flow_type IN ('expense', 'interest_fee') THEN ABS(${c}amount)`
    + ` WHEN ${c}flow_type = 'refund' THEN -ABS(${c}amount)`
    + ` ELSE 0 END), 0)`;
}

/** Gross refunds (positive) — what sqlExpenses() subtracted. */
export function sqlRefunds(alias = ''): string {
  const c = col(alias);
  return `COALESCE(SUM(CASE WHEN ${c}flow_type = 'refund' THEN ABS(${c}amount) ELSE 0 END), 0)`;
}

/** Money moved between owned accounts / paid onto debt — neither in nor out. */
export function sqlTransfers(alias = ''): string {
  const c = col(alias);
  return `COALESCE(SUM(CASE WHEN ${c}flow_type IN ('transfer', 'debt_payment') THEN ABS(${c}amount) ELSE 0 END), 0)`;
}

/**
 * Amount owed on an account (audit D7 — debt math must not be sign-blind).
 * Handles both storage conventions: cards store owed balances as negatives;
 * loans/mortgages sometimes store the owed amount as a positive. An overpaid
 * card (credit balance, i.e. positive on a credit account) owes 0 — never
 * abs(), which would report a credit balance as MORE debt.
 */
export function liabilityOwed(accountType: string, balance: number): number {
  if (!isLiabilityType(accountType)) return 0;
  const b = balance || 0;
  if (b < 0) return -b;                          // negative-stored: amount owed
  return accountType === 'credit' ? 0 : b;       // overpaid card owes nothing; positive-stored loan is owed
}

// ---------------------------------------------------------------------------
// Name pattern library (the ONE place transfer/fee/refund keywords live)
// ---------------------------------------------------------------------------

// Zelle, Venmo and PayPal are NOT here. They are payment rails: this household
// receives ~$220k of income and pays ~$20k of contractors, coaches and
// therapists over Zelle. Treating the rail as the meaning classified the
// owner's own salary as a transfer and made every hand-correction revert.
//
// "wire" is also gone as a bare word — an inbound wire is as likely to be a
// vehicle sale or a client payment as an internal move, so it falls through to
// the income/refund logic and gets confirmed rather than silently buried.
const TRANSFER_RE = new RegExp(
  [
    '\\btransfer\\b', '\\bxfer\\b',
    'internal transfer', 'funds transfer', 'mobile transfer',
    'online banking transfer', 'online scheduled transfer', 'automatic transfer',
    'overdraft protection',
    '\\b(?:to|from) (?:savings|checking|chk|sav)\\b',
  ].join('|'),
);

/**
 * Card-payment shapes. Deliberately does NOT match a bare "payment" —
 * "Rent Payment" is a real expense. Requires an explicit card/issuer signal.
 */
// Bare 'autopay', 'pymt', 'epay' and 'ach pmt' are gone. They matched a
// mortgage descriptor containing "PYMT", insurance on autopay, and utilities on
// autopay — silently removing the household's two largest fixed costs from
// spending. A card payment now needs a card, a loan, or a named issuer.
const CARD_PAYMENT_RE = new RegExp(
  [
    'payment thank you', 'thank you.*payment',
    '\\bpayment to (?:crd|card)\\b',
    '\\b(?:crd|card|cc) ?(?:pmt|payment)\\b', 'crcardpmt', 'cardmember (?:pmt|payment)',
    'credit card (?:bill )?payment',
    // card-only issuers + a payment word; deposit/mortgage megabanks are deliberately
    // NOT listed here ("WELLS FARGO HOME MTG PAYMENT" must stay an expense) — their
    // card-payment descriptors carry crd/autopay/epay/pymt and match above.
    '(?:amex|american express|discover|barclay|synchrony)\\b.*\\b(?:payment|pmt|pymt|autopay|epay)',
  ].join('|'),
);

/** Interest & fee shapes (checked on debits only — "interest earned" credits stay income). */
const INTEREST_FEE_RE = new RegExp(
  [
    '\\binterest\\b', 'finance charge', 'late fee', 'annual fee', '\\boverdraft\\b',
    '\\bnsf\\b', 'returned item', 'atm fee', 'service fee', 'maintenance fee',
    '\\bpenalt', '\\bsurcharge\\b', 'foreign transaction', 'fx fee', 'wire fee',
    'monthly fee', 'cash advance fee', 'balance transfer fee',
  ].join('|'),
);

const REFUND_RE = new RegExp(
  ['\\brefund\\b', '\\brevers(?:al|ed|e)\\b', '\\brebate\\b', '\\bchargeback\\b', '\\breturn\\b', 'credit memo'].join('|'),
);

function norm(name: string): string {
  return String(name || '').toLowerCase().replace(/[#*]|\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isLiabilityType(type: string | undefined): boolean {
  return LIABILITY_ACCOUNT_TYPES.includes((type || '') as any);
}

function epochDay(dateStr: string): number {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface TxnRow {
  id: string;
  account_id: string;
  name: string;
  amount: number;
  date: string;
  category_id: string | null;
  flow_type: string | null;
  transfer_pair_id: string | null;
}

interface ClassifyContext {
  accountTypes: Map<string, string>;
  userHasLiabilityAccount: boolean;
  /** lowercased category name by id */
  categoryNames: Map<string, string>;
  /** normalized merchant name → debit occurrences (epoch day, abs amount) */
  merchantDebits: Map<string, Array<{ day: number; abs: number }>>;
}

function categoryOf(t: TxnRow, ctx: ClassifyContext): string {
  return (t.category_id && ctx.categoryNames.get(t.category_id)) || '';
}

function hasComparablePriorDebit(t: TxnRow, ctx: ClassifyContext): boolean {
  const debits = ctx.merchantDebits.get(norm(t.name));
  if (!debits || debits.length === 0) return false;
  const day = epochDay(t.date);
  for (const d of debits) {
    if (d.day <= day && day - d.day <= 90 && t.amount <= d.abs * 1.05 + 0.01) return true;
  }
  return false;
}

/**
 * Categories that settle a balance rather than buy anything. Money leaving the
 * checking account toward one of these settles a balance rather than buying
 * something new. Whether it still counts as money out depends on whether the
 * liability account is loaded — see classifyUnpaired(). With no card account
 * in the database the purchases were never recorded, so the payment is the
 * only evidence the spending happened, and it counts.
 */
const DEBT_CATEGORIES = new Set(['cc pmt', 'loan payment', 'mortgage']);

/**
 * Categories that name real consumption. When one of these is set, it beats
 * any guess the classifier would make from the descriptor.
 *
 * This is the fix for the correction that would not stick: a Zelle payment to
 * a soccer coach, re-categorised by hand as "Kids", used to be read back as
 * "zelle" → transfer and dropped straight out of the spending total again.
 * An explicit category is evidence about meaning; a payment rail in the
 * descriptor is not.
 */
/**
 * Categories that move value around rather than consume it. A negative row in
 * one of these is money going INTO something the household owns (a brokerage
 * deposit, a loan repayment of principal) — not spending.
 */
const NON_CONSUMPTION_CATEGORIES = new Set([
  'transfer', 'asset transfer', 'asset sale', 'loan proceeds', 'refund',
]);

function isSpendingCategory(cat: string): boolean {
  if (!cat) return false;
  return !NON_CONSUMPTION_CATEGORIES.has(cat) && !DEBT_CATEGORIES.has(cat) && !cat.includes('income');
}

/** Lenders whose inbound money is borrowing, not earnings. */
const LOAN_PROCEEDS_RE = /\b(?:prosper|sofi|lending ?club|upstart|best ?egg|avant|marcus|happy money|discover personal loan)\b/i;

/** Classify one transaction that did NOT match a transfer pair. */
export function classifyUnpaired(t: TxnRow, ctx: ClassifyContext): FlowType {
  const name = String(t.name || '').toLowerCase();
  const acctIsLiability = isLiabilityType(ctx.accountTypes.get(t.account_id));
  const cat = categoryOf(t, ctx);

  if (t.amount < 0) {
    // Debt service — card payments, mortgages, loan payments — is spending.
    //
    // Owner's ruling (26 Aug 2026): "Make sure every CC PMT is an expense and
    // is treated as such, not a transfer."
    //
    // This used to send card and loan payments to `transfer`, on the theory
    // that the purchases they settle are already counted on the card account.
    // That theory needs the card's TRANSACTIONS to be in the database, and they
    // are not — importing a card statement is a separate act from creating the
    // account. $184,812.54 of real outflow over 18 months landed in no column
    // at all as a result.
    //
    // The guard against double-counting lives where it belongs: in the pairing
    // rule above. A payment that actually matches a credit on a liability
    // account becomes `debt_payment` there, and that can only happen once the
    // card's own rows exist. Merely OWNING a card account is not evidence its
    // purchases were imported — an earlier version tested that and wrongly
    // suppressed every payment for a user who had created the accounts but
    // never uploaded their statements.
    if (DEBT_CATEGORIES.has(cat)) return 'expense';
    // A real spending category outranks the descriptor. Without this, anything
    // paid over Zelle or Venmo stays a transfer no matter how it is labelled.
    if (isSpendingCategory(cat)) return 'expense';
    // Money going INTO an asset the household owns (a brokerage deposit is the
    // mirror of the withdrawals ruled an asset transfer) is not consumption.
    if (NON_CONSUMPTION_CATEGORIES.has(cat)) return 'transfer';
    // Transfer shape is tested BEFORE the fee library: "OVERDRAFT PROTECTION TO
    // CHK 4301" is an internal sweep, and \boverdraft\b in the fee patterns
    // used to book 88 of those as bank charges.
    if (TRANSFER_RE.test(name) || cat === 'transfer') return 'transfer';
    if (INTEREST_FEE_RE.test(name)) return 'interest_fee';
    if (acctIsLiability) return 'expense'; // purchases charged to the card
    return 'expense';
  }

  if (t.amount > 0) {
    if (acctIsLiability) {
      if (REFUND_RE.test(name) || hasComparablePriorDebit(t, ctx)) return 'refund';
      return 'debt_payment'; // a positive amount on a credit/loan account is never income
    }
    if (REFUND_RE.test(name)) return 'refund';
    // Three ways money arrives that are NOT earnings, all owner-confirmed:
    //   loan proceeds  — borrowing raises the balance and the debt equally
    //                    (the $43,000 Prosper drawdown that funded the roof)
    //   asset sale     — selling something you owned converts value, not creates
    //                    it (the $19,675 Carvana wire for the car)
    //   asset transfer — moving your own money between accounts you own
    //                    (the $39,200 of Interactive Brokers ACH withdrawals)
    if (
      LOAN_PROCEEDS_RE.test(name) ||
      cat === 'loan proceeds' ||
      cat === 'asset sale' ||
      cat === 'asset transfer'
    ) return 'transfer';
    if (cat.includes('income')) return 'income';
    // Money arriving into a category that names CONSUMPTION is that spending
    // coming back — a returned purchase, a reversed charge, a refunded deposit.
    // It is not earnings. Without this a +$40 credit sitting in Food & Dining
    // was booked as income: the printable statement surfaced $3,457 of it in
    // one month, listing College Savings and Entertainment as income lines.
    // As a refund it nets against the category it came from, which is what the
    // rollups already expect.
    if (isSpendingCategory(cat)) return 'refund';
    if (TRANSFER_RE.test(name) || cat === 'transfer') return 'transfer';
    if (hasComparablePriorDebit(t, ctx)) return 'refund';
    return 'income';
  }

  return 'expense'; // zero-amount rows contribute nothing either way
}

/** Is this candidate pair an internal transfer / card payment (vs coincidence)? */
function pairEligible(neg: TxnRow, pos: TxnRow, ctx: ClassifyContext): boolean {
  const negName = String(neg.name || '').toLowerCase();
  const posName = String(pos.name || '').toLowerCase();
  const negCat = categoryOf(neg, ctx);
  const posCat = categoryOf(pos, ctx);

  // VETO 1 — never pair away a row that names real consumption.
  //
  // A category is evidence about what the money was FOR, and it outranks a
  // coincidence of sign, amount and date. Without this veto the matcher ate
  // three $25 account maintenance fees (paired against the $25 monthly savings
  // sweep), a $300 ISTOURS purchase and two $200 soccer-club charges already
  // categorised as Kids — $800 of real spending that vanished from the expense
  // column while the books still balanced, which is why nobody noticed.
  if (isSpendingCategory(negCat) || isSpendingCategory(posCat)) return false;

  // VETO 2 — a refund is a reversal of a purchase, not the far leg of a move.
  if (REFUND_RE.test(posName) || posCat === 'refund') return false;

  // Both legs must look like a transfer. This used to accept a signal on
  // EITHER leg, so any outflow at all could be captured by an unrelated
  // transfer-shaped inflow of the same amount. On 09/03/2025 a -$11,500
  // transfer was eligible to pair with the +$11,500 Zelle that is Marcelo's
  // salary; it escaped only because the genuine matching leg happened to be
  // one day closer, and ties break on random UUID order.
  const negLooksLikeTransfer =
    TRANSFER_RE.test(negName) || CARD_PAYMENT_RE.test(negName) ||
    negCat === 'transfer' || DEBT_CATEGORIES.has(negCat);
  const posLooksLikeTransfer =
    TRANSFER_RE.test(posName) || CARD_PAYMENT_RE.test(posName) ||
    posCat === 'transfer' || posCat === 'asset transfer' || posCat === 'loan proceeds';

  if (negLooksLikeTransfer && posLooksLikeTransfer) return true;

  // The one case that needs no name signal at all, because the destination
  // proves it: money arriving ON a liability account from a depository one is
  // a card or loan payment. Still subject to both vetoes above.
  if (
    negLooksLikeTransfer &&
    isLiabilityType(ctx.accountTypes.get(pos.account_id)) &&
    !hasComparablePriorDebit(pos, ctx)
  ) {
    return true;
  }

  return false;
}

export interface FlowSummary {
  usersProcessed: number;
  rowsClassified: number;
  /** inflow (amount > 0) rows that did NOT come out as income, per class */
  inflowsReclassified: Record<string, { count: number; total: number }>;
  /** outflow (amount < 0) rows that did NOT come out as expense/interest_fee, per class */
  outflowsReclassified: Record<string, { count: number; total: number }>;
  /** dollar amount removed from naive `amount > 0` income */
  incomeDelta: number;
}

function emptySummary(): FlowSummary {
  return { usersProcessed: 0, rowsClassified: 0, inflowsReclassified: {}, outflowsReclassified: {}, incomeDelta: 0 };
}

function addToSummary(summary: FlowSummary, t: TxnRow, flow: FlowType): void {
  summary.rowsClassified++;
  if (t.amount > 0 && flow !== 'income') {
    const bucket = (summary.inflowsReclassified[flow] ||= { count: 0, total: 0 });
    bucket.count++;
    bucket.total += t.amount;
    summary.incomeDelta += t.amount;
  }
  if (t.amount < 0 && flow !== 'expense' && flow !== 'interest_fee') {
    const bucket = (summary.outflowsReclassified[flow] ||= { count: 0, total: 0 });
    bucket.count++;
    bucket.total += Math.abs(t.amount);
  }
}

/**
 * Classify every transaction of `userId` whose flow_type is NULL, including
 * transfer-pair matching against the user's full history (a late-arriving leg
 * re-labels its already-classified counterpart). Idempotent: a second run with
 * no NULL rows writes nothing.
 */
export async function classifyUserFlows(sql: Sql, userId: string): Promise<FlowSummary> {
  const summary = emptySummary();

  const accounts = await sql.all(
    `SELECT id, type FROM accounts WHERE user_id = ?`, userId,
  ) as Array<{ id: string; type: string }>;
  const categories = await sql.all(
    `SELECT id, name FROM categories WHERE user_id = ?`, userId,
  ) as Array<{ id: string; name: string }>;
  const txns = await sql.all(
    `SELECT id, account_id, name, amount, date, category_id, flow_type, transfer_pair_id
     FROM transactions WHERE user_id = ?
     ORDER BY date ASC, id ASC`, userId,
  ) as TxnRow[];

  const unclassified = txns.filter((t) => t.flow_type === null || t.flow_type === undefined);
  if (unclassified.length === 0) return summary;
  summary.usersProcessed = 1;

  const ctx: ClassifyContext = {
    accountTypes: new Map(accounts.map((a) => [a.id, a.type])),
    userHasLiabilityAccount: accounts.some((a) => isLiabilityType(a.type)),
    categoryNames: new Map(categories.map((c) => [c.id, String(c.name || '').toLowerCase()])),
    merchantDebits: new Map(),
  };
  for (const t of txns) {
    if (t.amount < 0) {
      const key = norm(t.name);
      const list = ctx.merchantDebits.get(key) || [];
      list.push({ day: epochDay(t.date), abs: Math.abs(t.amount) });
      ctx.merchantDebits.set(key, list);
    }
  }

  // --- Transfer-pair matching -------------------------------------------
  // Greedy one-to-one by date proximity. A pair may involve one already-
  // classified leg (its label is corrected), but never two classified legs —
  // history that was already classified as a pair stays put.
  const paired = new Map<string, string>(); // txn id -> counterpart id
  const posByCents = new Map<number, TxnRow[]>();
  for (const t of txns) {
    if (t.amount > 0 && !t.transfer_pair_id) {
      const key = Math.round(t.amount * 100);
      const list = posByCents.get(key) || [];
      list.push(t);
      posByCents.set(key, list);
    }
  }

  const negatives = txns.filter((t) => t.amount < 0 && !t.transfer_pair_id);
  for (const neg of negatives) {
    if (paired.has(neg.id)) continue;
    const candidates = posByCents.get(Math.round(Math.abs(neg.amount) * 100));
    if (!candidates) continue;
    const negDay = epochDay(neg.date);
    let best: TxnRow | null = null;
    let bestDist = Infinity;
    for (const pos of candidates) {
      if (paired.has(pos.id)) continue;
      if (pos.account_id === neg.account_id) continue;
      const negIsNull = neg.flow_type === null || neg.flow_type === undefined;
      const posIsNull = pos.flow_type === null || pos.flow_type === undefined;
      if (!negIsNull && !posIsNull) continue; // both already classified: leave history alone
      const dist = Math.abs(epochDay(pos.date) - negDay);
      if (dist > 3 || dist >= bestDist) continue;
      if (!pairEligible(neg, pos, ctx)) continue;
      best = pos;
      bestDist = dist;
    }
    if (best) {
      paired.set(neg.id, best.id);
      paired.set(best.id, neg.id);
    }
  }

  // --- Decide flow types -------------------------------------------------
  const updates: Array<{ id: string; flow: FlowType; pairId: string | null }> = [];
  const decided = new Set<string>();
  const byId = new Map(txns.map((t) => [t.id, t]));

  for (const t of txns) {
    const isNull = t.flow_type === null || t.flow_type === undefined;
    const counterpartId = paired.get(t.id);
    if (counterpartId) {
      // Newly matched pair: label both legs (also corrects a stale counterpart).
      if (decided.has(t.id)) continue;
      const other = byId.get(counterpartId)!;
      for (const leg of [t, other]) {
        const legIsLiability = isLiabilityType(ctx.accountTypes.get(leg.account_id));
        const flow: FlowType = leg.amount > 0 && legIsLiability ? 'debt_payment' : 'transfer';
        updates.push({ id: leg.id, flow, pairId: leg.id === t.id ? counterpartId : t.id });
        if (leg.flow_type === null || leg.flow_type === undefined) addToSummary(summary, leg, flow);
        decided.add(leg.id);
      }
    } else if (isNull && !decided.has(t.id)) {
      const flow = classifyUnpaired(t, ctx);
      updates.push({ id: t.id, flow, pairId: null });
      addToSummary(summary, t, flow);
      decided.add(t.id);
    }
  }

  if (updates.length > 0) {
    await sql.tx(async (t) => {
      for (const u of updates) {
        await t.run(
          `UPDATE transactions SET flow_type = ?, transfer_pair_id = ? WHERE id = ? AND user_id = ?`,
          u.flow, u.pairId, u.id, userId,
        );
      }
    });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Schema (additive, idempotent, portable — mirrors providers/schema.ts)
// ---------------------------------------------------------------------------

async function addColumnIfMissing(sql: Sql, table: string, column: string, decl: string): Promise<void> {
  if (sql.driver === 'postgres') {
    await sql.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${decl}`);
    return;
  }
  try {
    await sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (!/duplicate column|already exists/i.test(msg)) throw err;
  }
}

export async function applyFlowSchema(sql: Sql): Promise<void> {
  await addColumnIfMissing(sql, 'transactions', 'flow_type', 'TEXT');
  await addColumnIfMissing(sql, 'transactions', 'transfer_pair_id', 'TEXT');
  await sql.exec(`CREATE INDEX IF NOT EXISTS idx_txn_user_flow_date ON transactions(user_id, flow_type, date)`);
  // Partial index keeps the "anything left to classify?" probe O(1).
  await sql.exec(`CREATE INDEX IF NOT EXISTS idx_txn_flow_null ON transactions(user_id) WHERE flow_type IS NULL`);
}

// ---------------------------------------------------------------------------
// Backfill (boot-time and lazy; idempotent)
// ---------------------------------------------------------------------------

function fmtBucket(buckets: Record<string, { count: number; total: number }>): string {
  const parts = Object.entries(buckets).map(
    ([k, v]) => `${k}: ${v.count} rows ($${(Math.round(v.total * 100) / 100).toLocaleString('en-US')})`,
  );
  return parts.length ? parts.join(', ') : 'none';
}

/**
 * Classify every row in the database whose flow_type is NULL. Safe to run at
 * every boot; a fully classified database is a no-op. Logs a reclassification
 * summary (rows moved out of naive income per class, and the dollar delta).
 */
export async function backfillFlowTypes(sql: Sql): Promise<FlowSummary> {
  await applyFlowSchema(sql);

  const users = await sql.all(
    `SELECT DISTINCT user_id FROM transactions WHERE flow_type IS NULL`,
  ) as Array<{ user_id: string }>;

  const total = emptySummary();
  for (const u of users) {
    const s = await classifyUserFlows(sql, u.user_id);
    total.usersProcessed += s.usersProcessed;
    total.rowsClassified += s.rowsClassified;
    total.incomeDelta += s.incomeDelta;
    for (const [k, v] of Object.entries(s.inflowsReclassified)) {
      const b = (total.inflowsReclassified[k] ||= { count: 0, total: 0 });
      b.count += v.count; b.total += v.total;
    }
    for (const [k, v] of Object.entries(s.outflowsReclassified)) {
      const b = (total.outflowsReclassified[k] ||= { count: 0, total: 0 });
      b.count += v.count; b.total += v.total;
    }
  }

  if (total.rowsClassified > 0) {
    console.log(`[flow] backfill: classified ${total.rowsClassified} transactions across ${total.usersProcessed} user(s)`);
    console.log(`[flow]   inflows moved out of income — ${fmtBucket(total.inflowsReclassified)}`);
    console.log(`[flow]   outflows moved out of expenses — ${fmtBucket(total.outflowsReclassified)}`);
    console.log(`[flow]   income delta vs naive amount>0: -$${(Math.round(total.incomeDelta * 100) / 100).toLocaleString('en-US')}`);
  }
  return total;
}

let schemaReady: Promise<void> | null = null;
let backfillInFlight: Promise<FlowSummary> | null = null;

/**
 * Cheap guard called at the top of every aggregate-serving request: applies the
 * schema once per process, then classifies any rows still NULL (new uploads,
 * provider syncs, seeds). When everything is classified this is a single
 * indexed LIMIT-1 probe.
 */
export async function ensureFlowClassification(userId?: string): Promise<void> {
  if (!schemaReady) {
    schemaReady = applyFlowSchema(defaultDb).catch((err) => { schemaReady = null; throw err; });
  }
  await schemaReady;

  const pending = userId
    ? await defaultDb.get(`SELECT 1 as x FROM transactions WHERE user_id = ? AND flow_type IS NULL LIMIT 1`, userId)
    : await defaultDb.get(`SELECT 1 as x FROM transactions WHERE flow_type IS NULL LIMIT 1`);
  if (!pending) return;

  if (!backfillInFlight) {
    backfillInFlight = backfillFlowTypes(defaultDb).finally(() => { backfillInFlight = null; });
  }
  await backfillInFlight;
}

// ---------------------------------------------------------------------------
// Incremental hooks (create/update/delete a transaction)
// ---------------------------------------------------------------------------

/**
 * Re-classify one transaction after it is created or edited. Clears the row's
 * (and any stale counterpart's) classification, then re-runs the user's
 * classifier so pairing stays consistent.
 */
export async function reclassifyTransactionFlow(sql: Sql, userId: string, txnId: string): Promise<void> {
  await reclassifyTransactionsFlow(sql, userId, [txnId]);
}

/** Batch variant of reclassifyTransactionFlow (e.g. bulk recategorize). */
export async function reclassifyTransactionsFlow(sql: Sql, userId: string, txnIds: string[]): Promise<void> {
  if (txnIds.length === 0) return;
  await ensureFlowClassification(userId);
  for (const txnId of txnIds) {
    const row = await sql.get(
      `SELECT transfer_pair_id FROM transactions WHERE id = ? AND user_id = ?`, txnId, userId,
    ) as { transfer_pair_id: string | null } | undefined;
    if (row === undefined) continue;
    if (row.transfer_pair_id) {
      await sql.run(
        `UPDATE transactions SET flow_type = NULL, transfer_pair_id = NULL WHERE id = ? AND user_id = ?`,
        row.transfer_pair_id, userId,
      );
    }
    await sql.run(
      `UPDATE transactions SET flow_type = NULL, transfer_pair_id = NULL WHERE id = ? AND user_id = ?`,
      txnId, userId,
    );
  }
  await classifyUserFlows(sql, userId);
}

/** After deleting a transaction, un-pair and re-classify its counterpart. */
export async function handleTransactionFlowDeleted(sql: Sql, userId: string, pairedCounterpartId: string | null): Promise<void> {
  if (!pairedCounterpartId) return;
  await sql.run(
    `UPDATE transactions SET flow_type = NULL, transfer_pair_id = NULL WHERE id = ? AND user_id = ?`,
    pairedCounterpartId, userId,
  );
  await classifyUserFlows(sql, userId);
}

// ---------------------------------------------------------------------------
// Data notes for API responses ("don't silently change history")
// ---------------------------------------------------------------------------

export interface FlowDataNotes {
  reclassified_rows: number;
  excluded_inflow_total: number;
  note: string | null;
}

/**
 * How much of this user's positive-amount history is no longer counted as
 * income. Surfaced on API responses so the UI can say "reclassified N rows".
 */
export async function getFlowDataNotes(sql: Sql, userId: string): Promise<FlowDataNotes> {
  const row = await sql.get(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
     FROM transactions
     WHERE user_id = ? AND amount > 0 AND flow_type IS NOT NULL AND flow_type != 'income'`,
    userId,
  ) as { cnt: number; total: number };
  const count = row?.cnt || 0;
  const total = Math.round((row?.total || 0) * 100) / 100;
  return {
    reclassified_rows: count,
    excluded_inflow_total: total,
    note: count > 0
      ? `Reclassified ${count} inflow transaction${count === 1 ? '' : 's'} ($${total.toLocaleString('en-US')}) as transfers, debt payments, or refunds — they are no longer counted as income.`
      : null,
  };
}
