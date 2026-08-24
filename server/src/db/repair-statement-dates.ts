/**
 * Repair migration: statement-import date & sign corruption.
 *
 * Background. The BofA credit-card statement parser stamped every MM/DD line
 * with the statement period's END year (engine/statementParser.ts, since
 * fixed), so on a December→January statement the December lines landed one
 * year in the future (e.g. a 2025-12-17 purchase stored as 2026-12-17). The
 * same parser also stored purchases as positive amounts and payments as
 * negative — inverted relative to the app-wide convention (negative =
 * outflow).
 *
 * What this script does:
 *   1. Finds transactions dated implausibly far AFTER their own import date
 *      (`date` > `created_at` + FUTURE_GRACE_DAYS). For each, re-derives the
 *      year by shifting back exactly one year, and accepts the correction
 *      only when the corrected date is on/before the import date and within
 *      MAX_BACKSHIFT_DAYS (~13 months) of it. Where the originating upload
 *      still has pending_items/uploaded_files rows, the source filename is
 *      logged for auditability. (The statement period itself was never
 *      persisted, so the import timestamp is the closest durable anchor;
 *      rows that cannot be corrected safely are logged and left untouched.)
 *   2. Corrects inverted signs on credit/loan accounts: an account whose
 *      non-payment, non-refund rows are majority-positive was imported with
 *      the inverted convention; purchases are flipped negative and
 *      payment-like rows flipped positive. Rows identified in step 1 on a
 *      credit/loan account are also flipped individually (they provably came
 *      from the buggy parser) even if the account as a whole is not inverted.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Set REPAIR_DRY_RUN=false to apply.
 *   - Idempotent: corrected dates no longer exceed the import date, and
 *     corrected accounts no longer test as inverted, so a second run is a
 *     no-op.
 *   - Every change (and every skip) is logged.
 *   - Account balances are NOT auto-adjusted; the per-account net amount
 *     delta is logged so balances can be reconciled deliberately.
 *
 * Run deliberately (never wired into boot):
 *   cd server && npx tsx src/db/repair-statement-dates.ts                # dry run
 *   REPAIR_DRY_RUN=false npx tsx src/db/repair-statement-dates.ts       # apply
 *   DATABASE_PATH=/path/to/finflow.db npx tsx src/db/repair-statement-dates.ts
 *   DB_DRIVER=postgres DATABASE_URL=... npx tsx src/db/repair-statement-dates.ts
 */

import { db, getDriver, usePostgres } from './database.js';

const DRY_RUN = process.env.REPAIR_DRY_RUN !== 'false';

/** Days a transaction may legitimately post-date its own import (clock skew,
 *  pending items entered ahead, tiny seed offsets). Anything further out is
 *  treated as year-inference corruption. */
const FUTURE_GRACE_DAYS = 45;

/** A corrected date must land within ~13 months before its import date. */
const MAX_BACKSHIFT_DAYS = 400;

const LIABILITY_TYPES = new Set(['credit', 'loan', 'mortgage']);

const PAYMENT_RE = /(payment|pymt|autopay|thank you|online banking payment|statement credit|epay)/i;
const REFUND_RE = /(refund|return|reversal|rebate|cash ?back|redemption)/i;

interface TxRow {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  amount: number;
  date: string;
  created_at: string;
  account_type: string;
  account_name: string;
}

interface PlannedChange {
  row: TxRow;
  newDate?: string;
  newAmount?: number;
  reasons: string[];
}

function isIsoDate(s: string | undefined | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}/.test(s);
}

