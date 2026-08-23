/**
 * Sync-engine tests (src/providers/sync.ts) against a fake in-memory adapter
 * and a throwaway SQLite database. Runs against the COMPILED output (dist/),
 * like the other test files.
 *
 * Covers:
 *   - first sync inserts transactions, creates the account, saves the cursor
 *   - re-running the identical page inserts nothing (idempotent upsert)
 *   - pending -> posted updates the row in place (provider link AND heuristic)
 *   - removed ids set removed_at (soft delete, never hard delete)
 *   - a failing page rolls back atomically and does not advance the cursor
 *   - ReauthRequiredError stops the sync and marks the connection
 *   - RateLimitedError is retried with backoff
 *
 * Run: node --test test/sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set BEFORE the app modules load: database.js opens its SQLite
// file at import time, and initSecurity() prefers env over the database.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-sync-test-')), 'test.db');
process.env.FINFLOW_KEK_V1 = 'sync-test-kek-0123456789abcdef-0123456789abcdef';

const security = await import('../dist/config/security.js');
await security.initSecurity();
const { db, initDb } = await import('../dist/db/database.js');
initDb();
const { applyProviderSchema } = await import('../dist/providers/schema.js');
await applyProviderSchema(db);
const { sealToken } = await import('../dist/providers/vault.js');
const { syncConnection } = await import('../dist/providers/sync.js');
const { RateLimitedError, ReauthRequiredError } = await import('../dist/providers/types.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAINTEXT_TOKEN = 'tok_live_SECRET_never_in_logs';

async function makeUser() {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, 'x', 'Sync Tester', ?, ?)`,
    id, `${id}@test.local`, now, now,
  );
  return id;
}

async function makeConnection(userId) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const sealed = sealToken(id, PLAINTEXT_TOKEN);
  await db.run(
    `INSERT INTO provider_connections
       (id, user_id, provider, provider_item_id, institution_id, institution_name, status,
        token_ciphertext, token_iv, token_tag, dek_wrapped, dek_iv, dek_tag, kek_version,
        created_at, updated_at)
     VALUES (?, ?, 'teller', ?, 'inst_test', 'Test Bank', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, `enr_${id}`,
    sealed.tokenCiphertext, sealed.tokenIv, sealed.tokenTag,
    sealed.dekWrapped, sealed.dekIv, sealed.dekTag, sealed.kekVersion,
    now, now,
  );
  return id;
}

const ACCOUNT = {
  providerAccountId: 'acc_1',
  name: 'Everyday Checking',
  mask: '4821',
  type: 'checking',
  currency: 'USD',
  currentBalance: 500,
  raw: {},
};

function txn(id, extra = {}) {
  return {
    providerTxnId: id,
    providerAccountId: 'acc_1',
    date: '2026-08-20',
    name: `Merchant ${id}`,
    amount: -10,
    pending: false,
    raw: {},
    ...extra,
  };
}

function page(added, { cursor = 'c1', hasMore = false, modified = [], removed = [] } = {}) {
  return { added, modified, removed, nextCursor: cursor, hasMore };
}

/**
 * Fake adapter: `pages` is consumed one entry per syncTransactions call.
 * An Error entry is thrown instead of returned.
 */
function fakeAdapter(pages, { accounts = [ACCOUNT] } = {}) {
  const calls = { syncTransactions: [] };
  const adapter = {
    name: 'teller',
    capabilities: {
      link: 'widget', webhooks: true, cursorSync: false, liabilities: false,
      investments: false, pendingTransactions: true, maxHistoryDays: 365,
    },
    async linkInit() { return { mode: 'widget' }; },
    async exchangePublicToken() { throw new Error('not used in these tests'); },
    async listAccounts() { return accounts; },
    async syncTransactions(_token, providerAccountId, cursor) {
      calls.syncTransactions.push({ providerAccountId, cursor });
      const step = pages.shift();
      if (step === undefined) throw new Error('fake adapter: no more scripted pages');
      if (step instanceof Error) throw step;
      return step;
    },
    async unlink() {},
  };
  return { adapter, calls };
}

const noSleep = async () => {};

