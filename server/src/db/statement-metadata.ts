/**
 * Statement metadata persistence (audit item 19).
 *
 * statementParser.ts extracts each statement's period, opening/closing
 * balances, and fee/interest totals — and until now the upload pipeline threw
 * all of it away. This module persists that metadata into `statement_periods`,
 * one row per uploaded file, and derives two things from it:
 *
 *   1. A durable anchor for the date guard: "no transaction may post-date the
 *      statement period it came from" can now be enforced at import time (and
 *      by future repair passes) against the REAL statement period instead of
 *      the import timestamp.
 *   2. A reconciliation check: do the parsed transactions sum from the
 *      statement's opening balance to its closing balance? A discrepancy is
 *      the single most reliable signal that parsing missed rows.
 *
 * Sign conventions. Parsed transactions use the app convention (negative =
 * outflow). Statement balances are stored exactly as printed:
 *   - depository (checking/savings): balance delta = closing − opening equals
 *     the sum of parsed amounts.
 *   - credit cards: printed balances are AMOUNTS OWED, so the owed balance
 *     grows with purchases (negative rows) and shrinks with payments
 *     (positive rows): the expected sum of parsed amounts is opening − closing.
 *
 * Schema is additive-only and portable (SQLite dev / Postgres prod), applied
 * through db.exec() so translateDdl() runs on the Postgres driver — the same
 * pattern as providers/schema.ts. Wire `applyStatementSchema(db)` at boot;
 * every write/read path here also lazily ensures the schema so the upload
 * pipeline works even before the boot wiring lands.
 */
import { db as defaultDb } from './database.js';
import type { Sql } from './sql.js';

/** |expected − parsed| above this is a reconciliation failure (audit §11). */
export const RECONCILE_TOLERANCE = 1.0;

const CREDIT_TYPE_RE = /credit|card|loan|mortgage/i;

const TABLES = `
  CREATE TABLE IF NOT EXISTS statement_periods (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id        TEXT,
    session_id        TEXT,
    file_id           TEXT,
    source_file       TEXT NOT NULL,
    institution       TEXT,
    account_type      TEXT,
    period_start      TEXT,
    period_end        TEXT,
    period_source     TEXT NOT NULL DEFAULT 'none',   -- 'statement' | 'derived' | 'none'
    balances_known    INTEGER NOT NULL DEFAULT 0,
    opening_balance   REAL,
    closing_balance   REAL,
    total_fees        REAL NOT NULL DEFAULT 0,
    total_interest    REAL NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    parsed_net        REAL NOT NULL DEFAULT 0,        -- sum of parsed amounts, app sign convention
    expected_net      REAL,                           -- balance-implied sum (NULL when balances unknown)
    discrepancy       REAL,                           -- expected_net − parsed_net (NULL when unknown)
    reconciled        INTEGER,                        -- 1 clean, 0 discrepancy, NULL not checkable
    created_at        TEXT NOT NULL
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_stmt_periods_user ON statement_periods(user_id, period_end);
  CREATE INDEX IF NOT EXISTS idx_stmt_periods_file ON statement_periods(file_id);
  CREATE INDEX IF NOT EXISTS idx_stmt_periods_session ON statement_periods(session_id);
`;

/** Idempotent, additive, dialect-portable. Call once at boot after initDb(). */
export async function applyStatementSchema(sql: Sql): Promise<void> {
  await sql.exec(TABLES);
  await sql.exec(INDEXES);
}

let schemaReady: Promise<void> | null = null;

/** Lazy guard so upload paths work even before boot wiring applies the schema. */
export async function ensureStatementSchema(sql?: Sql): Promise<void> {
  if (!schemaReady) {
    schemaReady = applyStatementSchema(sql ?? defaultDb).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
}

// ---------------------------------------------------------------------------
// Reconciliation math (pure)
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
  /** Sum the parsed transactions should reach, implied by the balances. */
  expectedNet: number | null;
  /** expectedNet − parsedNet. Positive = parsed rows sum SHORT of the statement. */
  discrepancy: number | null;
  /** true = clean, false = discrepancy beyond tolerance, null = not checkable. */
  reconciled: boolean | null;
}

