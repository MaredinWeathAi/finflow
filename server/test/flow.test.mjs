/**
 * Flow-classification tests (src/engine/flow.ts).
 *
 * Runs against the COMPILED output (dist/), like the other test files, with a
 * throwaway SQLite database in a temp dir.
 *
 * Covers the classification rules that fix the production income bug:
 *   - a card payment from checking + the matching positive row on the card
 *     nets to ZERO income and exactly one transfer leg
 *   - a real paycheck is income
 *   - a refund is not income (name-based and merchant-history-based)
 *   - interest charged on a card is an expense (interest_fee)
 *   - an internal savings transfer is neither income nor expense on either side
 *   - backfill is idempotent
 *
 * Run: node --test test/flow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set BEFORE the app modules load: database.js opens its SQLite
// file at import time.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-flow-test-')), 'test.db');

const { db, initDb } = await import('../dist/db/database.js');
initDb();
const {
  applyFlowSchema,
  backfillFlowTypes,
  classifyUserFlows,
  reclassifyTransactionFlow,
  getFlowDataNotes,
  liabilityOwed,
} = await import('../dist/engine/flow.js');

await applyFlowSchema(db);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

async function makeUser() {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, 'x', 'Flow Tester', ?, ?)`,
    id, `${id}@test.local`, now, now,
  );
  return id;
}

async function makeAccount(userId, name, type) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO accounts (id, user_id, name, type, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    id, userId, name, type,
  now, now);
  return id;
}

async function makeTxn(userId, accountId, name, amount, date, categoryId = null) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, accountId, name, amount, categoryId, date, now, now,
  );
  return id;
}

async function flowOf(txnId) {
  const row = await db.get(`SELECT flow_type, transfer_pair_id FROM transactions WHERE id = ?`, txnId);
  return row;
}

async function incomeOf(userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND flow_type = 'income'`,
    userId,
  );
  return Math.round(row.total * 100) / 100;
}

async function expensesOf(userId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
     WHERE user_id = ? AND flow_type IN ('expense', 'interest_fee')`,
    userId,
  );
  return Math.round(row.total * 100) / 100;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('card payment from checking + matching positive on the card → zero income, one transfer, one debt_payment', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const card = await makeAccount(userId, 'Amex Gold', 'credit');

  const outLeg = await makeTxn(userId, checking, 'AMERICAN EXPRESS ACH PMT', -850.25, '2026-08-03');
  const inLeg = await makeTxn(userId, card, 'PAYMENT THANK YOU', 850.25, '2026-08-04');
  // The purchases the payment settles are on the card and stay expenses:
  const groceries = await makeTxn(userId, card, 'Whole Foods', -850.25, '2026-07-15');

  await classifyUserFlows(db, userId);

  const out = await flowOf(outLeg);
  const inn = await flowOf(inLeg);
  assert.equal(out.flow_type, 'transfer', 'funding leg from checking is a transfer, not an expense');
  assert.equal(inn.flow_type, 'debt_payment', 'positive amount on the card is a debt_payment, never income');
  assert.equal(out.transfer_pair_id, inLeg, 'legs are paired');
  assert.equal(inn.transfer_pair_id, outLeg, 'legs are paired both ways');

  // The July purchase (same amount but on the SAME account as the payment's
  // card leg and eligible only cross-account) stays an expense.
  assert.equal((await flowOf(groceries)).flow_type, 'expense');

  assert.equal(await incomeOf(userId), 0, 'the card payment nets to zero income');
  assert.equal(await expensesOf(userId), 850.25, 'only the card purchases count as expenses — no double counting');
});

test('a real paycheck is income', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const pay = await makeTxn(userId, checking, 'Payroll - TechCorp Inc', 4200.5, '2026-08-01');
  // "Rent Payment" contains "payment" but is NOT a card payment
  const rent = await makeTxn(userId, checking, 'Rent Payment', -1800, '2026-08-02');

  await classifyUserFlows(db, userId);

  assert.equal((await flowOf(pay)).flow_type, 'income');
  assert.equal((await flowOf(rent)).flow_type, 'expense');
  assert.equal(await incomeOf(userId), 4200.5);
  assert.equal(await expensesOf(userId), 1800);
});

test('a refund is not income (name match and merchant history)', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const card = await makeAccount(userId, 'Visa', 'credit');

  const byName = await makeTxn(userId, checking, 'AMAZON MKTPL REFUND', 64.99, '2026-08-05');
  // history-based: bought at Target on the card, partial credit two weeks later
  await makeTxn(userId, card, 'TARGET 00123', -120.4, '2026-07-20');
  const byHistory = await makeTxn(userId, card, 'TARGET 00123', 45.1, '2026-08-02');

  await classifyUserFlows(db, userId);

  assert.equal((await flowOf(byName)).flow_type, 'refund');
  assert.equal((await flowOf(byHistory)).flow_type, 'refund', 'positive at a merchant with prior debits is a refund, not income (and not a debt_payment)');
  assert.equal(await incomeOf(userId), 0, 'refunds never count as income');
});

test('interest charged on a card is an expense (interest_fee)', async () => {
  const userId = await makeUser();
  const card = await makeAccount(userId, 'Visa', 'credit');
  const interest = await makeTxn(userId, card, 'INTEREST CHARGE ON PURCHASES', -43.21, '2026-08-10');

  await classifyUserFlows(db, userId);

  assert.equal((await flowOf(interest)).flow_type, 'interest_fee');
  assert.equal(await expensesOf(userId), 43.21, 'interest_fee counts toward expenses');
  assert.equal(await incomeOf(userId), 0);
});

test('an internal savings transfer is neither income nor expense on either side', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const savings = await makeAccount(userId, 'Savings', 'savings');

  const outLeg = await makeTxn(userId, checking, 'Online Banking Transfer to Savings', -2000, '2026-08-06');
  const inLeg = await makeTxn(userId, savings, 'Online Banking Transfer from Checking', 2000, '2026-08-06');

  await classifyUserFlows(db, userId);

  const out = await flowOf(outLeg);
  const inn = await flowOf(inLeg);
  assert.equal(out.flow_type, 'transfer');
  assert.equal(inn.flow_type, 'transfer');
  assert.equal(out.transfer_pair_id, inLeg);
  assert.equal(inn.transfer_pair_id, outLeg);
  assert.equal(await incomeOf(userId), 0);
  assert.equal(await expensesOf(userId), 0);
});

test('interest EARNED on savings stays income', async () => {
  const userId = await makeUser();
  const savings = await makeAccount(userId, 'Savings', 'savings');
  const earned = await makeTxn(userId, savings, 'Interest Earned', 12.34, '2026-08-01');
  await classifyUserFlows(db, userId);
  assert.equal((await flowOf(earned)).flow_type, 'income');
});

test('backfill is idempotent and reports the reclassification summary', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const card = await makeAccount(userId, 'Card', 'credit');
  await makeTxn(userId, checking, 'Payroll - Acme', 3000, '2026-08-01');
  await makeTxn(userId, checking, 'CHASE CREDIT CRD AUTOPAY', -500, '2026-08-02');
  await makeTxn(userId, card, 'Payment Thank You - Web', 500, '2026-08-02');

  const first = await backfillFlowTypes(db);
  assert.ok(first.rowsClassified >= 3);
  assert.ok(first.inflowsReclassified.debt_payment, 'summary reports inflows moved out of income');
  assert.ok(first.incomeDelta >= 500);

  const second = await backfillFlowTypes(db);
  assert.equal(second.rowsClassified, 0, 'second run classifies nothing (idempotent)');

  const notes = await getFlowDataNotes(db, userId);
  assert.equal(notes.reclassified_rows, 1);
  assert.equal(notes.excluded_inflow_total, 500);
  assert.ok(notes.note && notes.note.includes('1 inflow transaction'));
});

test('liability debt math is type-aware, not sign-blind (audit D7)', () => {
  assert.equal(liabilityOwed('credit', -2340.56), 2340.56, 'negative-stored card balance is owed');
  assert.equal(liabilityOwed('credit', 150), 0, 'overpaid card (credit balance) owes nothing — never abs()');
  assert.equal(liabilityOwed('loan', 12000), 12000, 'positive-stored loan balance is debt, not an asset');
  assert.equal(liabilityOwed('mortgage', -250000), 250000);
  assert.equal(liabilityOwed('checking', -50), 0, 'an overdrawn checking account is not a liability account');
});

test('editing a leg re-classifies both sides', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking', 'checking');
  const savings = await makeAccount(userId, 'Savings', 'savings');
  const outLeg = await makeTxn(userId, checking, 'Transfer to Savings', -300, '2026-08-07');
  const inLeg = await makeTxn(userId, savings, 'Transfer from Checking', 300, '2026-08-07');
  await classifyUserFlows(db, userId);
  assert.equal((await flowOf(outLeg)).transfer_pair_id, inLeg);

  // Change the outflow into an ordinary purchase — pair must dissolve
  await db.run(`UPDATE transactions SET name = 'Hardware Store', amount = -310 WHERE id = ?`, outLeg);
  await reclassifyTransactionFlow(db, userId, outLeg);

  const out = await flowOf(outLeg);
  const inn = await flowOf(inLeg);
  assert.equal(out.flow_type, 'expense');
  assert.equal(out.transfer_pair_id, null);
  assert.equal(inn.flow_type, 'transfer', 'orphaned transfer-named inflow stays a transfer (unmatched), not income');
  assert.equal(inn.transfer_pair_id, null);
});
