/**
 * Bank-sync engine (design doc 03-aggregation.md §5).
 *
 * `syncConnection()` drains the provider's transaction feed page by page,
 * committing each page's rows AND its cursor in a single transaction, so a
 * crash mid-sync never advances the cursor past uncommitted rows. Replays are
 * harmless: upserts are keyed on the unique index
 * `uq_txn_provider(account_id, provider, provider_txn_id)`.
 *
 * Pending -> posted: providers may issue a NEW id when a pending transaction
 * posts. When the provider links them (`pendingTxnId`, Plaid) the pending row
 * is morphed in place; when it does not (Teller id churn, SimpleFIN) a
 * `scorePair()` fallback from engine/duplicates.ts finds the pending
 * predecessor. Morphing in place preserves the row id, so any category /
 * notes / tags the user set on the pending row survive posting.
 *
 * Provider `removed` ids are soft-deleted (`removed_at`), never hard-deleted —
 * the user may have categorised the row and provider removals are reversible.
 *
 * SECURITY: the access token is decrypted just-in-time via vault.openToken,
 * used, and dropped. It never appears in sync_runs.error, status_detail,
 * audit detail, logs, or any return value — error messages are scrubbed of
 * the token before persistence (see sanitizeMessage).
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import type { Sql } from '../db/sql.js';
import { getProviderAdapter } from './registry.js';
import { openToken, redact, type SealedToken } from './vault.js';
import { scorePair } from '../engine/duplicates.js';
import { audit } from '../security/audit.js';
import {
  RateLimitedError, ReauthRequiredError,
  type ConnectionStatus, type NormalizedTxn, type ProviderAccountData,
  type ProviderAdapter, type SyncPage,
} from './types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type SyncTrigger = 'webhook' | 'cron' | 'manual' | 'backfill' | 'link';

export interface SyncOptions {
  trigger?: SyncTrigger;
  /** Injected in tests; defaults to getProviderAdapter() for the connection's provider. */
  adapter?: ProviderAdapter;
  /** Injected in tests to skip real waiting during rate-limit backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Rate-limit retries before giving up (default 3). */
  maxRateLimitRetries?: number;
}

export interface SyncRunResult {
  runId: string | null;
  connectionId: string;
  status: 'success' | 'failed' | 'skipped';
  connectionStatus: ConnectionStatus;
  added: number;
  modified: number;
  removed: number;
  /** Sanitized — never contains token material. */
  error?: string;
}

// Matching thresholds for the heuristic pending->posted fallback. Mirrors
// engine/duplicates.ts (MATCH_THRESHOLD / DATE_WINDOW_DAYS) — reusing its
// scorePair(), not reimplementing the scoring.
const PENDING_MATCH_THRESHOLD = 70;
const PENDING_MATCH_WINDOW_DAYS = 3;

const INSTITUTION_DOWN_AFTER_FAILURES = 3;

/** Per-process guard: one sync per connection at a time. */
const inFlight = new Set<string>();

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  provider_item_id: string;
  institution_id: string | null;
  institution_name: string;
  status: string;
  token_ciphertext: string | null;
  token_iv: string | null;
  token_tag: string | null;
  dek_wrapped: string | null;
  dek_iv: string | null;
  dek_tag: string | null;
  kek_version: number;
}

/**
 * Sync one connection's transactions scope. Records a sync_runs row, updates
 * connection + institution status, and audits 'provider.sync'.
 *
 * Callers are responsible for authorization: routes must prove the connection
 * belongs to the requesting user BEFORE calling this (webhooks resolve the
 * connection from a signature-verified provider item id).
 */
