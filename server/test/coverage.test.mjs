/**
 * Coverage tests (src/engine/coverage.ts) — the partial-month bug family.
 *
 * Runs against the COMPILED output (dist/), like the other test files, with a
 * throwaway SQLite database in a temp dir.
 *
 * Covers:
 *   - a partial current month is never complete and never enters an average
 *   - a month with genuinely zero activity INSIDE the covered range counts
 *     (it is complete, and /cashflow reports it as a real $0 row)
 *   - a month OUTSIDE the covered range is absent, not zero
 *   - a single-month history is not halved by the old ceil(span/30.44)
 *     denominator (audit D6)
 *   - /api/reports/cashflow?period=ytd returns year-to-date complete months
 *     (the old regex silently fell back to 6 months)
 *
 * Run: node --test test/coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set BEFORE the app modules load: database.js opens its SQLite
// file at import time.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-coverage-test-')), 'test.db');

const { db, initDb } = await import('../dist/db/database.js');
initDb();
const { applyFlowSchema } = await import('../dist/engine/flow.js');
const {
  applyCoverageSchema,
  getCoverage,
  monthStatus,
  isMonthComplete,
  completeMonths,
  monthsWithData,
  currentYm,
  prevYm,
  monthStartIso,
  monthEndIso,
} = await import('../dist/engine/coverage.js');
const { generateFinancialAnalysis } = await import('../dist/engine/analysis.js');

await applyFlowSchema(db);
await applyCoverageSchema(db);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

/** 'YYYY-MM' shifted n months back from the current month. */
function ymBack(n) {
  let ym = currentYm();
  for (let i = 0; i < n; i++) ym = prevYm(ym);
  return ym;
}

async function makeUser() {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, 'x', 'Coverage Tester', ?, ?)`,
    id, `${id}@test.local`, now, now,
  );
  return id;
}

async function makeAccount(userId, name, type = 'checking') {
  const id = randomUUID();
  await db.run(
    `INSERT INTO accounts (id, user_id, name, type, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    id, userId, name, type, now, now,
  );
  return id;
}

async function makeTxn(userId, accountId, name, amount, date) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO transactions (id, user_id, account_id, name, amount, date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, accountId, name, amount, date, now, now,
  );
  return id;
}

/** Bracket a month with a paycheck on day 1 and a purchase on the last day. */
async function fillMonth(userId, accountId, ym, income = 5000, expense = 1200) {
  await makeTxn(userId, accountId, 'Employer Payroll', income, monthStartIso(ym));
  await makeTxn(userId, accountId, 'Grocery Store', -expense, monthEndIso(ym));
}

// Minimal express app so the real /cashflow route (including ytd) is exercised.
async function makeApp(userId) {
  const { default: express } = await import('express');
  const { default: reportsRouter } = await import('../dist/routes/reports.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, email: 't@t', role: 'client' }; next(); });
  app.use('/api/reports', reportsRouter);
  return app;
}

async function getJson(app, path) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return await res.json();
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('partial current month is never complete and stays out of completeMonths', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId, 'Checking');

  await fillMonth(userId, acct, ymBack(2));
  await fillMonth(userId, acct, ymBack(1));
  // Current month: data up to "today" only — partial by definition.
  await makeTxn(userId, acct, 'Employer Payroll', 5000, monthStartIso(currentYm()));

  assert.equal(await isMonthComplete(userId, currentYm()), false);
  assert.equal(await isMonthComplete(userId, ymBack(1)), true);

  const months = await completeMonths(userId, 6);
  assert.ok(!months.includes(currentYm()), 'current partial month must not be listed as complete');
  assert.deepEqual(months, [ymBack(1), ymBack(2)]);
});

test('a genuinely zero month inside the covered range is complete and counts as $0', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId, 'Checking');

  // Months -4, -2, -1 have activity; month -3 has NONE but sits inside the
  // covered range — it is a real zero, not a gap.
  await fillMonth(userId, acct, ymBack(4));
  await fillMonth(userId, acct, ymBack(2));
  await fillMonth(userId, acct, ymBack(1));

  assert.equal(await isMonthComplete(userId, ymBack(3)), true);
  const months = await completeMonths(userId, 6);
  assert.ok(months.includes(ymBack(3)), 'zero-activity month inside coverage must count');

  // And the cashflow route reports it as a real $0 row, so a 4-month average
  // over these rows is total/4, not total/3.
  const app = await makeApp(userId);
  const rows = await getJson(app, '/api/reports/cashflow?period=6m');
  const zeroRow = rows.find((r) => r.month === ymBack(3));
  assert.ok(zeroRow, 'zero month must appear in cashflow');
  assert.equal(zeroRow.income, 0);
  assert.equal(zeroRow.expenses, 0);
  assert.equal(rows.length, 4);
});

