import assert from 'node:assert/strict';
import { toPositional, toPostgresDialect, translateDdl } from '../dist/db/sql.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); } };

// --- placeholder rewriting ---
t('simple placeholders', () =>
  assert.equal(toPositional('SELECT * FROM t WHERE a = ? AND b = ?'),
                            'SELECT * FROM t WHERE a = $1 AND b = $2'));

t('question mark inside a string literal is NOT a placeholder', () =>
  assert.equal(toPositional("SELECT * FROM t WHERE note = 'why?' AND id = ?"),
                            "SELECT * FROM t WHERE note = 'why?' AND id = $1"));

t('escaped quote inside string literal', () =>
  assert.equal(toPositional("SELECT 'it''s ok?' , ? FROM t"),
                            "SELECT 'it''s ok?' , $1 FROM t"));

t('question mark inside a line comment is skipped', () =>
  assert.equal(toPositional('SELECT ? -- what? \nFROM t WHERE x = ?'),
                            'SELECT $1 -- what? \nFROM t WHERE x = $2'));

t('question mark inside a block comment is skipped', () =>
  assert.equal(toPositional('SELECT ? /* huh? */ , ? FROM t'),
                            'SELECT $1 /* huh? */ , $2 FROM t'));

t('double-quoted identifier is skipped', () =>
  assert.equal(toPositional('SELECT "we?ird" , ? FROM t'),
                            'SELECT "we?ird" , $1 FROM t'));

t('IN (?,?,?) expands correctly', () =>
  assert.equal(toPositional('SELECT * FROM t WHERE id IN (?,?,?) AND u = ?'),
                            'SELECT * FROM t WHERE id IN ($1,$2,$3) AND u = $4'));

t('no placeholders is a no-op', () =>
  assert.equal(toPositional('SELECT 1'), 'SELECT 1'));

// --- dialect ---
t('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', () => {
  const out = toPostgresDialect("INSERT OR IGNORE INTO accounts (id, name) VALUES (?, ?)");
  assert.match(out, /^INSERT INTO accounts/);
  assert.match(out, /ON CONFLICT DO NOTHING$/);
});

t('INSERT OR REPLACE throws rather than guessing', () =>
  assert.throws(() => toPostgresDialect('INSERT OR REPLACE INTO t VALUES (?)'), /no safe automatic/));

t("date('now','start of month') is translated", () => {
  const out = toPostgresDialect("SELECT * FROM t WHERE date >= date('now', 'start of month')");
  assert.match(out, /date_trunc\('month', now\(\)\)/);
  assert.doesNotMatch(out, /'start of month'/);
});

t('IFNULL becomes COALESCE', () =>
  assert.match(toPostgresDialect('SELECT IFNULL(a,0) FROM t'), /COALESCE\(a,0\)/));

t('ordinary SQL passes through untouched', () => {
  const q = 'SELECT t.id, SUM(ABS(t.amount)) FROM transactions t WHERE t.user_id = ? GROUP BY t.id';
  assert.equal(toPostgresDialect(q), q);
});

t('LIKE becomes ILIKE so Postgres matches SQLite case-insensitivity', () => {
  const out = toPostgresDialect("SELECT * FROM t WHERE name LIKE ?");
  assert.match(out, /ILIKE/);
  assert.doesNotMatch(out, /[^I]LIKE/);
});

t('NOT LIKE survives the ILIKE rewrite', () =>
  assert.match(toPostgresDialect('SELECT * FROM t WHERE a NOT LIKE ?'), /NOT ILIKE/));

t('quoted camelCase alias survives translation and placeholder rewriting', () => {
  const q = 'SELECT MIN(date) as "minDate", SUM(x) as "totalIncome" FROM t WHERE u = ?';
  const out = toPositional(toPostgresDialect(q));
  assert.match(out, /"minDate"/);
  assert.match(out, /"totalIncome"/);
  assert.match(out, /\$1/);
});

// --- DDL ---
t('REAL becomes double precision', () =>
  assert.match(translateDdl('CREATE TABLE t (amount REAL NOT NULL)'), /double precision/));

t('trailing comma before paren is removed', () =>
  assert.equal(translateDdl('CREATE TABLE t (a TEXT, b TEXT,\n)').replace(/\s+/g,' '),
               'CREATE TABLE t (a TEXT, b TEXT )'));

// --- the real thing: every literal SQL string in the codebase survives a round trip ---
console.log(`\n  unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
