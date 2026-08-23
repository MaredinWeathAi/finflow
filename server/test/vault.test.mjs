/**
 * Unit tests for the provider-token vault (src/providers/vault.ts).
 *
 * Runs against the COMPILED output (dist/), like the other test files, and
 * exercises the real key path: FINFLOW_KEK_V1 env -> initSecurity() ->
 * getKekV1() -> seal/open. A throwaway SQLite database in a temp dir backs the
 * import of db/database.js (never the repo's finflow.db).
 *
 * Run: node --test test/vault.test.mjs   (also works as: node test/vault.test.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env must be set BEFORE the app modules load: database.js opens its SQLite
// file at import time, and initSecurity() prefers env over the database.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'finflow-vault-test-')), 'test.db');
process.env.FINFLOW_KEK_V1 = 'vault-test-kek-0123456789abcdef-0123456789abcdef'; // >= 32 chars

const security = await import('../dist/config/security.js');
await security.initSecurity();
const { sealToken, openToken, redact, CURRENT_KEK_VERSION, VaultError } =
  await import('../dist/providers/vault.js');

const CONNECTION_ID = 'conn-11111111-2222-3333-4444-555555555555';
const TOKEN = 'token_live_abcDEF123_secret_do_not_log';

/** Flip one bit in the middle of a base64 field. */
function corrupt(b64) {
  const buf = Buffer.from(b64, 'base64');
  buf[Math.floor(buf.length / 2)] ^= 0x01;
  return buf.toString('base64');
}

test('round-trip: sealToken then openToken returns the original plaintext', () => {
  const sealed = sealToken(CONNECTION_ID, TOKEN);
  assert.equal(sealed.kekVersion, CURRENT_KEK_VERSION);
  for (const field of ['tokenCiphertext', 'tokenIv', 'tokenTag', 'dekWrapped', 'dekIv', 'dekTag']) {
    assert.equal(typeof sealed[field], 'string');
    assert.ok(sealed[field].length > 0, `${field} must be non-empty`);
  }
  assert.equal(openToken(CONNECTION_ID, sealed), TOKEN);
});

test('sealing is non-deterministic (fresh DEK + IVs per record)', () => {
  const a = sealToken(CONNECTION_ID, TOKEN);
  const b = sealToken(CONNECTION_ID, TOKEN);
  assert.notEqual(a.tokenCiphertext, b.tokenCiphertext);
  assert.notEqual(a.dekWrapped, b.dekWrapped);
  assert.equal(openToken(CONNECTION_ID, a), TOKEN);
  assert.equal(openToken(CONNECTION_ID, b), TOKEN);
});

test('ciphertext is bound to the connection id (AAD): another id fails to decrypt', () => {
  const sealed = sealToken(CONNECTION_ID, TOKEN);
  assert.throws(() => openToken('conn-other', sealed), VaultError);
  // and the failure never yields partial plaintext
  try { openToken('conn-other', sealed); } catch (err) {
    assert.ok(!String(err.message).includes(TOKEN));
  }
});

test('tampered token ciphertext fails to decrypt', () => {
  const sealed = sealToken(CONNECTION_ID, TOKEN);
  const evil = { ...sealed, tokenCiphertext: corrupt(sealed.tokenCiphertext) };
  assert.throws(() => openToken(CONNECTION_ID, evil), VaultError);
});

test('tampered auth tag fails to decrypt (token layer and DEK layer)', () => {
  const sealed = sealToken(CONNECTION_ID, TOKEN);
  assert.throws(() => openToken(CONNECTION_ID, { ...sealed, tokenTag: corrupt(sealed.tokenTag) }), VaultError);
  assert.throws(() => openToken(CONNECTION_ID, { ...sealed, dekTag: corrupt(sealed.dekTag) }), VaultError);
});

test('a swapped wrapped DEK from another record fails to decrypt', () => {
  const a = sealToken(CONNECTION_ID, TOKEN);
  const b = sealToken(CONNECTION_ID, 'another-token-entirely');
  const franken = { ...a, dekWrapped: b.dekWrapped, dekIv: b.dekIv, dekTag: b.dekTag };
  assert.throws(() => openToken(CONNECTION_ID, franken), VaultError);
});

test('unknown KEK version fails loudly instead of trying the wrong key', () => {
  const sealed = sealToken(CONNECTION_ID, TOKEN);
  assert.throws(() => openToken(CONNECTION_ID, { ...sealed, kekVersion: 99 }), VaultError);
});

test('empty token refuses to seal', () => {
  assert.throws(() => sealToken(CONNECTION_ID, ''), VaultError);
});

test('redact never reveals any part of the secret, and is stable per secret', () => {
  const r = redact(TOKEN);
  assert.match(r, /^\[redacted:[0-9a-f]{8}\]$/);
  for (let i = 0; i + 4 <= TOKEN.length; i++) {
    assert.ok(!r.includes(TOKEN.slice(i, i + 4)), 'redacted form must not contain token substrings');
  }
  assert.equal(redact(TOKEN), r);                    // correlatable
  assert.notEqual(redact('different'), r);
  assert.equal(redact(''), '[redacted:empty]');
  assert.equal(redact(null), '[redacted:empty]');
});
