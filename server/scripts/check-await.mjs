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
const problems = [];
let ok = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  for (const m of src.matchAll(CALL)) {
    const idx = m.index + m[1].length;
    const before = src.slice(Math.max(0, idx - 260), idx);

    // Acceptable forms: `await db.get(`, `return await`, `void db.run(`,
    // and a promise that is explicitly chained/handled.
    const awaited = /\bawait\s*$/.test(before) || /\bawait\s+\(\s*$/.test(before);
    const voided  = /\bvoid\s*$/.test(before);
    const line    = src.slice(0, idx).split('\n').length;
    const text    = lines[line - 1] ?? '';
    const chained = /\)\s*\.(then|catch|finally)\s*\(/.test(text);

    if (awaited || voided || chained) { ok++; continue; }
    problems.push(`${file}:${line}  ${text.trim().slice(0, 96)}`);
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
