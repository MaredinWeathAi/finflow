/**
 * Duplicate-detection tests (src/engine/duplicates.ts, lib/dates.ts).
 *
 * Runs against the COMPILED output (dist/), with a throwaway SQLite database.
 * The process timezone is pinned WEST of UTC so the old
 * `new Date('YYYY-MM-DD')` + local-time `setDate` bug class would actually
 * manifest — the date helpers must be immune.
 *
 * Covers:
 *   - a habitual twice-weekly coffee is NOT flagged as a duplicate
 *   - a genuine same-day double charge IS flagged (even at a habitual merchant)
 *   - an overlapping-statement duplicate with 1-day posting lag is still caught
 *   - date-only math never shifts a day near midnight (timezone off-by-one)
 *
 * Run: node --test test/duplicates.test.mjs
 */
process.env.TZ = 'America/Los_Angeles';   // before anything touches Date

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-dup-test-')), 'test.db');

const { db, initDb } = await import('../dist/db/database.js');
initDb();
const { findDuplicates, findCrossFileOverlaps, scorePair, daysBetween, isHabitualCadence } =
  await import('../dist/engine/duplicates.js');
const { epochDay, fromEpochDay, addDays, daysApart } = await import('../dist/lib/dates.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

async function makeUser() {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, 'x', 'Dup Tester', ?, ?)`,
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

async function makeTxn(userId, accountId, name, amount, date) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    id, userId, accountId, name, amount, date, now, now,
  );
  return id;
}

function item(name, amount, date, fileId = 'file-A') {
  return {
    id: randomUUID(),
    parsed_name: name,
    parsed_amount: amount,
    parsed_date: date,
    file_id: fileId,
  };
}

// ---------------------------------------------------------------------------
// Habitual purchases vs genuine duplicates
// ---------------------------------------------------------------------------

test('a habitual twice-weekly coffee is NOT flagged as a duplicate', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId);

  // Established routine: same $6.50 latte roughly twice a week for six weeks.
  const visits = ['2026-05-04', '2026-05-07', '2026-05-11', '2026-05-14',
    '2026-05-18', '2026-05-21', '2026-05-26', '2026-05-28',
    '2026-06-01', '2026-06-04', '2026-06-08'];
  for (const d of visits) {
    await makeTxn(userId, acct, 'BLUE BOTTLE COFFEE #71', -6.5, d);
  }

  // A new statement upload contains the NEXT routine visit, 3 days after the
  // last one — identical amount, identical merchant. The old scorer gave this
  // 40 (amount) + 35 (name) + 15 (3-day gap) = 90 and flagged it.
  const matches = await findDuplicates([item('BLUE BOTTLE COFFEE #71', -6.5, '2026-06-11')], userId);
  assert.deepEqual(matches, [], 'routine repeat purchase must not be flagged as duplicate');
});

test('a genuine same-day double charge IS flagged, even at a habitual merchant', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId);

  const visits = ['2026-05-04', '2026-05-07', '2026-05-11', '2026-05-14',
    '2026-05-18', '2026-05-21', '2026-05-26'];
  for (const d of visits) {
    await makeTxn(userId, acct, 'BLUE BOTTLE COFFEE #71', -6.5, d);
  }

  // The card network double-posts the May 26 charge: same day, same amount.
  const matches = await findDuplicates([item('BLUE BOTTLE COFFEE #71', -6.5, '2026-05-26')], userId);
  assert.equal(matches.length, 1, 'same-day identical charge must be flagged');
  assert.ok(matches[0].score >= 70);
  assert.ok(matches[0].reasons.includes('Same date'));
});

test('an overlapping-statement duplicate with 1-day posting lag is still caught', async () => {
  const userId = await makeUser();
  const acct = await makeAccount(userId);

  // One-off purchase, no habitual cadence.
  await makeTxn(userId, acct, 'WHOLE FOODS MARKET #123', -84.31, '2026-07-10');

  const matches = await findDuplicates([item('WHOLE FOODS MKT #123', -84.31, '2026-07-11')], userId);
  assert.equal(matches.length, 1, 'posting-lag duplicate from overlapping statements must be caught');
  assert.ok(matches[0].score >= 70);
});

test('same-day is weighted far above same-week in the pair score', () => {
  const a = { name: 'ACME PARKING', amount: -6.5, date: '2026-04-06' };
  const sameDay = scorePair(a, { name: 'ACME PARKING', amount: -6.5, date: '2026-04-06' });
  const threeDays = scorePair(a, { name: 'ACME PARKING', amount: -6.5, date: '2026-04-09' });
  assert.ok(sameDay.score - threeDays.score >= 15,
    `same-day (${sameDay.score}) must far outscore 3-day gap (${threeDays.score})`);

  // With the habitual exemption, a different-day match drops below threshold...
  const habitual = scorePair(a, { name: 'ACME PARKING', amount: -6.5, date: '2026-04-09' },
    { habitualMerchant: true });
  assert.ok(habitual.score < 70, `habitual different-day match must not reach 70, got ${habitual.score}`);
  // ...but a same-day match keeps its full score.
  const habitualSameDay = scorePair(a, { name: 'ACME PARKING', amount: -6.5, date: '2026-04-06' },
    { habitualMerchant: true });
  assert.equal(habitualSameDay.score, sameDay.score);
});

test('cross-file overlaps exempt merchants that are habitual within the batch', () => {
  // File A: a daily $4.75 espresso all week. File B: the overlapping statement
  // export contains the same week. Same-day pairs are real overlaps (flag);
  // different-day pairs at the habitual merchant are routine (no flag).
  const week = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
    '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
    '2026-03-16', '2026-03-17'];
  const items = [];
  for (const d of week) {
    items.push(item('CORNER ESPRESSO BAR', -4.75, d, 'file-A'));
    items.push(item('CORNER ESPRESSO BAR', -4.75, d, 'file-B'));
  }
  const matches = findCrossFileOverlaps(items);
  assert.ok(matches.length > 0, 'true same-day overlaps must still be found');
  for (const m of matches) {
    const a = items.find((i) => i.id === m.itemId);
    const b = items.find((i) => i.id === m.matchedTransactionId);
    assert.equal(a.parsed_date, b.parsed_date,
      'only SAME-DAY pairs may be flagged for a habitual merchant');
  }
});

test('isHabitualCadence recognizes routines and rejects monthly bills', () => {
  assert.equal(isHabitualCadence(['2026-01-05', '2026-01-08', '2026-01-12', '2026-01-15', '2026-01-19', '2026-01-22']), true);
  // Monthly subscription: 30-day gaps are a billing cadence, not a habit.
  assert.equal(isHabitualCadence(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']), false);
  // A one-week burst has no established span.
  assert.equal(isHabitualCadence(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']), false);
});

// ---------------------------------------------------------------------------
// Timezone off-by-one
// ---------------------------------------------------------------------------

test('date-only math never shifts a day near midnight (TZ pinned west of UTC)', () => {
  // The old implementation parsed 'YYYY-MM-DD' as UTC midnight and then did
  // local-time setDate/getDate — in America/Los_Angeles that walks the date
  // back a day. The pure helpers must be exact regardless of process TZ.
  assert.equal(addDays('2026-01-01', 1), '2026-01-02');
  assert.equal(addDays('2026-01-01', -3), '2025-12-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');   // month boundary
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');    // leap year
  assert.equal(fromEpochDay(epochDay('2026-08-24')), '2026-08-24');
  assert.equal(daysApart('2026-03-01', '2026-02-28'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-01-02'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);

  // DST transition (2026-03-08 in the US): a Date-based diff would see a
  // 23-hour "day"; calendar math must still count exactly 1.
  assert.equal(daysBetween('2026-03-08', '2026-03-09'), 1);

  // Same-day pairs stay same-day: gap must be 0, not 1.
  const r = scorePair(
    { name: 'MIDNIGHT DINER', amount: -20, date: '2026-06-01' },
    { name: 'MIDNIGHT DINER', amount: -20, date: '2026-06-01' },
  );
  assert.ok(r.reasons.includes('Same date'));
});
