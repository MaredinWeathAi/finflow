/**
 * Proves every database call is awaited.
 *
 * The codebase casts query results with `as any` in many places, which means
 * TypeScript alone cannot catch a forgotten `await` — `Promise<T> as any`
 * type-checks fine and then silently yields wrong numbers. This checker closes
 * that gap textually: every `db.get(`, `db.all(`, `db.run(`, `db.exec(` and
 * `db.tx(` must be immediately preceded by `await` (or be an explicit
 * `void`-ed / `.catch(`-handled promise).
 *
 * Run in CI and before every deploy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('db/sql.ts')) files.push(p);
  }
})(ROOT);

const CALL = /(^|[^.\w])((?:db|sql|t|tx|conn)\s*\.\s*(?:get|all|run|exec|tx))\s*\(/g;

/**
 * Every `export async function` in the project. Calls to these must be awaited
 * too — a forgotten await on one of these is invisible to TypeScript and shows
 * up as an endpoint returning `{}`.
 */
const ASYNC_EXPORTS = new Set();
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g)) {
    ASYNC_EXPORTS.add(m[1]);
  }
}
const problems = [];
let ok = 0;

/** Blank out comments and string/template literals so matches inside them are ignored. */
function stripNonCode(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += ' '; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === q) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const src = stripNonCode(raw);
  const lines = raw.split('\n');

  for (const m of src.matchAll(CALL)) {
    const idx = m.index + m[1].length;
    const before = src.slice(Math.max(0, idx - 260), idx);

    // Acceptable forms: `await db.get(`, `return await`, `void db.run(`,
    // and a promise that is explicitly chained/handled.
    const awaited = /\bawait\s*$/.test(before) || /\bawait\s+\(\s*$/.test(before);
    const voided  = /\bvoid\s*$/.test(before);
    const line    = src.slice(0, idx).split('\n').length;
    const text    = lines[line - 1] ?? '';
    // A chain may continue on the next lines:
    //   doThing(db)
    //     .then(...)
    //     .catch(...)
    // Look ahead past the call's own arguments for a .then/.catch/.finally.
    const ahead = src.slice(idx, idx + 400);
    const chained = /\)\s*\.(then|catch|finally)\s*\(/.test(text) ||
                    /\)[\s\n]*\.(then|catch|finally)\s*\(/.test(ahead);

    if (awaited || voided || chained) { ok++; continue; }
    problems.push(`${file}:${line}  ${text.trim().slice(0, 96)}`);
  }

  // Un-awaited calls to the project's own async functions. TypeScript cannot
  // catch these: `res.json(somePromise)` and `const x = f() as any` both
  // type-check, and the result serialises as `{}` — which is how the
  // /api/insights endpoint silently started returning an empty object.
  for (const fn of ASYNC_EXPORTS) {
    const re = new RegExp(`(^|[^.\\w])(${fn})\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const idx = m.index + m[1].length;
      const before = src.slice(Math.max(0, idx - 200), idx);
      if (/\b(await|function|export\s+async\s+function)\s*$/.test(before)) { ok++; continue; }
      if (/\bvoid\s*$/.test(before)) { ok++; continue; }
      // `return somePromise` is correct: the caller awaits it.
      if (/\breturn\s*$/.test(before)) { ok++; continue; }
      const line = src.slice(0, idx).split('\n').length;
      const text = (lines[line - 1] ?? '').trim();
      // definition sites and import statements are not calls
      if (/^(export\s+)?(async\s+)?function\b/.test(text)) continue;
      if (/^import\b/.test(text) || /\bfrom\s+['"]/.test(text)) continue;
      const ahead = src.slice(idx, idx + 400);
      if (/\)\s*\.(then|catch|finally)\s*\(/.test(text) ||
          /\)[\s\n]*\.(then|catch|finally)\s*\(/.test(ahead)) { ok++; continue; }
      problems.push(`${file}:${line}  un-awaited async call ${fn}()  ${text.slice(0, 80)}`);
    }
  }

  // Unquoted camelCase SQL aliases. Postgres folds unquoted identifiers to
  // lowercase, so `SELECT SUM(x) as totalIncome` arrives as `totalincome` and
  // `row.totalIncome` is undefined — a financial figure silently becomes 0.
  // Quoting the alias (`as "totalIncome"`) preserves the case on both engines.
  //
  // Only matches inside string literals count: `src` has strings blanked out, so
  // an index that is whitespace there but non-whitespace in `raw` was inside a
  // string. That distinguishes SQL from a multi-line TypeScript import alias.
  for (const m of raw.matchAll(/\bas\s+([a-z]+[A-Z][A-Za-z0-9_]*)/g)) {
    const i = m.index;
    const insideString = /\S/.test(raw[i]) && !/\S/.test(src[i] ?? ' ');
    if (!insideString) continue;
    const ctx = raw.slice(Math.max(0, i - 400), i + 100);
    if (!/\bSELECT\b/i.test(ctx)) continue;
    const line = raw.slice(0, i).split('\n').length;
    problems.push(`${file}:${line}  unquoted camelCase SQL alias "${m[1]}" — quote it or Postgres lowercases it`);
  }

  // SQLite lets HAVING reference a SELECT alias; Postgres evaluates HAVING
  // before the select list, so `HAVING cnt >= 5` fails with
  // `column "cnt" does not exist`. Require an aggregate or a grouped column.
  for (const m of raw.matchAll(/HAVING\s+([A-Za-z_][\w]*)\s*(>=|<=|>|<|=|<>)/g)) {
    const ident = m[1].toUpperCase();
    if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL'].includes(ident)) continue;
    const line = raw.slice(0, m.index).split('\n').length;
    problems.push(`${file}:${line}  HAVING references the alias "${m[1]}" — Postgres cannot see select aliases in HAVING; repeat the aggregate`);
  }

  // A bound parameter in arithmetic with a bare integer literal: Postgres infers
  // the parameter's type from the literal, so `? * 3` types it integer and
  // rejects a fractional value at runtime. Write `3.0` to keep it floating point.
  // Scoped to SQL strings so the TypeScript `??` operator is not mistaken for it.
  for (const m of raw.matchAll(/(?<!\?)\?\s*[*\/]\s*(\d+)(?![.\d])|(?<![.\d])(\d+)\s*[*\/]\s*\?(?!\?)/g)) {
    const i = m.index;
    const insideString = /\S/.test(raw[i]) && !/\S/.test(src[i] ?? ' ');
    if (!insideString) continue;
    const ctx = raw.slice(Math.max(0, i - 400), i + 100);
    if (!/\b(SELECT|WHERE|UPDATE|INSERT)\b/i.test(ctx)) continue;
    const line = raw.slice(0, i).split('\n').length;
    problems.push(`${file}:${line}  bound parameter in arithmetic with a bare integer literal (${m[0].trim()}) — use a decimal literal so Postgres infers a float`);
  }

  // A leftover prepare() means the file was not converted at all.
  for (const m of src.matchAll(/\bdb\s*\.\s*prepare\s*\(/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${file}:${line}  LEFTOVER db.prepare() — not converted`);
  }
}

if (problems.length) {
  console.error(`\n  ✗ ${problems.length} unawaited or unconverted database call(s):\n`);
  for (const p of problems.slice(0, 60)) console.error('    ' + p);
  if (problems.length > 60) console.error(`    ... and ${problems.length - 60} more`);
  console.error('');
  process.exit(1);
}
console.log(`  ✓ all ${ok} database calls are awaited (${files.length} files)`);
