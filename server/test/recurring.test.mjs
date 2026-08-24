/**
 * Recurring-detection tests (src/engine/recurring-detector.ts, series.ts,
 * lib/stats.ts).
 *
 * Runs against the COMPILED output (dist/), like the other test files, with a
 * throwaway SQLite database in a temp dir for the series-persistence tests.
 *
 * Covers the detection-quality fixes:
 *   - a 1st-and-15th payroll is detected as semi-monthly (mean-gap ~15.2d used
 *     to fit nothing)
 *   - one skipped month does not break monthly detection (grid fit is
 *     skip-tolerant)
 *   - two occurrences yield LOW confidence (used to reach ~0.79)
 *   - a utility bill varying ~40% month to month is still detected (the old
 *     15% variance gate rejected it)
 *   - bursty same-week purchases are NOT classified as weekly
 *   - series_occurrences is populated and price hikes become observable
 *   - robust (median+MAD) outlier detection cannot be blinded by the outlier
 *
 * Run: node --test test/recurring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-recurring-test-')), 'test.db');

const { db, initDb } = await import('../dist/db/database.js');
initDb();
const { detectRecurring, fitCadence } = await import('../dist/engine/recurring-detector.js');
const { applyFlowSchema } = await import('../dist/engine/flow.js');
const { detectAndPersistSeries, getSeriesPriceHistory, detectPriceHikes } =
  await import('../dist/engine/series.js');
const { detectRobustOutliers } = await import('../dist/lib/stats.js');
const { epochDay } = await import('../dist/lib/dates.js');

await applyFlowSchema(db);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function row(name, amount, date) {
  return {
    name, amount, date,
    category_id: null, category_name: null, category_icon: null, category_color: null,
  };
}

async function makeUser() {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, 'x', 'Recurring Tester', ?, ?)`,
    id, `${id}@test.local`, now, now,
  );
  return id;
}

async function makeAccount(userId) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO accounts (id, user_id, name, type, balance, created_at, updated_at)
     VALUES (?, ?, 'Checking', 'checking', 0, ?, ?)`,
    id, userId, now, now,
  );
  return id;
}

async function makeTxn(userId, accountId, name, amount, date, flowType) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, flow_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    id, userId, accountId, name, amount, date, flowType, now, now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Cadence fitting
// ---------------------------------------------------------------------------

test('a 1st-and-15th payroll is detected as semi-monthly with high confidence', () => {
  const dates = [];
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    dates.push(`2026-${m}-01`, `2026-${m}-15`);
  }
  const txns = dates.map((d) => row('ACME CORP PAYROLL', 2450.0, d));

  const candidates = detectRecurring(txns);
  const payroll = candidates.find((c) => c.coreName.includes('acme'));
  assert.ok(payroll, 'payroll series must be detected');
  assert.equal(payroll.frequency, 'semi-monthly');
  assert.deepEqual(payroll.domPattern, [1, 15]);
  assert.ok(payroll.confidence >= 0.8, `expected strong confidence, got ${payroll.confidence}`);
  assert.equal(payroll.occurrences, 12);
});

test('semi-monthly survives small business-day shifts around the anchor days', () => {
  // 15th falls on a weekend twice -> paid on the 16th/17th.
  const dates = ['2026-01-01', '2026-01-15', '2026-02-02', '2026-02-16',
    '2026-03-02', '2026-03-16', '2026-04-01', '2026-04-15',
    '2026-05-01', '2026-05-15'];
  const txns = dates.map((d) => row('GLOBEX SEMI MO SALARY', 1980.55, d));
  const c = detectRecurring(txns).find((x) => x.coreName.includes('globex'));
  assert.ok(c, 'shifted payroll must still be detected');
  assert.equal(c.frequency, 'semi-monthly');
});

test('one skipped month does not break monthly detection', () => {
  // April is missing entirely (paused subscription / missing statement).
  const dates = ['2026-01-06', '2026-02-06', '2026-03-06', '2026-05-06', '2026-06-06', '2026-07-06'];
  const txns = dates.map((d) => row('NETFLIX.COM 866-579-7172', -15.49, d));

  const c = detectRecurring(txns).find((x) => x.coreName.includes('netflix'));
  assert.ok(c, 'monthly series with one skipped month must be detected');
  assert.equal(c.frequency, 'monthly');
  assert.ok(c.confidence >= 0.7, `skip must not crater confidence, got ${c.confidence}`);
});

test('two occurrences never look strong', () => {
  const txns = [
    row('MYSTERY GYM MEMBERSHIP', -40.0, '2026-01-10'),
    row('MYSTERY GYM MEMBERSHIP', -40.0, '2026-02-10'),
  ];
  const c = detectRecurring(txns).find((x) => x.coreName.includes('mystery'));
  // Two points define ANY interval: acceptable only as a weak candidate.
  if (c) {
    assert.ok(c.confidence <= 0.5, `2 occurrences must stay weak, got ${c.confidence}`);
  }
  // And it must be strictly weaker than a real 6-occurrence series.
  const sixDates = ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10'];
  const strong = detectRecurring(sixDates.map((d) => row('REAL GYM MEMBERSHIP', -40.0, d)))
    .find((x) => x.coreName.includes('real'));
  assert.ok(strong && strong.confidence >= 0.85);
  if (c) assert.ok(strong.confidence - c.confidence >= 0.3, 'confidence must scale with occurrences');
});

test('a utility bill varying ~40% month to month is still detected', () => {
  const bills = [
    ['2026-01-05', -95.2], ['2026-02-05', -133.1], ['2026-03-05', -78.4],
    ['2026-04-05', -121.7], ['2026-05-05', -88.9], ['2026-06-05', -130.5],
  ];
  const txns = bills.map(([d, a]) => row('CITY POWER AND LIGHT UTIL', a, d));
  const c = detectRecurring(txns).find((x) => x.coreName.includes('power'));
  assert.ok(c, 'variable-amount utility bill must be detected (old 15% gate rejected it)');
  assert.equal(c.frequency, 'monthly');
  assert.ok(c.confidence >= 0.4);
  assert.ok(c.amountDispersion > 0.1, 'dispersion must be recorded, not rejected');
  assert.ok(Math.abs(c.amount - 108.45) < 5, `amount should be ~median, got ${c.amount}`);
});

test('bursty same-week purchases are not classified as a weekly series', () => {
  // 5 coffees inside one week, then scattered singles — a burst, not a cadence.
  const dates = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
    '2026-04-18', '2026-06-27'];
  const txns = dates.map((d) => row('CORNER ESPRESSO BAR', -4.75, d));
  const c = detectRecurring(txns).find((x) => x.coreName.includes('espresso'));
  assert.equal(c, undefined, 'bursty merchant must not be reported as recurring');
});

test('fitCadence still recognizes plain weekly and biweekly grids', () => {
  const weekly = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26', '2026-02-02', '2026-02-09'];
  const w = fitCadence(weekly.map(epochDay));
  assert.equal(w?.frequency, 'weekly');

  const biweekly = ['2026-01-02', '2026-01-16', '2026-01-30', '2026-02-13', '2026-02-27', '2026-03-13'];
  const b = fitCadence(biweekly.map(epochDay));
  assert.equal(b?.frequency, 'biweekly');
});

// ---------------------------------------------------------------------------
// Robust outliers (exported for analysis.ts to adopt)
// ---------------------------------------------------------------------------

test('median+MAD outlier detection is not blinded by the outlier itself', () => {
  // One $5,000 charge among ~$50 charges. mean = ~500 -> 3×mean = ~1500 would
  // still catch this one, but a second $1,400 anomaly would hide (1400 < 1500).
  const amounts = [42, 55, 48, 61, 39, 52, 47, 58, 44, 1400, 5000];
  const flagged = detectRobustOutliers(amounts, 3.5).map((o) => o.value);
  assert.ok(flagged.includes(5000));
  assert.ok(flagged.includes(1400), 'moderate anomaly must not hide behind the big one');
  assert.ok(!flagged.includes(61), 'normal spend must not be flagged');

  // Degenerate case: fixed-price merchant (MAD = 0) uses the absolute-dollar rule.
  const fixed = [15.49, 15.49, 15.49, 15.49, 120];
  const flaggedFixed = detectRobustOutliers(fixed).map((o) => o.value);
  assert.deepEqual(flaggedFixed, [120]);
});

// ---------------------------------------------------------------------------
// Series persistence + observable price history (fixes write-only price_history)
// ---------------------------------------------------------------------------

test('detectAndPersistSeries records occurrences and makes a price hike observable', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId);

  // Comcast: four months at $79.99, then two months at $89.99 — a sustained hike.
  const months = ['2026-01-12', '2026-02-12', '2026-03-12', '2026-04-12', '2026-05-12', '2026-06-12'];
  const amounts = [-79.99, -79.99, -79.99, -79.99, -89.99, -89.99];
  for (let i = 0; i < months.length; i++) {
    await makeTxn(userId, acct, 'COMCAST CABLE COMM', amounts[i], months[i], 'expense');
  }
  // A payroll inflow, classified by flow_type (the authority), forms its own series.
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    await makeTxn(userId, acct, 'INITECH PAYROLL DIR DEP', 3100.0, `2026-${m}-01`, 'income');
    await makeTxn(userId, acct, 'INITECH PAYROLL DIR DEP', 3100.0, `2026-${m}-15`, 'income');
  }
  // A transfer must NOT become a series even though it is perfectly regular.
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    await makeTxn(userId, acct, 'ONLINE TRANSFER TO SAVINGS', -500.0, `2026-${m}-02`, 'transfer');
  }

  const result = await detectAndPersistSeries(db, userId);
  assert.ok(result.seriesUpserted >= 2, 'comcast + payroll series expected');

  const comcast = result.series.find((s) => s.core_name.includes('comcast'));
  assert.ok(comcast, 'comcast series persisted');
  assert.equal(comcast.direction, 'outflow');

  const payroll = result.series.find((s) => s.core_name.includes('initech'));
  assert.ok(payroll, 'payroll series persisted');
  assert.equal(payroll.direction, 'inflow');
  assert.equal(payroll.cadence, 'semi-monthly');

  const transferSeries = result.series.find((s) => s.core_name.includes('savings'));
  assert.equal(transferSeries, undefined, 'transfers must not form series');

  // Occurrences are the derived price history — not a write-only blob.
  const histories = await getSeriesPriceHistory(db, userId, comcast.id);
  assert.equal(histories.length, 1);
  assert.equal(histories[0].points.length, 6);
  assert.equal(histories[0].points[0].amount, 79.99);
  assert.equal(histories[0].points[5].amount, 89.99);

  const hikes = await detectPriceHikes(db, userId);
  const hike = hikes.find((h) => h.seriesId === comcast.id);
  assert.ok(hike, 'sustained price hike must be observable');
  assert.equal(hike.oldAmount, 79.99);
  assert.equal(hike.newAmount, 89.99);
  assert.ok(Math.abs(hike.annualDelta - 120) < 1, `annualized delta ~$120, got ${hike.annualDelta}`);

  // Idempotent: re-running records nothing new and keeps one row per series.
  const again = await detectAndPersistSeries(db, userId);
  assert.equal(again.occurrencesRecorded, 0, 're-run must not duplicate occurrences');
  const count = await db.get(
    `SELECT COUNT(*) AS n FROM recurring_series WHERE user_id = ? AND core_name = ?`,
    userId, comcast.core_name,
  );
  assert.equal(count.n, 1);
});
