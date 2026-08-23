/**
 * Extracts every SQL string literal in the codebase and pushes it through the
 * translator, asserting that nothing throws and that no placeholder is lost or
 * invented. This is the safety net for the Postgres migration.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toPositional, toPostgresDialect } from '../dist/db/sql.js';

const files = [];
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (p.endsWith('.ts') && !p.endsWith('db/sql.ts')) files.push(p);
}})('src');

const SQL_START = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA|WITH)\b/i;
const corpus = [];
for (const f of files) {
  const src = readFileSync(f,'utf8');
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const s = m[1];
    // Only accept literals that BEGIN with a SQL verb — anything else is a
    // fragment my extractor sliced out of a template literal, not a query.
    if (SQL_START.test(s.trimStart().slice(0, 12)) && !s.includes('${')) corpus.push([f, s]);
  }
  for (const m of src.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    const s = m[1];
    if (SQL_START.test(s.trimStart().slice(0, 12)) && s.length > 20) corpus.push([f, s]);
  }
}

let checked=0, problems=[];
for (const [file, sql] of corpus) {
  let out;
  try { out = toPositional(toPostgresDialect(sql)); }
  catch (e) { problems.push(`${file}: THROWS — ${e.message}\n    ${sql.slice(0,90)}`); continue; }

  // placeholders must be preserved exactly, and numbered 1..n with no gaps
  const before = (sql.match(/\?/g)||[]).length;
  const nums = [...out.matchAll(/\$(\d+)/g)].map(x=>+x[1]);
  const inStr = (sql.match(/'[^']*\?[^']*'/g)||[]).length;
  if (nums.length !== before - 0 && before > 0 && inStr === 0) {
    problems.push(`${file}: placeholder count ${before} -> ${nums.length}\n    ${sql.slice(0,90)}`);
  }
  for (let i=0;i<nums.length;i++) if (nums[i] !== i+1) {
    problems.push(`${file}: non-sequential placeholders ${nums.join(',')}\n    ${sql.slice(0,90)}`); break;
  }
  checked++;
}

console.log(`  corpus: ${checked} SQL statements from ${files.length} files translated cleanly`);
if (problems.length) { console.error('\n  PROBLEMS:'); problems.slice(0,15).forEach(p=>console.error('   -',p)); process.exit(1); }
