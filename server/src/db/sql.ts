/**
 * Driver-agnostic async data layer.
 *
 * WHY THIS EXISTS
 * The app was written against better-sqlite3's synchronous API
 * (`db.prepare(sql).get(...)`). Postgres drivers are asynchronous, so moving to
 * Railway Postgres means every one of ~311 call sites has to await.
 *
 * This adapter keeps the *exact same call shape* and only changes the return
 * type to a Promise. That makes the migration mechanical AND compiler-verified:
 * any call site that forgets `await` produces a `Promise<T>` where `T` is
 * expected, which is a type error. In a financial app, having the compiler find
 * every missed await is worth more than any amount of careful reading.
 *
 * The SQLite driver resolves immediately, so switching the codebase to async
 * while still running on SQLite is a behaviour-preserving change that can be
 * deployed and verified on its own, before Postgres is introduced.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

export type Driver = 'sqlite' | 'postgres';

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

/**
 * Flat query surface. There is deliberately NO `prepare()`.
 *
 * The original code called `db.prepare(sql).get(...)` and cast the result with
 * `as any`. If this adapter kept that shape, a forgotten `await` would produce
 * `Promise<T> as any` — which type-checks fine and silently corrupts data.
 * Removing `prepare` forces every call site to be rewritten, and the checker in
 * `scripts/check-await.mjs` then proves each one is awaited.
 */
export interface Sql {
  readonly driver: Driver;
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  tx<T>(fn: (t: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQL translation (only applied for the Postgres driver)
// ---------------------------------------------------------------------------

/**
 * Rewrite `?` placeholders to `$1, $2, ...`, skipping any `?` that appears
 * inside a string literal, a quoted identifier, or a comment.
 */
export function toPositional(sql: string): string {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      const quote = c;
      out += c; i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) { out += quote + quote; i += 2; continue; }
        out += sql[i];
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += sql[i]; i++; }
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
      out += '*/'; i += 2;
      continue;
    }

    if (c === '?') { n++; out += '$' + n; i++; continue; }

    out += c; i++;
  }
  return out;
}

/** Translate the handful of SQLite-isms this codebase actually uses. */
export function toPostgresDialect(sql: string): string {
  let s = sql;

  // INSERT OR IGNORE INTO x (...) VALUES (...)  ->  ... ON CONFLICT DO NOTHING
  if (/insert\s+or\s+ignore\s+into/i.test(s)) {
    s = s.replace(/insert\s+or\s+ignore\s+into/gi, 'INSERT INTO');
    if (!/on\s+conflict/i.test(s)) s = s.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  // INSERT OR REPLACE -> upsert is ambiguous without a conflict target; the
  // codebase does not use it, so fail loudly rather than guess.
  if (/insert\s+or\s+replace/i.test(s)) {
    throw new Error('INSERT OR REPLACE has no safe automatic Postgres translation — rewrite with an explicit ON CONFLICT target.');
  }

  // date('now', 'start of month') -> first day of the current month as TEXT
  s = s.replace(/date\(\s*'now'\s*,\s*'start of month'\s*\)/gi,
                "to_char(date_trunc('month', now()), 'YYYY-MM-DD')");
  s = s.replace(/date\(\s*'now'\s*\)/gi, "to_char(now(), 'YYYY-MM-DD')");

  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bAUTOINCREMENT\b/gi, '');
  s = s.replace(/\bGROUP_CONCAT\s*\(/gi, 'string_agg(');

  return s;
}

/** Translate a CREATE TABLE / CREATE INDEX script written for SQLite. */
export function translateDdl(ddl: string): string {
  let s = ddl;
  s = s.replace(/\bREAL\b/gi, 'double precision');
  s = s.replace(/\bBLOB\b/gi, 'bytea');
  s = s.replace(/\bAUTOINCREMENT\b/gi, '');
  s = s.replace(/\bDATETIME\b/gi, 'text');
  // SQLite tolerates a trailing comma before ')' in some scripts; Postgres does not.
  s = s.replace(/,(\s*\))/g, '$1');
  return s;
}

// ---------------------------------------------------------------------------
// SQLite driver
// ---------------------------------------------------------------------------

export class SqliteSql implements Sql {
  readonly driver = 'sqlite' as const;
  constructor(private db: SqliteDatabase) {}

  async get<T = any>(sql: string, ...p: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(p as any[])) as T | undefined;
  }
  async all<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(p as any[])) as T[];
  }
  async run(sql: string, ...p: unknown[]): Promise<RunResult> {
    const r = this.db.prepare(sql).run(...(p as any[]));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  async exec(sql: string): Promise<void> { this.db.exec(sql); }
  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    // better-sqlite3's own transaction() helper cannot wrap async work, so the
    // transaction is driven manually. Calls inside `fn` resolve synchronously
    // under this driver, so no other statement can interleave.
    this.db.exec('BEGIN');
    try {
      const out = await fn(this);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
  async close(): Promise<void> { this.db.close(); }
  /** Escape hatch for the one-shot migrator, which needs raw table access. */
  get raw(): SqliteDatabase { return this.db; }
}

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------

interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}
interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}

function prepareForPg(sql: string): string {
  return toPositional(toPostgresDialect(sql));
}

/** Translated SQL is cached — the translation is pure and the strings are static. */
const pgCache = new Map<string, string>();
function pgSql(sql: string): string {
  let t = pgCache.get(sql);
  if (t === undefined) { t = prepareForPg(sql); pgCache.set(sql, t); }
  return t;
}

export class PostgresSql implements Sql {
  readonly driver = 'postgres' as const;
  constructor(private pool: PgPoolLike, private client?: PgClientLike) {}
  private exec_ = (t: string, v: unknown[]) =>
    (this.client ?? this.pool).query(t, v as unknown[]);

  async get<T = any>(sql: string, ...p: unknown[]): Promise<T | undefined> {
    const r = await this.exec_(pgSql(sql), p);
    return r.rows[0] as T | undefined;
  }
  async all<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
    const r = await this.exec_(pgSql(sql), p);
    return r.rows as T[];
  }
  async run(sql: string, ...p: unknown[]): Promise<RunResult> {
    const r = await this.exec_(pgSql(sql), p);
    return { changes: r.rowCount ?? 0 };
  }
  async exec(sql: string): Promise<void> { await this.exec_(translateDdl(sql), []); }

  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresSql(this.pool, client);
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