/**
 * Compare Σ(parsed amounts) against the opening→closing balance delta.
 * `balancesKnown` should be false when the parser could not extract balances
 * (it defaults both to 0, which is indistinguishable from a real $0/$0
 * statement — callers pass what they know).
 */
export function reconcileStatement(
  accountType: string | null | undefined,
  openingBalance: number,
  closingBalance: number,
  parsedNet: number,
  balancesKnown: boolean,
): ReconciliationResult {
  if (!balancesKnown) return { expectedNet: null, discrepancy: null, reconciled: null };
  const isLiability = CREDIT_TYPE_RE.test(accountType || '');
  // Depository: closing = opening + Σamounts. Liability (balances printed as
  // amounts owed): closing = opening − Σamounts.
  const expectedNet = round2(isLiability ? openingBalance - closingBalance : closingBalance - openingBalance);
  const discrepancy = round2(expectedNet - parsedNet);
  return { expectedNet, discrepancy, reconciled: Math.abs(discrepancy) <= RECONCILE_TOLERANCE };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface StatementPeriodInput {
  userId: string;
  accountId: string | null;
  sessionId: string;
  fileId: string;
  sourceFile: string;
  institution: string | null;
  accountType: string | null;
  /** As extracted from the statement itself; '' when not printed/parsed. */
  periodStart: string;
  periodEnd: string;
  /** Fallback range derived from the parsed rows' min/max dates. */
  derivedStart: string | null;
  derivedEnd: string | null;
  openingBalance: number;
  closingBalance: number;
  totalFees: number;
  totalInterest: number;
  transactionCount: number;
  /** Σ parsed amounts, app sign convention (negative = outflow). */
  parsedNet: number;
}

export interface StatementPeriodRow {
  id: string;
  user_id: string;
  account_id: string | null;
  session_id: string | null;
  file_id: string | null;
  source_file: string;
  institution: string | null;
  account_type: string | null;
  period_start: string | null;
  period_end: string | null;
  period_source: 'statement' | 'derived' | 'none';
  balances_known: number;
  opening_balance: number | null;
  closing_balance: number | null;
  total_fees: number;
  total_interest: number;
  transaction_count: number;
  parsed_net: number;
  expected_net: number | null;
  discrepancy: number | null;
  reconciled: number | null;
  created_at: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s: string | null | undefined): s is string {
  return !!s && ISO_DATE_RE.test(s);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Persist one uploaded statement's metadata and run the reconciliation check.
 * Returns the stored row (including the reconciliation verdict) so the upload
 * response can surface it immediately.
 */
export async function recordStatementPeriod(sql: Sql, input: StatementPeriodInput): Promise<StatementPeriodRow> {
  await ensureStatementSchema(sql);

  // Prefer the period printed on the statement; fall back to the parsed rows'
  // date range (marked 'derived' so the date guard never trusts it as a hard
  // upper bound — a mis-parsed future date would extend it).
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let periodSource: 'statement' | 'derived' | 'none' = 'none';
  if (isIsoDate(input.periodStart) || isIsoDate(input.periodEnd)) {
    periodStart = isIsoDate(input.periodStart) ? input.periodStart : null;
    periodEnd = isIsoDate(input.periodEnd) ? input.periodEnd : null;
    periodSource = 'statement';
  } else if (isIsoDate(input.derivedStart) && isIsoDate(input.derivedEnd)) {
    periodStart = input.derivedStart;
    periodEnd = input.derivedEnd;
    periodSource = 'derived';
  }

  // The parser defaults unextracted balances to 0/0, which cannot be told
  // apart from a genuinely empty account — treat both-zero as unknown unless
  // the parsed rows also sum to ~0 (then 0→0 is at least self-consistent).
  const balancesKnown =
    input.openingBalance !== 0 || input.closingBalance !== 0 || Math.abs(input.parsedNet) <= RECONCILE_TOLERANCE;

  const rec = reconcileStatement(
    input.accountType,
    input.openingBalance,
    input.closingBalance,
    input.parsedNet,
    balancesKnown,
  );

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql.run(
    `INSERT INTO statement_periods (
       id, user_id, account_id, session_id, file_id, source_file, institution, account_type,
       period_start, period_end, period_source, balances_known, opening_balance, closing_balance,
       total_fees, total_interest, transaction_count, parsed_net, expected_net, discrepancy,
       reconciled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.userId, input.accountId, input.sessionId, input.fileId, input.sourceFile,
    input.institution, input.accountType,
    periodStart, periodEnd, periodSource,
    balancesKnown ? 1 : 0,
    balancesKnown ? round2(input.openingBalance) : null,
    balancesKnown ? round2(input.closingBalance) : null,
    round2(input.totalFees), round2(input.totalInterest),
    input.transactionCount, round2(input.parsedNet),
    rec.expectedNet, rec.discrepancy,
    rec.reconciled === null ? null : rec.reconciled ? 1 : 0,
    now,
  );

  return {
    id,
    user_id: input.userId,
    account_id: input.accountId,
    session_id: input.sessionId,
    file_id: input.fileId,
    source_file: input.sourceFile,
    institution: input.institution,
    account_type: input.accountType,
    period_start: periodStart,
    period_end: periodEnd,
    period_source: periodSource,
    balances_known: balancesKnown ? 1 : 0,
    opening_balance: balancesKnown ? round2(input.openingBalance) : null,
    closing_balance: balancesKnown ? round2(input.closingBalance) : null,
    total_fees: round2(input.totalFees),
    total_interest: round2(input.totalInterest),
    transaction_count: input.transactionCount,
    parsed_net: round2(input.parsedNet),
    expected_net: rec.expectedNet,
    discrepancy: rec.discrepancy,
    reconciled: rec.reconciled === null ? null : rec.reconciled ? 1 : 0,
    created_at: now,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The real statement period for an uploaded file, for date-guard anchoring.
 * Only 'statement'-sourced periods are hard anchors; 'derived' ranges came
 * from the rows themselves and must not validate those same rows.
 */
export async function getStatementPeriodForFile(
  sql: Sql,
  userId: string,
  fileId: string,
): Promise<StatementPeriodRow | undefined> {
  await ensureStatementSchema(sql);
  return await sql.get<StatementPeriodRow>(
    `SELECT * FROM statement_periods WHERE user_id = ? AND file_id = ? ORDER BY created_at DESC LIMIT 1`,
    userId, fileId,
  );
}

/** All persisted statement periods for a user, newest period first. */
export async function listStatementPeriods(sql: Sql, userId: string): Promise<StatementPeriodRow[]> {
  await ensureStatementSchema(sql);
  return await sql.all<StatementPeriodRow>(
    `SELECT * FROM statement_periods
     WHERE user_id = ?
     ORDER BY CASE WHEN period_end IS NULL THEN 1 ELSE 0 END, period_end DESC, created_at DESC`,
    userId,
  );
}

/** Cleanup hook for DELETE /upload/sessions/:id. */
export async function deleteStatementPeriodsForSession(sql: Sql, userId: string, sessionId: string): Promise<void> {
  await ensureStatementSchema(sql);
  await sql.run(`DELETE FROM statement_periods WHERE user_id = ? AND session_id = ?`, userId, sessionId);
}

/** Human-readable reconciliation summary for API responses. */
export function describeReconciliation(row: StatementPeriodRow): string {
  if (row.reconciled === null) {
    return 'Not checkable: the statement did not print opening/closing balances (or they could not be extracted).';
  }
  if (row.reconciled === 1) {
    return `Reconciled: ${row.transaction_count} parsed transactions sum from the opening to the closing balance (within $${RECONCILE_TOLERANCE.toFixed(2)}).`;
  }
  const gap = row.discrepancy ?? 0;
  return `DISCREPANCY: parsed transactions sum $${Math.abs(gap).toFixed(2)} away from the statement's opening→closing balance change — parsing likely missed or mis-signed rows. Review the original file.`;
}
