/**
 * Statement date & sign regression tests.
 *
 * Covers the production corruption class where MM/DD line items on a
 * December→January statement were stamped with the period-END year (landing
 * a year in the future) and credit-card purchases were stored positive.
 *
 * Run after `npx tsc` (imports the compiled engine from dist/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStatement,
  resolveTxnDate,
  resolveMmDdYear,
} from '../dist/engine/statementParser.js';

const TAB = '\t';

function bofaCcStatement() {
  return [
    'Bank of America',
    'Visa Signature',
    'Account# 1234 5678 9012 7533',
    'December 18 - January 17, 2026',
    'Previous Balance $1,000.00',
    'New Balance $1,500.00',
    'Payments and Other Credits',
    `12/20${TAB}12/21${TAB}Online payment from CHK 8434${TAB}1111${TAB}7533${TAB}-300.00`,
    'Purchases and Adjustments',
    `12/20${TAB}12/21${TAB}Target 00009688 Miami FL${TAB}2222${TAB}7533${TAB}146.57`,
    `01/05${TAB}01/06${TAB}Uber *one Membership Uber.com/bi${TAB}3333${TAB}7533${TAB}9.99`,
    'Interest Charged',
    `01/17${TAB}01/17${TAB}INTEREST CHARGED ON PURCHASES${TAB}1.23`,
  ].join('\n');
}

test('December→January statement period gets the start year right', () => {
  const result = parseStatement(bofaCcStatement());
  assert.ok(result, 'statement should be recognized');
  assert.equal(result.metadata.statementPeriod.start, '2025-12-18');
  assert.equal(result.metadata.statementPeriod.end, '2026-01-17');
});

test('MM/DD lines land in the correct year on both sides of the boundary', () => {
  const result = parseStatement(bofaCcStatement());
  const target = result.transactions.find((t) => /Target/.test(t.description));
  const uber = result.transactions.find((t) => /Uber/.test(t.description));
  assert.ok(target && uber, 'both purchases parsed');
  // December line belongs to the START year (2025), not the end year.
  assert.equal(target.date, '2025-12-20');
  // January line belongs to the END year (2026).
  assert.equal(uber.date, '2026-01-05');
  // No transaction may post-date the statement period.
  for (const t of result.transactions) {
    assert.ok(t.date <= '2026-01-17', `${t.description} dated ${t.date} is after period end`);
  }
});

test('credit-card purchases are negative (outflow), payments positive (inflow)', () => {
  const result = parseStatement(bofaCcStatement());
  const target = result.transactions.find((t) => /Target/.test(t.description));
  const uber = result.transactions.find((t) => /Uber/.test(t.description));
  const payment = result.transactions.find((t) => /Online payment/.test(t.description));
  const interest = result.transactions.find((t) => /INTEREST CHARGED/i.test(t.description));
  assert.equal(target.amount, -146.57, 'purchase must be an outflow');
  assert.equal(uber.amount, -9.99, 'purchase must be an outflow');
  assert.equal(payment.amount, 300.0, 'payment must be an inflow');
  assert.ok(interest, 'interest line must not be swallowed as a section header');
  assert.equal(interest.amount, -1.23, 'interest must be an outflow');
});

test('signed-layout statements (charges already negative) are left as printed', () => {
  // Same statement but the export lists charges as negative numbers.
  const text = [
    'Bank of America',
    'Visa Signature',
    'Account# 1234 5678 9012 7533',
    'December 18 - January 17, 2026',
    'Purchases and Adjustments',
    `12/20${TAB}12/21${TAB}Target 00009688 Miami FL${TAB}2222${TAB}7533${TAB}-146.57`,
    `01/05${TAB}01/06${TAB}Best Buy 445${TAB}3333${TAB}7533${TAB}-89.00`,
  ].join('\n');
  const result = parseStatement(text);
  const target = result.transactions.find((t) => /Target/.test(t.description));
  assert.equal(target.amount, -146.57, 'already-negative charge stays an outflow');
});

test('a line that would parse into the future is flagged, not silently imported', () => {
  const text = [
    'American Express',
    'Membership Rewards',
    'Account Ending: 1-12345',
    'Opening Date: 12/15/2025',
    'Closing Date: 01/14/2026',
    'Previous Balance: $500.00',
    'New Balance: $800.00',
    'New Charges',
    '12/20/2025* WHOLE FOODS MARKET 45.10',
    '12/25/2026* GHOST FUTURE CHARGE 50.00',
    'Payments and Credits',
    '01/02/2026* AUTOPAY PAYMENT RECEIVED 300.00',
  ].join('\n');
  const result = parseStatement(text);
  assert.ok(result, 'amex statement recognized');

  const ghost = result.transactions.find((t) => /GHOST/.test(t.description));
  assert.ok(ghost, 'future-dated line still surfaces (for review), it is not dropped silently');
  assert.ok(ghost.flags.includes('date_out_of_range'), 'future-dated line carries the guard flag');
  assert.ok(
    result.errors.some((e) => /Date guard/.test(e)),
    'parser reports the violation in errors'
  );

  const wholeFoods = result.transactions.find((t) => /WHOLE FOODS/.test(t.description));
  const payment = result.transactions.find((t) => /AUTOPAY/.test(t.description));
  assert.equal(wholeFoods.date, '2025-12-20');
  assert.ok(!wholeFoods.flags.includes('date_out_of_range'));
  assert.equal(wholeFoods.amount, -45.1, 'amex charge is an outflow');
  assert.equal(payment.amount, 300.0, 'amex payment is an inflow');
});

test('resolveMmDdYear: boundary handling and guard', () => {
  const period = { start: '2025-12-18', end: '2026-01-17' };
  // December line → start year
  assert.deepEqual(resolveMmDdYear(12, 20, period), { date: '2025-12-20', outOfRange: false });
  assert.deepEqual(resolveMmDdYear(12, 31, period), { date: '2025-12-31', outOfRange: false });
  // January line → end year
  assert.deepEqual(resolveMmDdYear(1, 5, period), { date: '2026-01-05', outOfRange: false });
  // Period end itself is allowed
  assert.deepEqual(resolveMmDdYear(1, 17, period), { date: '2026-01-17', outOfRange: false });
});

test('resolveTxnDate: explicit-year date after period end is rejected', () => {
  const period = { start: '2025-12-18', end: '2026-01-17' };
  const bad = resolveTxnDate('12/25/2026', period);
  assert.equal(bad.date, '2026-12-25');
  assert.equal(bad.outOfRange, true, 'a date after the statement end must be flagged');

  const good = resolveTxnDate('12/25/2025', period);
  assert.equal(good.outOfRange, false);
});

test('resolveTxnDate: date far before the period start is rejected (~13-month guard)', () => {
  const period = { start: '2025-12-18', end: '2026-01-17' };
  const ancient = resolveTxnDate('01/05/2024', period);
  assert.equal(ancient.outOfRange, true, 'more than ~13 months before the start must be flagged');
});

test('resolveMmDdYear without a statement period never produces a future date', () => {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  const r = resolveMmDdYear(tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), { start: '', end: '' });
  const todayIso = now.toISOString().slice(0, 10);
  assert.ok(r.date <= todayIso, `${r.date} must not be after today (${todayIso})`);
  assert.equal(r.outOfRange, false);
});