export async function syncConnection(connectionId: string, opts: SyncOptions = {}): Promise<SyncRunResult> {
  const trigger: SyncTrigger = opts.trigger ?? 'manual';
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRateLimitRetries ?? 3;

  const conn = await db.get<ConnectionRow>(
    `SELECT id, user_id, provider, provider_item_id, institution_id, institution_name, status,
            token_ciphertext, token_iv, token_tag, dek_wrapped, dek_iv, dek_tag, kek_version
       FROM provider_connections
      WHERE id = ? AND deleted_at IS NULL`,
    connectionId,
  );
  if (!conn) {
    return skippedResult(connectionId, 'disconnected', 'connection not found');
  }
  if (conn.status === 'disconnected' || !conn.token_ciphertext) {
    return skippedResult(connectionId, conn.status as ConnectionStatus, 'connection is not linked');
  }
  if (inFlight.has(connectionId)) {
    return skippedResult(connectionId, conn.status as ConnectionStatus, 'sync already in progress');
  }
  inFlight.add(connectionId);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let token = '';
  let added = 0, modified = 0, removed = 0;

  try {
    await db.run(
      `INSERT INTO sync_runs (id, connection_id, scope, "trigger", status, started_at)
       VALUES (?, ?, 'transactions', ?, 'running', ?)`,
      runId, connectionId, trigger, startedAt,
    );
    await db.run(
      `UPDATE provider_connections SET status = 'syncing', updated_at = ? WHERE id = ?`,
      startedAt, connectionId,
    );

    const adapter = opts.adapter ?? getProviderAdapter(db, conn.provider);
    token = openToken(connectionId, sealedFromRow(conn));

    // Map provider accounts onto app accounts (creating on first sight) and
    // reconcile balances from the provider snapshot.
    const providerAccounts = await withRateLimitRetry(() => adapter.listAccounts(token), sleep, maxRetries);
    const accountMap = await reconcileProviderAccounts(db, conn, providerAccounts);
    const ctx: ApplyCtx = { userId: conn.user_id, provider: conn.provider, accountMap };

    const cursorRow = await db.get<{ cursor: string | null }>(
      `SELECT cursor FROM sync_cursors WHERE connection_id = ? AND scope = 'transactions'`,
      connectionId,
    );
    let cursor: string | null = cursorRow?.cursor ?? null;
    let hasMore = true;

    while (hasMore) {
      const page = await withRateLimitRetry(
        () => adapter.syncTransactions(token, null, cursor), sleep, maxRetries,
      );
      // Page-atomic: rows and cursor commit together, or neither does.
      const counts = await db.tx(async (t) => {
        const c = await applyPage(t, ctx, page);
        await t.run(
          `INSERT INTO sync_cursors (connection_id, scope, cursor, updated_at)
           VALUES (?, 'transactions', ?, ?)
           ON CONFLICT(connection_id, scope) DO UPDATE
             SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          connectionId, page.nextCursor, new Date().toISOString(),
        );
        return c;
      });
      added += counts.added; modified += counts.modified; removed += counts.removed;
      await db.run(
        `UPDATE sync_runs SET added_count = ?, modified_count = ?, removed_count = ? WHERE id = ?`,
        added, modified, removed, runId,
      );
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    const finishedAt = new Date().toISOString();
    await db.run(
      `UPDATE sync_runs SET status = 'success', finished_at = ? WHERE id = ?`,
      finishedAt, runId,
    );
    await db.run(
      `UPDATE provider_connections
          SET status = 'active', status_detail = '{}', last_synced_at = ?, updated_at = ?
        WHERE id = ?`,
      finishedAt, finishedAt, connectionId,
    );
    await markInstitutionHealthy(db, conn, finishedAt);
    await audit('provider.sync', null, {
      userId: conn.user_id,
      targetId: connectionId,
      detail: { provider: conn.provider, trigger, added, modified, removed },
    });
    return { runId, connectionId, status: 'success', connectionStatus: 'active', added, modified, removed };
  } catch (err) {
    const failure = classifyFailure(err, token);
    const finishedAt = new Date().toISOString();
    await db.run(
      `UPDATE sync_runs SET status = 'failed', finished_at = ?, error = ?, next_retry_at = ? WHERE id = ?`,
      finishedAt, JSON.stringify({ code: failure.code, message: failure.message }),
      failure.nextRetryAt, runId,
    );
    await db.run(
      `UPDATE provider_connections SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?`,
      failure.connectionStatus,
      JSON.stringify({ error_code: failure.code, reason: failure.message, since: finishedAt }),
      finishedAt, connectionId,
    );
    if (failure.countsAgainstInstitution) {
      await markInstitutionFailing(db, conn, failure.code, finishedAt);
    }
    await audit('provider.sync', null, {
      userId: conn.user_id,
      targetId: connectionId,
      outcome: 'failure',
      detail: { provider: conn.provider, trigger, added, modified, removed, error_code: failure.code },
    });
    return {
      runId, connectionId, status: 'failed', connectionStatus: failure.connectionStatus,
      added, modified, removed, error: failure.message,
    };
  } finally {
    inFlight.delete(connectionId);
  }
}

// ---------------------------------------------------------------------------
// Provider-account -> app-account mapping + balance reconciliation
// ---------------------------------------------------------------------------

/**
 * Upsert provider_accounts rows and link each onto the app `accounts` table,
 * creating an account row on first sight (matching by last-four first, so a
 * live feed merges into an account the user was importing files for instead
 * of forking a duplicate). Reconciles `accounts.balance` from the provider
 * snapshot, sign-normalized: liabilities arrive positive-owed and are stored
 * negative so existing net-worth math keeps working.
 *
 * Returns providerAccountId -> accounts.id for accounts selected for sync.
 * Also used by the /exchange route right after linking.
 */
export async function reconcileProviderAccounts(
  db: Sql,
  conn: { id: string; user_id: string; provider: string; institution_name: string | null },
  providerAccounts: ProviderAccountData[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const now = new Date().toISOString();

  for (const a of providerAccounts) {
    let pa = await db.get<{ id: string; account_id: string | null; is_selected: number }>(
      `SELECT id, account_id, is_selected FROM provider_accounts
        WHERE connection_id = ? AND provider_account_id = ?`,
      conn.id, a.providerAccountId,
    );
    if (!pa) {
      const paId = randomUUID();
      await db.run(
        `INSERT INTO provider_accounts
           (id, connection_id, user_id, provider_account_id, account_id, name, official_name, mask,
            type, subtype, currency, current_balance, available_balance, credit_limit,
            balance_as_of, raw, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        paId, conn.id, conn.user_id, a.providerAccountId, a.name, a.officialName ?? null,
        a.mask ?? null, a.type, a.subtype ?? null, a.currency ?? 'USD',
        a.currentBalance ?? null, a.availableBalance ?? null, a.creditLimit ?? null,
        now, safeJson(a.raw), now, now,
      );
      pa = { id: paId, account_id: null, is_selected: 1 };
    } else {
      await db.run(
        `UPDATE provider_accounts
            SET name = ?, official_name = ?, mask = ?, type = ?, subtype = ?,
                current_balance = ?, available_balance = ?, credit_limit = ?,
                balance_as_of = ?, updated_at = ?
          WHERE id = ?`,
        a.name, a.officialName ?? null, a.mask ?? null, a.type, a.subtype ?? null,
        a.currentBalance ?? null, a.availableBalance ?? null, a.creditLimit ?? null,
        now, now, pa.id,
      );
    }

    // Resolve the app account: existing link -> last-four match -> create.
    let accountId = pa.account_id;
    if (accountId) {
      const still = await db.get<{ id: string }>(
        `SELECT id FROM accounts WHERE id = ? AND user_id = ?`, accountId, conn.user_id,
      );
      if (!still) accountId = null;
    }
    if (!accountId && a.mask) {
      const matched = await db.get<{ id: string }>(
        `SELECT id FROM accounts
          WHERE user_id = ? AND last_four = ?
            AND (provider_account_pk IS NULL OR provider_account_pk = ?)
          ORDER BY created_at ASC LIMIT 1`,
        conn.user_id, a.mask, pa.id,
      );
      if (matched) accountId = matched.id;
    }

    const displayBal = displayBalance(a);
    if (!accountId) {
      accountId = randomUUID();
      await db.run(
        `INSERT INTO accounts
           (id, user_id, name, type, institution, balance, last_four, is_hidden,
            source, sync_source, provider_account_pk, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'sync', ?, ?, ?, ?)`,
        accountId, conn.user_id, a.name, a.type, conn.institution_name ?? null,
        displayBal ?? 0, a.mask ?? null, conn.provider, pa.id, now, now,
      );
    } else {
      await db.run(
        `UPDATE accounts
            SET balance = COALESCE(?, balance), sync_source = ?, provider_account_pk = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
        displayBal, conn.provider, pa.id, now, accountId, conn.user_id,
      );
    }
    if (accountId !== pa.account_id) {
      await db.run(
        `UPDATE provider_accounts SET account_id = ?, updated_at = ? WHERE id = ?`,
        accountId, now, pa.id,
      );
    }
    if (pa.is_selected) map.set(a.providerAccountId, accountId);
  }
  return map;
}

/** Providers report liabilities positive-owed; the app stores them negative. */
function displayBalance(a: ProviderAccountData): number | null {
  if (a.currentBalance == null) return null;
  return a.type === 'credit' || a.type === 'loan' ? -a.currentBalance : a.currentBalance;
}

// ---------------------------------------------------------------------------
// Page application (runs inside the per-page transaction)
// ---------------------------------------------------------------------------

interface ApplyCtx {
  userId: string;
  provider: string;
  accountMap: Map<string, string>;
}

interface PageCounts { added: number; modified: number; removed: number }

async function applyPage(t: Sql, ctx: ApplyCtx, page: SyncPage): Promise<PageCounts> {
  let added = 0, modified = 0, removed = 0;

  // added and modified go through the same idempotent upsert: watermark
  // overlap and replays are harmless either way.
  for (const n of [...page.added, ...page.modified]) {
    const outcome = await upsertTxn(t, ctx, n);
    if (outcome === 'added') added++;
    else if (outcome === 'modified') modified++;
  }

  const now = new Date().toISOString();
  for (const r of page.removed) {
    const res = await t.run(
      `UPDATE transactions SET removed_at = ?, updated_at = ?
        WHERE user_id = ? AND provider = ? AND provider_txn_id = ? AND removed_at IS NULL`,
      now, now, ctx.userId, ctx.provider, r.providerTxnId,
    );
    removed += res.changes;
  }
  return { added, modified, removed };
}

async function upsertTxn(t: Sql, ctx: ApplyCtx, n: NormalizedTxn): Promise<'added' | 'modified' | 'skipped'> {
  const accountId = ctx.accountMap.get(n.providerAccountId);
  if (!accountId) return 'skipped'; // deselected or unknown provider account
  const now = new Date().toISOString();

  // 1. Already landed under this provider id -> update core fields in place.
  //    category_id / notes / tags are deliberately untouched, so user edits
  //    survive provider re-sends.
  const existing = await t.get<{ id: string }>(
    `SELECT id FROM transactions WHERE account_id = ? AND provider = ? AND provider_txn_id = ?`,
    accountId, ctx.provider, n.providerTxnId,
  );
  if (existing) {
    await t.run(
      `UPDATE transactions
          SET name = ?, amount = ?, date = ?, posted_date = ?, is_pending = ?, updated_at = ?
        WHERE id = ?`,
      n.name, n.amount, n.date, n.postedDate ?? null, n.pending ? 1 : 0, now, existing.id,
    );
    return 'modified';
  }

  // 2. Pending -> posted with a provider-supplied link (Plaid): morph the
  //    pending row in place instead of inserting a duplicate.
  if (n.pendingTxnId) {
    const pend = await t.get<{ id: string }>(
      `SELECT id FROM transactions
        WHERE account_id = ? AND provider = ? AND provider_txn_id = ? AND removed_at IS NULL`,
      accountId, ctx.provider, n.pendingTxnId,
    );
    if (pend) {
      await morphPendingToPosted(t, pend.id, n, now);
      return 'modified';
    }
  }

  // 3. Posted txn with no link (Teller id churn, SimpleFIN): look for a
  //    pending predecessor on the same account within +-3 days scoring >= 70
  //    via the existing scorePair(), and morph it instead of inserting.
  if (!n.pending) {
    const from = shiftDate(n.date, -PENDING_MATCH_WINDOW_DAYS);
    const to = shiftDate(n.date, PENDING_MATCH_WINDOW_DAYS);
    const candidates = await t.all<{ id: string; name: string; amount: number; date: string }>(
      `SELECT id, name, amount, date FROM transactions
        WHERE account_id = ? AND provider = ? AND is_pending = 1 AND removed_at IS NULL
          AND date >= ? AND date <= ?`,
      accountId, ctx.provider, from, to,
    );
    let best: { id: string } | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const { score } = scorePair({ name: n.name, amount: n.amount, date: n.date }, c);
      if (score >= PENDING_MATCH_THRESHOLD && score > bestScore) { best = c; bestScore = score; }
    }
    if (best) {
      await morphPendingToPosted(t, best.id, n, now);
      return 'modified';
    }
  }

  // 4. Genuinely new.
  await t.run(
    `INSERT INTO transactions
       (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, tags,
        source, provider, provider_txn_id, pending_txn_id, posted_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, '[]', 'sync', ?, ?, ?, ?, ?, ?)`,
    randomUUID(), ctx.userId, accountId, n.name, n.amount, n.date, n.pending ? 1 : 0,
    ctx.provider, n.providerTxnId, n.pendingTxnId ?? null, n.postedDate ?? null, now, now,
  );
  return 'added';
}

/**
 * Update the pending row in place under its posted identity. The row id is
 * preserved, so category/notes/tags the user set while it was pending survive.
 * `pending_txn_id` records the predecessor id: the provider's link when given,
 * otherwise the row's own old provider_txn_id (COALESCE sees the pre-update
 * value — SET expressions evaluate against the old row in both engines).
 */
async function morphPendingToPosted(t: Sql, rowId: string, n: NormalizedTxn, now: string): Promise<void> {
  await t.run(
    `UPDATE transactions
        SET pending_txn_id = COALESCE(?, provider_txn_id), provider_txn_id = ?,
            is_pending = ?, name = ?, amount = ?, date = ?, posted_date = ?, updated_at = ?
      WHERE id = ?`,
    n.pendingTxnId ?? null, n.providerTxnId, n.pending ? 1 : 0, n.name, n.amount,
    n.date, n.postedDate ?? null, now, rowId,
  );
}

// ---------------------------------------------------------------------------
// Failure classification, retry/backoff, institution health
// ---------------------------------------------------------------------------

interface Failure {
  connectionStatus: ConnectionStatus;
  code: string;
  message: string;
  nextRetryAt: string | null;
  countsAgainstInstitution: boolean;
}

function classifyFailure(err: unknown, token: string): Failure {
  const message = sanitizeMessage(err, token);
  if (err instanceof ReauthRequiredError) {
    // The user must re-link; retrying cannot help and hammers the provider.
    return { connectionStatus: 'reauth_required', code: 'reauth_required', message, nextRetryAt: null, countsAgainstInstitution: false };
  }
  if (err instanceof RateLimitedError) {
    const waitMs = Math.max((err.retryAfterSeconds ?? 0) * 1000, 30 * 60_000);
    return {
      connectionStatus: 'rate_limited', code: 'rate_limited', message,
      nextRetryAt: new Date(Date.now() + waitMs).toISOString(), countsAgainstInstitution: false,
    };
  }
  const code = err instanceof Error && err.name ? err.name : 'error';
  return {
    connectionStatus: 'error', code, message,
    nextRetryAt: new Date(Date.now() + 15 * 60_000).toISOString(), countsAgainstInstitution: true,
  };
}

/**
 * Errors land in sync_runs / status_detail / audit — scrub any occurrence of
 * the plaintext token first and cap length so raw provider payloads cannot
 * leak through an exception message.
 */
function sanitizeMessage(err: unknown, token: string): string {
  let msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (token) msg = msg.split(token).join(redact(token));
  return msg.slice(0, 300);
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  maxRetries: number,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitedError) || attempt >= maxRetries) throw err;
      const hinted = (err.retryAfterSeconds ?? 0) * 1000;
      const backoff = Math.min(Math.max(hinted, (2 ** attempt) * 1000), 60_000);
      await sleep(backoff);
    }
  }
}

function institutionKey(conn: { institution_id: string | null; institution_name: string | null }): string {
  return conn.institution_id ?? conn.institution_name ?? 'unknown';
}

async function markInstitutionHealthy(db: Sql, conn: ConnectionRow, at: string): Promise<void> {
  await db.run(
    `INSERT INTO institution_status
       (provider, institution_id, institution_name, health, detail, consecutive_failures, last_success_at, last_checked_at)
     VALUES (?, ?, ?, 'healthy', '{}', 0, ?, ?)
     ON CONFLICT(provider, institution_id) DO UPDATE
       SET health = 'healthy', detail = '{}', consecutive_failures = 0,
           last_success_at = excluded.last_success_at, last_checked_at = excluded.last_checked_at`,
    conn.provider, institutionKey(conn), conn.institution_name, at, at,
  );
}

async function markInstitutionFailing(db: Sql, conn: ConnectionRow, code: string, at: string): Promise<void> {
  const detail = JSON.stringify({ error_code: code });
  await db.run(
    `INSERT INTO institution_status
       (provider, institution_id, institution_name, health, detail, consecutive_failures, last_checked_at)
     VALUES (?, ?, ?, 'degraded', ?, 1, ?)
     ON CONFLICT(provider, institution_id) DO UPDATE
       SET consecutive_failures = institution_status.consecutive_failures + 1,
           health = CASE WHEN institution_status.consecutive_failures + 1 >= ${INSTITUTION_DOWN_AFTER_FAILURES}
                         THEN 'down' ELSE 'degraded' END,
           detail = excluded.detail,
           last_checked_at = excluded.last_checked_at`,
    conn.provider, institutionKey(conn), conn.institution_name, detail, at,
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function skippedResult(connectionId: string, connectionStatus: ConnectionStatus, reason: string): SyncRunResult {
  return { runId: null, connectionId, status: 'skipped', connectionStatus, added: 0, modified: 0, removed: 0, error: reason };
}

function sealedFromRow(conn: ConnectionRow): SealedToken {
  if (!conn.token_ciphertext || !conn.token_iv || !conn.token_tag ||
      !conn.dek_wrapped || !conn.dek_iv || !conn.dek_tag) {
    throw new Error('connection has no stored credentials');
  }
  return {
    tokenCiphertext: conn.token_ciphertext,
    tokenIv: conn.token_iv,
    tokenTag: conn.token_tag,
    dekWrapped: conn.dek_wrapped,
    dekIv: conn.dek_iv,
    dekTag: conn.dek_tag,
    kekVersion: conn.kek_version,
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v ?? {}).slice(0, 8000); } catch { return '{}'; }
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
