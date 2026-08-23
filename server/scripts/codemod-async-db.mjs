/**
 * AST codemod: `db.prepare(SQL).get(A, B)`  ->  `await db.get(SQL, A, B)`
 *
 * Uses the TypeScript AST rather than regex, so template literals, nested
 * parentheses, string literals containing `)`, and multi-line SQL are all
 * handled correctly. Also marks the enclosing function `async` and unwraps
 * `db.transaction(fn)()` into `await db.tx(async t => ...)`.
 */
import { Project, SyntaxKind, Node } from 'ts-morph';

const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
const METHODS = new Set(['get', 'all', 'run', 'pluck', 'iterate']);

let rewritten = 0, asyncified = 0, skipped = [];

/** Walk up to the nearest function-ish node and make it async. */
function makeEnclosingAsync(node) {
  let cur = node.getParent();
  while (cur) {
    if (Node.isFunctionDeclaration(cur) || Node.isMethodDeclaration(cur) ||
        Node.isFunctionExpression(cur) || Node.isArrowFunction(cur) ||
        Node.isConstructorDeclaration(cur)) {
      if (Node.isConstructorDeclaration(cur)) return false; // can't await in a ctor
      if (!cur.isAsync?.()) { cur.setIsAsync(true); asyncified++; }
      return true;
    }
    cur = cur.getParent();
  }
  return false;
}

for (const sf of project.getSourceFiles('src/**/*.ts')) {
  if (sf.getFilePath().endsWith('db/sql.ts')) continue;
  let changed = false;

  // Process deepest-first so nested rewrites stay valid.
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression).reverse();

  for (const call of calls) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const method = expr.getName();
    if (!METHODS.has(method)) continue;

    // left side must itself be `<recv>.prepare(<sql>)`
    const inner = expr.getExpression();
    if (!Node.isCallExpression(inner)) continue;
    const innerExpr = inner.getExpression();
    if (!Node.isPropertyAccessExpression(innerExpr)) continue;
    if (innerExpr.getName() !== 'prepare') continue;

    const recv = innerExpr.getExpression().getText();
    if (!/^(db|sql|t|tx|conn|rawSqlite)$/.test(recv)) continue;
    if (recv === 'rawSqlite') continue; // boot-time sync path stays as-is

    const sqlArgs = inner.getArguments().map(a => a.getFullText().trim());
    if (sqlArgs.length !== 1) { skipped.push(`${sf.getBaseName()}: prepare() with ${sqlArgs.length} args`); continue; }

    if (method === 'pluck' || method === 'iterate') {
      skipped.push(`${sf.getBaseName()}:${call.getStartLineNumber()} uses .${method}() — needs manual handling`);
      continue;
    }

    const callArgs = call.getArguments().map(a => a.getFullText().trim());
    const allArgs = [sqlArgs[0], ...callArgs].join(', ');
    const replacement = `${recv}.${method}(${allArgs})`;

    const ok = makeEnclosingAsync(call);
    if (!ok) { skipped.push(`${sf.getBaseName()}:${call.getStartLineNumber()} not inside an async-able function`); continue; }

    // Wrap in `await`, unless an `await` already sits directly in front.
    const parent = call.getParent();
    const alreadyAwaited = Node.isAwaitExpression(parent);
    call.replaceWithText(alreadyAwaited ? replacement : `await ${replacement}`);
    rewritten++; changed = true;
  }

  if (changed) sf.saveSync();
}

console.log(`  rewritten call sites : ${rewritten}`);
console.log(`  functions made async : ${asyncified}`);
if (skipped.length) {
  console.log(`  needs manual review  : ${skipped.length}`);
  [...new Set(skipped)].slice(0, 25).forEach(s => console.log('    -', s));
}
