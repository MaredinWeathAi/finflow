/**
 * Token vault — envelope encryption for provider access tokens.
 *
 * HARD RULES (enforced by convention here and by code review):
 *   1. Provider tokens NEVER leave the server. No API route may serialize any
 *      token_* / dek_* column; connection routes must use explicit column
 *      lists, never `SELECT *`, when reading provider_connections.
 *   2. Tokens are NEVER logged — not in console.log, not in sync_runs.error,
 *      not in audit_log detail. If a token must be referenced for debugging,
 *      use `redact()` which yields a correlatable digest, never the value.
 *   3. Decrypt just-in-time inside the sync engine, use, and drop. Never cache
 *      a plaintext token in module state, and never return one to the client.
 *      (A Plaid access_token or SimpleFIN access URL is a bearer credential:
 *      anyone holding it can read the user's full financial history from
 *      anywhere. Teller tokens are additionally useless without our mTLS
 *      client certificate, but all tokens are treated uniformly.)
 *
 * SCHEME — envelope encryption, AES-256-GCM at both layers:
 *   - Each sealed record gets a fresh random 32-byte DEK (data-encryption key).
 *   - The token is encrypted with the DEK.
 *   - The DEK is wrapped (encrypted) with the KEK (key-encryption key) from
 *     `getKekV1()` in src/config/security.ts. Do NOT read key material from
 *     anywhere else — key sourcing/persistence is security.ts's job.
 *   - Both layers use AAD bound to the connection id, so a ciphertext copied
 *     into another connection's row fails authentication on decrypt.
 *   - Compromise of one row's DEK exposes one token; rotating the KEK later
 *     only requires re-wrapping DEKs, not re-encrypting tokens.
 *
 * DESIGN-DOC DISCREPANCY (doc §3 vs shipped code — code wins):
 *   The design doc loads multiple `FINFLOW_KEK_Vn` env keys at import time and
 *   fails the boot if none exist. The shipped code (Phase 1/2) instead exposes
 *   exactly one KEK via `getKekV1()`, resolved by `initSecurity()` from env or
 *   a persisted app_config secret, and derived to 32 bytes via SHA-256. This
 *   module therefore supports kekVersion 1 only, resolves the KEK lazily at
 *   call time (so importing this file has no side effects and no boot-order
 *   requirement beyond initSecurity()), and `openToken` fails loudly on any
 *   other version. When KEK rotation ships, add getKekV2() to security.ts and
 *   extend `kekForVersion` + a rewrap job — token ciphertexts stay untouched.
 *
 *   Storage note: the doc's DDL used Postgres `bytea`; because the app runs on
 *   SQLite today and is mid-migration to Postgres, the sealed fields here are
 *   base64 TEXT, which round-trips identically through both drivers.
 */
import crypto from 'node:crypto';
import { getKekV1 } from '../config/security.js';

export const CURRENT_KEK_VERSION = 1;

/** All fields base64-encoded; store 1:1 into provider_connections token columns. */
export interface SealedToken {
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  dekWrapped: string;
  dekIv: string;
  dekTag: string;
  kekVersion: number;
}

export class VaultError extends Error {
  constructor(message: string) { super(message); this.name = 'VaultError'; }
}

function kekForVersion(version: number): Buffer {
  if (version === CURRENT_KEK_VERSION) {
    const kek = getKekV1(); // throws if initSecurity() has not run — correct: fail closed
    if (kek.length !== 32) throw new VaultError('KEK must be exactly 32 bytes');
    return kek;
  }
  throw new VaultError(`KEK version ${version} is not available — cannot decrypt this record`);
}

/**
 * AAD binds a ciphertext to its row and purpose: moving token columns between
 * provider_connections rows (or reusing them in another context) fails the
 * GCM auth check instead of decrypting under the wrong identity.
 */
function aadFor(connectionId: string): Buffer {
  if (!connectionId) throw new VaultError('connectionId is required');
  return Buffer.from(`finflow:provider_token:${connectionId}`, 'utf8');
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ct: Buffer, iv: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Encrypt a provider access token for storage on a specific connection row. */
export function sealToken(connectionId: string, plaintext: string): SealedToken {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new VaultError('cannot seal an empty token');
  }
  const aad = aadFor(connectionId);
  const dek = crypto.randomBytes(32);
  try {
    const t = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), aad);
    const w = gcmEncrypt(kekForVersion(CURRENT_KEK_VERSION), dek, aad);
    return {
      tokenCiphertext: t.ct.toString('base64'),
      tokenIv: t.iv.toString('base64'),
      tokenTag: t.tag.toString('base64'),
      dekWrapped: w.ct.toString('base64'),
      dekIv: w.iv.toString('base64'),
      dekTag: w.tag.toString('base64'),
      kekVersion: CURRENT_KEK_VERSION,
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypt a sealed token. Throws VaultError (never partial plaintext) if the
 * connection id does not match the one it was sealed for, if any component was
 * tampered with, or if the KEK version is unknown.
 */
export function openToken(connectionId: string, sealed: SealedToken): string {
  const aad = aadFor(connectionId);
  const kek = kekForVersion(sealed.kekVersion);
  let dek: Buffer | null = null;
  try {
    dek = gcmDecrypt(
      kek,
      Buffer.from(sealed.dekWrapped, 'base64'),
      Buffer.from(sealed.dekIv, 'base64'),
      Buffer.from(sealed.dekTag, 'base64'),
      aad,
    );
    const plain = gcmDecrypt(
      dek,
      Buffer.from(sealed.tokenCiphertext, 'base64'),
      Buffer.from(sealed.tokenIv, 'base64'),
      Buffer.from(sealed.tokenTag, 'base64'),
      aad,
    );
    return plain.toString('utf8');
  } catch (err) {
    if (err instanceof VaultError) throw err;
    // Deliberately generic: do not leak which layer or which component failed.
    throw new VaultError('token decryption failed (wrong connection, tampered data, or wrong key)');
  } finally {
    dek?.fill(0);
  }
}

/**
 * Safe stand-in for a secret in logs/errors: a short digest that lets two log
 * lines be correlated ("same token?") without revealing ANY part of the value.
 */
export function redact(secret: string | null | undefined): string {
  if (!secret) return '[redacted:empty]';
  const digest = crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
  return `[redacted:${digest}]`;
}