async function txns(userId) {
  return db.all(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY provider_txn_id`, userId,
  );
}

async function cursorOf(connectionId) {
  const row = await db.get(
    `SELECT cursor FROM sync_cursors WHERE connection_id = ? AND scope = 'transactions'`,
    connectionId,
  );
  return row ? row.cursor : undefined;
}

async function connStatus(connectionId) {
  const row = await db.get(`SELECT status FROM provider_connections WHERE id = ?`, connectionId);
  return row.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('first sync inserts transactions, creates the account, commits the cursor', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);
  const { adapter } = fakeAdapter([
    page([txn('t1'), txn('t2'), txn('t3', { pending: true })], { cursor: 'c1' }),
  ]);

  const result = await syncConnection(conn, { adapter, trigger: 'manual', sleep: noSleep });

  assert.equal(result.status, 'success');
  assert.equal(result.added, 3);
  assert.equal(result.connectionStatus, 'active');

  const rows = await txns(user);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.provider, 'teller');
    assert.equal(r.source, 'sync');
    assert.equal(r.removed_at, null);
  }
  assert.equal(rows.find((r) => r.provider_txn_id === 't3').is_pending, 1);

  // Account created on first sight, balance reconciled from the snapshot.
  const accounts = await db.all(`SELECT * FROM accounts WHERE user_id = ?`, user);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].balance, 500);
  assert.equal(accounts[0].last_four, '4821');
  assert.equal(accounts[0].sync_source, 'teller');

  assert.equal(await cursorOf(conn), 'c1');

  const run = await db.get(
    `SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT 1`, conn,
  );
  assert.equal(run.status, 'success');
  assert.equal(run.added_count, 3);
});

test('re-running the identical page inserts nothing', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);
  const samePage = () => page([txn('t1'), txn('t2')], { cursor: 'c1' });

  const first = await syncConnection(conn, { adapter: fakeAdapter([samePage()]).adapter, sleep: noSleep });
  assert.equal(first.added, 2);

  const again = await syncConnection(conn, { adapter: fakeAdapter([samePage()]).adapter, sleep: noSleep });
  assert.equal(again.status, 'success');
  assert.equal(again.added, 0, 're-run must not insert');

  const rows = await txns(user);
  assert.equal(rows.length, 2, 'row count unchanged after replaying the identical page');
});

test('pending -> posted with a provider link updates in place, preserving user edits', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);

  const r1 = await syncConnection(conn, {
    adapter: fakeAdapter([page([txn('p1', { pending: true, amount: -20, date: '2026-08-18' })])]).adapter,
    sleep: noSleep,
  });
  assert.equal(r1.added, 1);

  // The user categorises the pending charge before it posts.
  const pendingRow = await db.get(
    `SELECT id FROM transactions WHERE user_id = ? AND provider_txn_id = 'p1'`, user,
  );
  await db.run(
    `UPDATE transactions SET notes = 'user note', user_edited = 1 WHERE id = ?`, pendingRow.id,
  );

  // It posts under a NEW id, linked via pendingTxnId.
  const r2 = await syncConnection(conn, {
    adapter: fakeAdapter([
      page([txn('q1', { pendingTxnId: 'p1', amount: -21.5, date: '2026-08-19', postedDate: '2026-08-19' })]),
    ]).adapter,
    sleep: noSleep,
  });
  assert.equal(r2.added, 0, 'posting must not insert a duplicate');
  assert.equal(r2.modified, 1);

  const rows = await txns(user);
  assert.equal(rows.length, 1, 'still exactly one row for the logical transaction');
  const row = rows[0];
  assert.equal(row.id, pendingRow.id, 'same row id — updated in place');
  assert.equal(row.provider_txn_id, 'q1');
  assert.equal(row.pending_txn_id, 'p1');
  assert.equal(row.is_pending, 0);
  assert.equal(row.amount, -21.5);
  assert.equal(row.notes, 'user note', 'user edits survive posting');
});

test('pending -> posted with NO provider link falls back to scorePair matching', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);

  await syncConnection(conn, {
    adapter: fakeAdapter([
      page([txn('p2', { pending: true, name: 'STARBUCKS #123', amount: -12.5, date: '2026-08-20' })]),
    ]).adapter,
    sleep: noSleep,
  });

  // Teller-style id churn: posted txn arrives under a new id with no link.
  const r2 = await syncConnection(conn, {
    adapter: fakeAdapter([
      page([txn('q2', { name: 'STARBUCKS #123', amount: -12.5, date: '2026-08-21' })]),
    ]).adapter,
    sleep: noSleep,
  });
  assert.equal(r2.added, 0);
  assert.equal(r2.modified, 1);

  const rows = await txns(user);
  assert.equal(rows.length, 1, 'heuristic match morphs the pending row instead of duplicating');
  assert.equal(rows[0].provider_txn_id, 'q2');
  assert.equal(rows[0].pending_txn_id, 'p2', 'old id recorded as the pending predecessor');
  assert.equal(rows[0].is_pending, 0);
});

test('removed ids set removed_at and never hard-delete', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);

  await syncConnection(conn, {
    adapter: fakeAdapter([page([txn('t1'), txn('t2')])]).adapter, sleep: noSleep,
  });
  const r2 = await syncConnection(conn, {
    adapter: fakeAdapter([page([], { removed: [{ providerTxnId: 't1' }], cursor: 'c2' })]).adapter,
    sleep: noSleep,
  });
  assert.equal(r2.removed, 1);

  const rows = await txns(user);
  assert.equal(rows.length, 2, 'row still exists (soft delete)');
  const t1 = rows.find((r) => r.provider_txn_id === 't1');
  assert.ok(t1.removed_at, 'removed_at set');
  assert.equal(rows.find((r) => r.provider_txn_id === 't2').removed_at, null);
});

test('a failing page rolls back atomically and does not advance the cursor', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);

  // Page 1 commits; page 2 contains a row that violates NOT NULL(name) after
  // a good row — the whole page (and its cursor) must roll back together.
  const result = await syncConnection(conn, {
    adapter: fakeAdapter([
      page([txn('ok1')], { cursor: 'committed-1', hasMore: true }),
      page([txn('ok2'), txn('bad', { name: null })], { cursor: 'never-committed' }),
    ]).adapter,
    sleep: noSleep,
  });

  assert.equal(result.status, 'failed');

  const rows = await txns(user);
  assert.deepEqual(rows.map((r) => r.provider_txn_id), ['ok1'], 'good row of the failed page rolled back');
  assert.equal(await cursorOf(conn), 'committed-1', 'cursor stays at the last COMMITTED page');
  assert.equal(await connStatus(conn), 'error');

  const run = await db.get(
    `SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT 1`, conn,
  );
  assert.equal(run.status, 'failed');
  assert.ok(run.error, 'failure recorded');
  assert.ok(!String(run.error).includes(PLAINTEXT_TOKEN), 'sanitized error never contains the token');

  // Institution health tracked on failure.
  const inst = await db.get(
    `SELECT * FROM institution_status WHERE provider = 'teller' AND institution_id = 'inst_test'`,
  );
  assert.ok(inst);
  assert.ok(inst.consecutive_failures >= 1);
});

test('ReauthRequiredError stops the sync and marks the connection, without retrying', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);
  const { adapter, calls } = fakeAdapter([new ReauthRequiredError('teller')]);

  const result = await syncConnection(conn, { adapter, sleep: noSleep });

  assert.equal(result.status, 'failed');
  assert.equal(result.connectionStatus, 'reauth_required');
  assert.equal(await connStatus(conn), 'reauth_required');
  assert.equal(calls.syncTransactions.length, 1, 'no retries on reauth');
  assert.ok(!String(result.error ?? '').includes(PLAINTEXT_TOKEN));
});

test('RateLimitedError is retried with backoff and then succeeds', async () => {
  const user = await makeUser();
  const conn = await makeConnection(user);
  const waits = [];
  const { adapter, calls } = fakeAdapter([
    new RateLimitedError('teller', 1),
    page([txn('t1')]),
  ]);

  const result = await syncConnection(conn, {
    adapter, sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.added, 1);
  assert.equal(calls.syncTransactions.length, 2, 'retried after the 429');
  assert.equal(waits.length, 1, 'slept once before the retry');
  assert.ok(waits[0] >= 1000);
  assert.equal((await txns(user)).length, 1);
});
