/**
 * One-shot, idempotent SQLite → Postgres data migration.
 *
 * Runs INSIDE the Railway container at boot (the data never leaves Railway):
 * reads the production SQLite file through the raw synchronous handle, writes
 * to Postgres through the async adapter, all inside ONE transaction. A failure
 * anywhere — including a verification mismatch — rolls the whole thing back and
 * leaves Postgres untouched, so the caller can fall back to SQLite.
 *
 * Idempotency: once verification passes, `pg_migration_completed_at` is written
 * into `app_config` (inside the same transaction). Every later boot sees the
 * marker and returns immediately.
 */
import { rawSqlite, db, translateDdl } from './database.js';

const BATCH_SIZE = 500;
/** FP sums may differ in the last ulp because addition order differs. */
const SUM_TOLERANCE = 1e-6;

export interface MigrationResult {
  migrated: boolean;
  tables: Record<string, number>;
  reason?: string;
}

function quoteIdent(name: string): string {
  if (name.includes('"')) throw new Error(`Refusing to migrate table/column with '"' in its name: ${name}`);
  return `"${name}"`;
}

/**
 * Topologically sort tables so that every table is inserted after the tables
 * it references (edges come from PRAGMA foreign_key_list, so a table added
 * later is ordered correctly without anyone hand-maintaining a list).
 * Self-references are ignored here; they are handled by running the copy with
 * `SET CONSTRAINTS ALL DEFERRED` (the schema declares FKs DEFERRABLE).
 */
function topoSortTables(tables: string[]): string[] {
  const inSet = new Set(tables);
  const deps = new Map<string, Set<string>>(); // table -> tables it references
  for (const table of tables) {
    const fks = rawSqlite.pragma(`foreign_key_list(${quoteIdent(table)})`) as Array<{ table: string }>;
    const parents = new Set<string>();
    for (const fk of fks) {
      if (fk.table !== table && inSet.has(fk.table)) parents.add(fk.table);
    }
    deps.set(table, parents);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  let remaining = tables.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter(t2 => [...deps.get(t2)!].every(p => done.has(p)));
    if (ready.length === 0) {
      throw new Error(`Foreign-key cycle among tables: ${remaining.join(', ')} — cannot order inserts`);
    }
    ready.sort(); // deterministic order for logging
    for (const t2 of ready) { ordered.push(t2); done.add(t2); }
    remaining = remaining.filter(t2 => !done.has(t2));
  }
  return ordered;
}

export async function migrateSqliteToPostgres(): Promise<MigrationResult> {
  if (db.driver !== 'postgres') {
    return { migrated: false, tables: {}, reason: 'postgres driver not active' };
  }

  // Guard 1: already migrated?
  const marker = await db.get<{ value: string }>(
    'SELECT value FROM app_config WHERE key = ?', 'pg_migration_completed_at'
  );
  if (marker) return { migrated: false, tables: {}, reason: 'already done' };

  // Guard 2: is there anything real to migrate? (If the SQLite file was
  // missing, database.ts created an empty one, which has 0 users.)
  let sqliteUsers = 0;
  try {
    sqliteUsers = (rawSqlite.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  } catch {
    return { migrated: false, tables: {}, reason: 'sqlite has no users table — nothing to migrate' };
  }
  if (sqliteUsers === 0) {
    return { migrated: false, tables: {}, reason: 'sqlite has 0 users — nothing to migrate' };
  }

  // Discover tables from sqlite_master so a table added later is not dropped.
  const tableRows = rawSqlite.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string; sql: string }>;
  const createSqlByTable = new Map(tableRows.map(r => [r.name, r.sql]));
  const ordered = topoSortTables(tableRows.map(r => r.name));

  console.log(`[migrate] copying ${ordered.length} tables SQLite → Postgres (order: ${ordered.join(' → ')})`);

  const counts: Record<string, number> = {};

  await db.tx(async (t) => {
    // FKs are DEFERRABLE INITIALLY IMMEDIATE (see schema-pg.ts); defer them so
    // self-referencing rows (categories.parent_id, users.advisor_id) can be
    // inserted in any order. Checks run at COMMIT.
    await t.run('SET CONSTRAINTS ALL DEFERRED');

    for (const table of ordered) {
      // A table that exists in SQLite but not yet in Postgres (added after
      // schema-pg.ts was written): create it from its translated SQLite DDL
      // rather than silently dropping its data.
      const exists = await t.get<{ ok: string | null }>(
        'SELECT to_regclass(?) AS ok', `public.${table}`
      );
      if (!exists?.ok) {
        const createSql = createSqlByTable.get(table);
        if (!createSql) throw new Error(`[migrate] no CREATE TABLE sql for ${table}`);
        console.warn(`[migrate] table ${table} missing from schema-pg.ts — creating from translated SQLite DDL`);
        await t.exec(translateDdl(createSql));
      }

      const columns = (rawSqlite.pragma(`table_info(${quoteIdent(table)})`) as Array<{ name: string }>)
        .map(c => c.name);
      const rows = rawSqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<Record<string, unknown>>;
      counts[table] = rows.length;
      if (rows.length === 0) continue;

      const colList = columns.map(quoteIdent).join(', ');
      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        const tuple = `(${columns.map(() => '?').join(', ')})`;
        const insertSql =
          `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${batch.map(() => tuple).join(', ')}`;
        const params: unknown[] = [];
        for (const row of batch) for (const col of columns) params.push(row[col] ?? null);
        await t.run(insertSql, ...params);
      }
    }

    // ---- Verification (inside the transaction: any mismatch rolls it all back) ----
    for (const table of ordered) {
      const pgRow = await t.get<{ c: number | string }>(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`);
      const pgCount = Number(pgRow?.c ?? NaN);
      if (pgCount !== counts[table]) {
        throw new Error(`[migrate] VERIFY FAILED: ${table} row count sqlite=${counts[table]} postgres=${pgCount}`);
      }
    }

    // Row counts alone will not catch a truncated numeric — compare the sums
    // that matter most in a financial app.
    const sumChecks: Array<[string, string]> = [
      ['transactions', 'amount'],
      ['accounts', 'balance'],
    ];
    for (const [table, column] of sumChecks) {
      if (!counts[table]) continue;
      const liteSum = (rawSqlite.prepare(
        `SELECT COALESCE(SUM(${quoteIdent(column)}), 0) AS s FROM ${quoteIdent(table)}`
      ).get() as { s: number }).s;
      const pgRow = await t.get<{ s: number | string }>(
        `SELECT COALESCE(SUM(${quoteIdent(column)}), 0) AS s FROM ${quoteIdent(table)}`
      );
      const pgSum = Number(pgRow?.s ?? NaN);
      if (!Number.isFinite(pgSum) || Math.abs(pgSum - liteSum) > SUM_TOLERANCE) {
        throw new Error(
          `[migrate] VERIFY FAILED: SUM(${table}.${column}) sqlite=${liteSum} postgres=${pgSum}`
        );
      }
      console.log(`[migrate] verify SUM(${table}.${column}): sqlite=${liteSum} postgres=${pgSum} ✓`);
    }

    // Only after verification passes: record completion, in the same
    // transaction, so marker and data commit (or roll back) together.
    const now = new Date().toISOString();
    await t.run(
      'INSERT INTO app_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
      'pg_migration_completed_at', now, now, now
    );
  });

  console.log('[migrate] migration committed. Rows copied per table:');
  const width = Math.max(...Object.keys(counts).map(n => n.length));
  for (const table of ordered) {
    console.log(`[migrate]   ${table.padEnd(width)}  ${counts[table]}`);
  }
  return { migrated: true, tables: counts };
}
