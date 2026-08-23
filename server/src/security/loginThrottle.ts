/**
 * Per-account login throttling with exponential backoff.
 *
 * IP-based rate limiting (express-rate-limit) handles volumetric attacks;
 * this handles a distributed low-and-slow attack against one account.
 */
import { db } from '../db/database.js';

const LOCK_THRESHOLD = 5;
const MAX_LOCK_MINUTES = 60;

export interface LockState { locked: boolean; until?: string; remainingMs?: number }

export async function checkLock(userId: string): LockState {
  try {
    const row = await db.get('SELECT locked_until FROM users WHERE id = ?', userId) as { locked_until: string | null } | undefined;
    if (!row?.locked_until) return { locked: false };
    const until = new Date(row.locked_until).getTime();
    if (Number.isNaN(until) || until <= Date.now()) return { locked: false };
    return { locked: true, until: row.locked_until, remainingMs: until - Date.now() };
  } catch {
    return { locked: false };
  }
}

export async function recordFailure(userId: string): LockState {
  try {
    const row = await db.get('SELECT failed_login_count FROM users WHERE id = ?', userId) as { failed_login_count: number | null } | undefined;
    const count = (row?.failed_login_count ?? 0) + 1;

    let lockedUntil: string | null = null;
    if (count >= LOCK_THRESHOLD) {
      // 1, 2, 4, 8 ... minutes, capped
      const minutes = Math.min(2 ** (count - LOCK_THRESHOLD), MAX_LOCK_MINUTES);
      lockedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    }

    await db.run('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?', count, lockedUntil, userId);

    return lockedUntil ? { locked: true, until: lockedUntil } : { locked: false };
  } catch {
    return { locked: false };
  }
}

export async function recordSuccess(userId: string): void {
  try {
    await db.run('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', new Date().toISOString(), userId);
  } catch { /* non-fatal */ }
}