function epochDay(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Shift a YYYY-MM-DD date back one year (Feb 29 → Feb 28). */
function minusOneYear(iso: string): string {
  const y = Number(iso.slice(0, 4)) - 1;
  let md = iso.slice(5, 10);
  if (md === '02-29') md = '02-28';
  return `${y}-${md}`;
}

async function findOriginatingFile(row: TxRow, oldDate: string): Promise<string | null> {
  try {
    const hit = await db.get<{ filename: string }>(
      `SELECT uf.filename AS filename
       FROM pending_items pi
       JOIN uploaded_files uf ON uf.id = pi.file_id
       WHERE pi.user_id = ? AND pi.parsed_name = ? AND pi.parsed_date = ? AND pi.parsed_amount = ?
       LIMIT 1`,
      row.user_id, row.name, oldDate, row.amount
    );
    return hit?.filename ?? null;
  } catch {
    // Older databases may not have the upload tables at all.
    return null;
  }
}

async function main(): Promise<void> {
  if (getDriver() === 'postgres') {
    await usePostgres();
  }

  console.log(`repair-statement-dates: driver=${getDriver()} mode=${DRY_RUN ? 'DRY-RUN (no writes; set REPAIR_DRY_RUN=false to apply)' : 'APPLY'}`);

  const rows = await db.all<TxRow>(
    `SELECT t.id, t.user_id, t.account_id, t.name, t.amount, t.date, t.created_at,
            a.type AS account_type, a.name AS account_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id`
  );
  console.log(`scanned ${rows.length} transactions`);

  const changes = new Map<string, PlannedChange>();
  const planned = (row: TxRow): PlannedChange => {
    let c = changes.get(row.id);
    if (!c) {
      c = { row, reasons: [] };
      changes.set(row.id, c);
    }
    return c;
  };

  // ── Pass 1: future-dated rows (year-inference corruption) ────────────────
  const dateFixedIds = new Set<string>();
  let dateSkips = 0;

  for (const row of rows) {
    if (!isIsoDate(row.date) || !isIsoDate(row.created_at)) continue;
    const importDay = String(row.created_at).slice(0, 10);
    const futureDays = epochDay(row.date) - epochDay(importDay);
    if (futureDays <= FUTURE_GRACE_DAYS) continue;

    const candidate = minusOneYear(row.date);
    const backshift = epochDay(importDay) - epochDay(candidate);
    if (candidate <= importDay && backshift <= MAX_BACKSHIFT_DAYS) {
      const file = await findOriginatingFile(row, row.date);
      const c = planned(row);
      c.newDate = candidate;
      c.reasons.push(
        `date ${row.date} is ${futureDays}d after import ${importDay} → ${candidate}` +
        (file ? ` (from upload "${file}")` : ' (no upload link found; year re-derived from import date)')
      );
      dateFixedIds.add(row.id);
    } else {
      dateSkips++;
      console.log(
        `  SKIP tx ${row.id} [${row.account_name}] "${row.name}" ${row.date}: ` +
        `${futureDays}d in the future but shifting one year back gives ${candidate}, ` +
        `outside the safe window relative to import ${importDay} — needs the original statement to resolve`
      );
    }
  }

  // ── Pass 2: sign convention on credit/loan accounts ──────────────────────
  const byAccount = new Map<string, TxRow[]>();
  for (const row of rows) {
    if (!LIABILITY_TYPES.has(String(row.account_type))) continue;
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  for (const [, accountRows] of byAccount) {
    const purchases = accountRows.filter((r) => !PAYMENT_RE.test(r.name) && !REFUND_RE.test(r.name));
    const pos = purchases.filter((r) => r.amount > 0).length;
    const neg = purchases.filter((r) => r.amount < 0).length;
    // Majority-positive purchases on a liability account = inverted import.
    const accountInverted = purchases.length >= 5 && pos > neg;

    for (const row of accountRows) {
      const isPaymentLike = PAYMENT_RE.test(row.name);
      const isRefundLike = REFUND_RE.test(row.name);
      const provenBadRow = dateFixedIds.has(row.id); // came from the buggy parser
      if (!accountInverted && !provenBadRow) continue;

      if (!isPaymentLike && !isRefundLike && row.amount > 0) {
        const c = planned(row);
        c.newAmount = -row.amount;
        c.reasons.push(
          `credit/loan purchase stored positive (${row.amount.toFixed(2)}) → ${(-row.amount).toFixed(2)}` +
          (accountInverted ? ' [account uses inverted sign convention]' : ' [row from buggy statement import]')
        );
      } else if (accountInverted && isPaymentLike && row.amount < 0) {
        const c = planned(row);
        c.newAmount = -row.amount;
        c.reasons.push(
          `credit/loan payment stored negative (${row.amount.toFixed(2)}) → ${(-row.amount).toFixed(2)} [account uses inverted sign convention]`
        );
      }
    }
  }

  // ── Report & apply ───────────────────────────────────────────────────────
  const all = [...changes.values()];
  const dateChanges = all.filter((c) => c.newDate !== undefined).length;
  const signChanges = all.filter((c) => c.newAmount !== undefined).length;

  for (const c of all) {
    console.log(
      `  ${DRY_RUN ? '[dry-run] would fix' : 'FIX'} tx ${c.row.id} [${c.row.account_name}] "${c.row.name}": ${c.reasons.join('; ')}`
    );
  }

  // Net amount delta per account (balances are NOT auto-adjusted).
  const deltaByAccount = new Map<string, number>();
  for (const c of all) {
    if (c.newAmount === undefined) continue;
    const d = (deltaByAccount.get(c.row.account_name) ?? 0) + (c.newAmount - c.row.amount);
    deltaByAccount.set(c.row.account_name, d);
  }
  for (const [name, delta] of deltaByAccount) {
    console.log(`  NOTE account "${name}": net transaction amount delta ${delta.toFixed(2)} — stored balance not auto-adjusted, reconcile deliberately`);
  }

  if (!DRY_RUN && all.length > 0) {
    const now = new Date().toISOString();
    await db.tx(async (t) => {
      for (const c of all) {
        await t.run(
          `UPDATE transactions SET date = ?, amount = ?, updated_at = ? WHERE id = ?`,
          c.newDate ?? c.row.date,
          c.newAmount ?? c.row.amount,
          now,
          c.row.id
        );
      }
    });
  }

  console.log(
    `repair-statement-dates ${DRY_RUN ? 'dry-run' : 'apply'} complete: ` +
    `${dateChanges} date fix(es), ${signChanges} sign fix(es), ${dateSkips} unresolvable future-dated row(s), ` +
    `${all.length} row(s) ${DRY_RUN ? 'would be' : ''} updated`
  );

  await db.close();
}

main().catch((err) => {
  console.error('repair-statement-dates failed:', err);
  process.exit(1);
});
