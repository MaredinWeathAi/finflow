/**
 * Central security configuration and boot-time guards.
 *
 * Design goals:
 *  - Never fail the deploy for a missing secret (that takes the app down); instead
 *    self-heal by generating a strong secret once and persisting it, and warn loudly.
 *  - Make insecure states *detectable and self-correcting* rather than silent.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';

export const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Durable app secrets (survive restarts, portable to Postgres)
// ---------------------------------------------------------------------------

async function readAppConfig(key: string): string | null {
  try {
    const row = await db.get('SELECT value FROM app_config WHERE key = ?', key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeAppConfig(key: string, value: string): void {
  try {
    await db.run(`INSERT INTO app_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, new Date().toISOString(), new Date().toISOString());
  } catch (err) {
    console.error('[security] failed to persist app_config key', key, err);
  }
}

/**
 * Resolve a secret from env, else from the durable app_config table, else
 * generate one and persist it.
 *
 * Resolution is LAZY and memoised: `app_config` does not exist until initDb()
 * has run, and this module is imported before that. Resolving eagerly would
 * mint a fresh secret on every boot and silently sign every user out on every
 * deploy.
 */
const secretCache = new Map<string, { value: string; source: string }>();

function resolveDurableSecret(envName: string, configKey: string, bytes = 48): { value: string; source: string } {
  const cached = secretCache.get(configKey);
  if (cached) return cached;

  const fromEnv = process.env[envName];
  let result: { value: string; source: string };

  if (fromEnv && fromEnv.length >= 32) {
    result = { value: fromEnv, source: 'env' };
  } else {
    if (fromEnv && fromEnv.length < 32) {
      console.warn(`[security] ${envName} is set but shorter than 32 characters — ignoring it. Set a longer value.`);
    }
    const stored = readAppConfig(configKey);
    if (stored) {
      result = { value: stored, source: 'database' };
    } else {
      const generated = crypto.randomBytes(bytes).toString('base64url');
      writeAppConfig(configKey, generated);
      // If the write failed the table isn't ready; don't cache a value that
      // won't survive, so the next call can try again.
      if (readAppConfig(configKey) !== generated) {
        console.error(`[security] could not persist ${configKey}; using an ephemeral secret for now.`);
        return { value: generated, source: 'ephemeral' };
      }
      result = { value: generated, source: 'generated' };
    }
  }

  secretCache.set(configKey, result);
  return result;
}

export function getJwtSecret(): string {
  return resolveDurableSecret('JWT_SECRET', 'jwt_secret').value;
}

export function getJwtSecretSource(): string {
  return resolveDurableSecret('JWT_SECRET', 'jwt_secret').source;
}

/** Key-encryption key for provider access tokens (bank aggregation). */
export function getKekV1(): Buffer {
  const { value } = resolveDurableSecret('FINFLOW_KEK_V1', 'kek_v1', 32);
  return crypto.createHash('sha256').update(value).digest(); // always exactly 32 bytes
}

export function getKekSource(): string {
  return resolveDurableSecret('FINFLOW_KEK_V1', 'kek_v1', 32).source;
}

export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_TTL_SECONDS = 60 * 60 * 12; // 12h — was 7d
export const BCRYPT_ROUNDS = 12;             // was 10

/** Origins permitted for cross-origin API access. Same-origin always works. */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Self-service registration is OFF in production unless explicitly enabled. */
export const ALLOW_SELF_REGISTRATION =
  process.env.ALLOW_SELF_REGISTRATION === 'true' || !IS_PROD;

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/** Passwords known to have shipped in this repo's seed data or common lists. */
const KNOWN_WEAK_PASSWORDS = [
  'demo123', 'password123', 'password', 'admin', 'admin123', 'letmein',
  'changeme', 'welcome1', 'qwerty123', 'finflow', 'finflow123', 'test1234',
];

export interface PasswordCheck { ok: boolean; reason?: string }

export function validatePassword(password: unknown, email?: string): PasswordCheck {
  if (typeof password !== 'string') return { ok: false, reason: 'Password is required' };
  if (password.length < 12) return { ok: false, reason: 'Password must be at least 12 characters' };
  if (password.length > 200) return { ok: false, reason: 'Password must be under 200 characters' };
  const lower = password.toLowerCase();
  if (KNOWN_WEAK_PASSWORDS.some((w) => lower === w || lower.includes(w))) {
    return { ok: false, reason: 'That password is too common or was a known default. Choose another.' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) {
    return { ok: false, reason: 'Use at least three of: lowercase, uppercase, numbers, symbols' };
  }
  if (email) {
    const local = email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local)) {
      return { ok: false, reason: 'Password must not contain your email address' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Boot-time default-credential tripwire
// ---------------------------------------------------------------------------

/**
 * Self-healing guard for CVE-class finding C1.
 *
 * This repo previously seeded `demo@finflow.com / demo123` and
 * `*@example.com / password123` — real accounts were adopted on top of those
 * hashes. On every boot we re-test every account against the known default
 * passwords. Any hit is flagged `must_change_password = 1`, which the auth
 * middleware enforces by blocking every route except the change-password flow.
 *
 * We deliberately do NOT rotate the password to a random value: that would lock
 * the legitimate owner out of their own data. Flagging closes the account to
 * useful work by an attacker while leaving the owner a path to recover.
 */
export async function enforceNoDefaultCredentials(): void {
  let flagged = 0;
  try {
    const users = await db.all('SELECT id, email, password_hash, must_change_password FROM users LIMIT 1000') as Array<{
      id: string; email: string; password_hash: string; must_change_password: number | null;
    }>;

    for (const u of users) {
      if (u.must_change_password) { flagged++; continue; }
      const hit = KNOWN_WEAK_PASSWORDS.find((candidate) => {
        try { return bcrypt.compareSync(candidate, u.password_hash); } catch { return false; }
      });
      if (hit) {
        await db.run(`UPDATE users SET must_change_password = 1, token_version = COALESCE(token_version, 0) + 1, updated_at = ? WHERE id = ?`, new Date().toISOString(), u.id);
        flagged++;
        console.error(
          `[security] DEFAULT CREDENTIAL DETECTED for account ${maskEmail(u.email)} — ` +
          `account locked to password-change-only and all existing sessions revoked.`
        );
      }
    }
  } catch (err) {
    console.error('[security] default-credential scan failed:', err);
  }

  if (flagged > 0) {
    console.error(`[security] ${flagged} account(s) must change their password before the app will serve them.`);
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Startup report
// ---------------------------------------------------------------------------

export function logSecurityPosture(): void {
  const lines: string[] = [];
  const source = getJwtSecretSource();
  lines.push(`  JWT secret source: ${source}`);
  if (source !== 'env') {
    lines.push('  ⚠ Set JWT_SECRET in Railway env for portability across databases.');
  }
  lines.push(`  Self-registration: ${ALLOW_SELF_REGISTRATION ? 'ENABLED' : 'disabled'}`);
  lines.push(`  CORS allowlist: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'same-origin only'}`);
  lines.push(`  Token TTL: ${JWT_TTL_SECONDS / 3600}h · bcrypt rounds: ${BCRYPT_ROUNDS}`);
  console.log('[security] posture:\n' + lines.join('\n'));
}