test('a month outside the covered range is absent — not zero, and never counted', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId, 'Checking');

  await fillMonth(userId, acct, ymBack(2));
  await fillMonth(userId, acct, ymBack(1));

  // Before coverage begins: absent.
  assert.equal(await isMonthComplete(userId, ymBack(4)), false);
  const cov = await getCoverage(userId);
  assert.equal(monthStatus(cov, ymBack(4)), 'absent');

  const listed = await monthsWithData(userId, ymBack(6), ymBack(1));
  const listedMonths = listed.map((m) => m.month);
  assert.ok(!listedMonths.includes(ymBack(4)), 'absent month must not be listed');
  assert.ok(!listedMonths.includes(ymBack(5)), 'absent month must not be listed');
  assert.ok(listedMonths.includes(ymBack(1)));

  const months = await completeMonths(userId, 6);
  assert.deepEqual(months, [ymBack(1), ymBack(2)], 'only covered months count');
});

test('single-month history: the average is the month total, not halved (audit D6)', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId, 'Checking');

  // One complete month plus the first days of the current month: a >31-day
  // span that the old ceil(span/30.44) denominator turned into "2 months",
  // halving every avgMonthly figure.
  const prev = ymBack(1);
  await makeTxn(userId, acct, 'Employer Payroll', 4000, monthStartIso(prev));
  await makeTxn(userId, acct, 'Employer Payroll', 4000, `${prev}-15`);
  await makeTxn(userId, acct, 'Grocery Store', -900, monthEndIso(prev));
  await makeTxn(userId, acct, 'Coffee Shop', -25, monthStartIso(currentYm()));

  const analysis = await generateFinancialAnalysis(userId);
  assert.equal(Math.round(analysis.avgMonthlyIncome), 8000, 'income average must be the complete month total');
  assert.equal(Math.round(analysis.avgMonthlyExpenses), 900, 'expense average excludes the partial current month');
});

test('cashflow?period=ytd returns year-to-date complete months, not a silent 6m default', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId, 'Checking');

  // 14 complete months of history spanning the year boundary + partial current.
  for (let n = 14; n >= 1; n--) await fillMonth(userId, acct, ymBack(n));
  await makeTxn(userId, acct, 'Employer Payroll', 5000, monthStartIso(currentYm()));

  const app = await makeApp(userId);
  const rows = await getJson(app, '/api/reports/cashflow?period=ytd');

  const year = currentYm().slice(0, 4);
  const currentMonthNumber = Number(currentYm().slice(5, 7));
  assert.equal(rows.length, currentMonthNumber - 1, 'ytd = every complete month of the current year');
  for (const row of rows) {
    assert.ok(row.month.startsWith(`${year}-`), `ytd must only contain ${year} months, got ${row.month}`);
    assert.notEqual(row.month, currentYm(), 'ytd must exclude the partial current month');
  }
  // Still honours Nm periods.
  const sixMonthRows = await getJson(app, '/api/reports/cashflow?period=3m');
  assert.equal(sixMonthRows.length, 3);
});

test('a trailing month whose data stops mid-month is partial, not averaged in', async () => {
  const userId = await makeUser();
  const checking = await makeAccount(userId, 'Checking');
  const card = await makeAccount(userId, 'Card', 'credit');

  // Both accounts cover months -3 and -2 fully; in month -1 the card is
  // complete but checking stops on the 12th — month -1 is partial.
  for (const ym of [ymBack(3), ymBack(2)]) {
    await fillMonth(userId, checking, ym);
    await makeTxn(userId, card, 'Restaurant', -80, monthStartIso(ym));
    await makeTxn(userId, card, 'Restaurant', -80, monthEndIso(ym));
  }
  await makeTxn(userId, checking, 'Employer Payroll', 5000, monthStartIso(ymBack(1)));
  await makeTxn(userId, checking, 'Grocery Store', -300, `${ymBack(1)}-12`);
  await makeTxn(userId, card, 'Restaurant', -80, monthStartIso(ymBack(1)));
  await makeTxn(userId, card, 'Restaurant', -80, monthEndIso(ymBack(1)));

  assert.equal(await isMonthComplete(userId, ymBack(1)), false);
  assert.equal(await isMonthComplete(userId, ymBack(2)), true);
  const months = await completeMonths(userId, 6);
  assert.deepEqual(months, [ymBack(2), ymBack(3)]);
});
