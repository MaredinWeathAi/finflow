import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto, { randomUUID } from 'crypto';
import { db } from '../db/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import {
  BCRYPT_ROUNDS,
  ALLOW_SELF_REGISTRATION,
  validatePassword,
  maskEmail,
  IS_PROD,
} from '../config/security.js';
import { audit, clientIp } from '../security/audit.js';
import { checkLock, recordFailure, recordSuccess } from '../security/loginThrottle.js';

const router = Router();

/**
 * Pre-computed hash used to equalise response time when an account does not
 * exist, so /login cannot be used as an account-enumeration oracle.
 */
const DUMMY_HASH = bcrypt.hashSync('finflow-timing-equaliser', BCRYPT_ROUNDS);

/** Generic response body for every reset request, existent account or not. */
const RESET_ACK = { message: 'If an account exists for that address, a reset code has been sent.' };

function publicUser(u: any) {
  return {
    id: u.id,
    email: u.email,
    username: u.username ?? null,
    name: u.name,
    role: u.role ?? 'client',
    currency: u.currency ?? 'USD',
    created_at: u.created_at,
    must_change_password: !!u.must_change_password,
  };
}

function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------
router.post('/register', (req: Request, res: Response) => {
  try {
    if (!ALLOW_SELF_REGISTRATION) {
      audit('auth.register', req, { outcome: 'failure', detail: { reason: 'self_registration_disabled' } });
      res.status(403).json({
        error: 'Self-service registration is disabled. Ask your advisor to create your account.',
      });
      return;
    }

    // SECURITY: `role` is deliberately NOT destructured from the body. It was
    // previously honoured here, which let anyone mint an admin account.
    const { password, name, username } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    if (!email || !password || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'A valid email, password, and name are required' });
      return;
    }
    if (typeof username === 'string' && !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' });
      return;
    }

    const strength = validatePassword(password, email);
    if (!strength.ok) {
      res.status(400).json({ error: strength.reason });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      // Do not confirm existence. Respond as if it worked; the real owner is
      // unaffected and an enumerator learns nothing.
      audit('auth.register', req, { outcome: 'failure', detail: { reason: 'email_exists', email: maskEmail(email) } });
      res.status(202).json({ message: 'If that address is available, the account has been created. Try signing in.' });
      return;
    }

    if (username) {
      const takenUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (takenUsername) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
    }

    const id = randomUUID();
    const password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    // Role is server-assigned, always. Advisors are provisioned out-of-band.
    const userRole = 'client';

    const admin = db
      .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
      .get() as any;
    const advisorId: string | null = admin?.id ?? null;

    db.prepare(
      `INSERT INTO users (id, email, username, password_hash, name, role, advisor_id, currency,
                          token_version, must_change_password, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', 0, 0, ?, ?, ?)`
    ).run(id, email, username || null, password_hash, name.trim(), userRole, advisorId, now, now, now);

    const token = generateToken(id, email, userRole, 0);
    audit('auth.register', req, { userId: id, actorEmail: email });

    res.status(201).json({
      token,
      user: { id, email, username: username || null, name: name.trim(), role: userRole, currency: 'USD', created_at: now },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
router.post('/login', (req: Request, res: Response) => {
  try {
    const { password } = req.body ?? {};
    const rawIdentifier = req.body?.email ?? req.body?.username;

    if (typeof rawIdentifier !== 'string' || !rawIdentifier.trim() || typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Email or username and password are required' });
      return;
    }

    const identifier = rawIdentifier.trim();
    const asEmail = identifier.toLowerCase();

    const user = db
      .prepare('SELECT * FROM users WHERE lower(email) = ? OR username = ? LIMIT 1')
      .get(asEmail, identifier) as any;

    if (!user) {
      // Burn equivalent CPU so response time doesn't reveal account existence.
      bcrypt.compareSync(password, DUMMY_HASH);
      audit('auth.login.failure', req, { detail: { reason: 'no_such_account' } });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const lock = checkLock(user.id);
    if (lock.locked) {
      audit('auth.login.locked', req, { userId: user.id, outcome: 'failure' });
      res.status(429).json({
        error: 'Too many failed attempts. Try again shortly.',
        retryAfterSeconds: Math.ceil((lock.remainingMs ?? 60_000) / 1000),
      });
      return;
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      const state = recordFailure(user.id);
      audit('auth.login.failure', req, { userId: user.id, outcome: 'failure', detail: { locked: state.locked } });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    recordSuccess(user.id);

    // Opportunistically upgrade legacy bcrypt cost on successful login.
    try {
      if (bcrypt.getRounds(user.password_hash) < BCRYPT_ROUNDS) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run(bcrypt.hashSync(password, BCRYPT_ROUNDS), user.id);
      }
    } catch { /* non-fatal */ }

    const token = generateToken(user.id, user.email, user.role || 'client', user.token_version ?? 0);
    audit('auth.login.success', req, { userId: user.id, actorEmail: user.email });

    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// ---------------------------------------------------------------------------
// POST /logout — revokes every live token for this account
// ---------------------------------------------------------------------------
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  try {
    db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
      .run(req.user!.id);
    audit('auth.logout', req);
    res.json({ message: 'Signed out everywhere' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to sign out' });
  }
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = db
      .prepare(
        `SELECT id, email, username, name, role, currency, created_at, updated_at,
                must_change_password, last_login_at, totp_enabled
           FROM users WHERE id = ?`
      )
      .get(req.user!.id) as any;

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(publicUser(user));
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ---------------------------------------------------------------------------
// Reset-code delivery
// ---------------------------------------------------------------------------

/**
 * Deliver a reset code out-of-band. The code is NEVER returned in the HTTP
 * response — that was a full account-takeover vector.
 *
 * Channels, in order of preference:
 *   1. RESET_WEBHOOK_URL — POSTs {email, code, expiresAt} to a webhook you own
 *      (Zapier / Make / n8n / your own mailer). Zero extra dependencies.
 *   2. Server log — visible only to whoever controls the Railway deployment.
 */
async function deliverResetCode(email: string, code: string, expiresAt: string): Promise<void> {
  const hook = process.env.RESET_WEBHOOK_URL;
  if (hook) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(hook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.RESET_WEBHOOK_SECRET ? { 'X-FinFlow-Secret': process.env.RESET_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify({ email, code, expiresAt, app: 'FinFlow' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return;
    } catch (err) {
      console.error('[auth] reset webhook delivery failed, falling back to log:', (err as Error).message);
    }
  }

  // Fallback: the deployment log. Reaching it requires Railway access, i.e. the
  // owner. This is intentionally the only place the plaintext code ever appears.
  console.warn(
    `[auth] PASSWORD RESET CODE for ${maskEmail(email)} — ${code} — expires ${expiresAt}. ` +
    `Set RESET_WEBHOOK_URL to deliver these by email instead.`
  );
}

// ---------------------------------------------------------------------------
// POST /forgot-password
// ---------------------------------------------------------------------------
router.post('/forgot-password', async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);

  // Always the same body and status, whether or not the account exists.
  if (!email) {
    res.json(RESET_ACK);
    return;
  }

  try {
    const user = db.prepare('SELECT id, email FROM users WHERE lower(email) = ?').get(email) as any;
    if (!user) {
      audit('auth.password.reset.request', req, { outcome: 'failure', detail: { reason: 'no_such_account' } });
      res.json(RESET_ACK);
      return;
    }

    // Throttle: at most 3 outstanding unexpired codes per account.
    const outstanding = db
      .prepare('SELECT COUNT(*) as c FROM password_reset_tokens WHERE user_id = ? AND used = 0 AND expires_at > ?')
      .get(user.id, new Date().toISOString()) as any;
    if ((outstanding?.c ?? 0) >= 3) {
      audit('auth.password.reset.request', req, { userId: user.id, outcome: 'failure', detail: { reason: 'throttled' } });
      res.json(RESET_ACK);
      return;
    }

    // 8 chars of Crockford-ish base32 from a CSPRNG (~40 bits), not Math.random.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token, token_hash, expires_at, used, requested_ip, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(randomUUID(), user.id, codeHash, codeHash, expiresAt, clientIp(req), now);

    await deliverResetCode(user.email, code, expiresAt);
    audit('auth.password.reset.request', req, { userId: user.id });

    res.json(RESET_ACK);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.json(RESET_ACK); // never leak failure detail here either
  }
});

// ---------------------------------------------------------------------------
// POST /reset-password
// ---------------------------------------------------------------------------
router.post('/reset-password', (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== 'string' || !token || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'Reset code and new password are required' });
      return;
    }

    const codeHash = crypto.createHash('sha256').update(token.trim().toUpperCase()).digest('hex');

    const resetToken = db
      .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?')
      .get(codeHash, new Date().toISOString()) as any;

    if (!resetToken) {
      audit('auth.password.reset.complete', req, { outcome: 'failure', detail: { reason: 'invalid_or_expired' } });
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(resetToken.user_id) as any;
    const strength = validatePassword(newPassword, owner?.email);
    if (!strength.ok) {
      res.status(400).json({ error: strength.reason });
      return;
    }

    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);

    db.transaction(() => {
      db.prepare(
        `UPDATE users
            SET password_hash = ?, updated_at = ?, password_changed_at = ?,
                must_change_password = 0, failed_login_count = 0, locked_until = NULL,
                token_version = COALESCE(token_version, 0) + 1
          WHERE id = ?`
      ).run(passwordHash, now, now, resetToken.user_id);
      db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);
      // Invalidate every other outstanding code for this account.
      db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0')
        .run(resetToken.user_id);
    })();

    audit('auth.password.reset.complete', req, { userId: resetToken.user_id });
    res.json({ message: 'Password reset successfully. Sign in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ---------------------------------------------------------------------------
// PUT /update-profile
// ---------------------------------------------------------------------------
router.put('/update-profile', authMiddleware, (req: Request, res: Response) => {
  try {
    const { username, name } = req.body ?? {};
    const email = req.body?.email !== undefined ? normalizeEmail(req.body.email) : undefined;
    const userId = req.user!.id;
    const now = new Date().toISOString();

    if (req.body?.email !== undefined && email === null) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    if (username !== undefined && username !== null && username !== '' &&
        !/^[a-zA-Z0-9._-]{3,32}$/.test(String(username))) {
      res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' });
      return;
    }

    if (username) {
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId) as any;
      if (existing) { res.status(409).json({ error: 'Username already taken' }); return; }
    }
    if (email) {
      const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, userId) as any;
      if (existing) { res.status(409).json({ error: 'Email already in use' }); return; }
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (username !== undefined) { updates.push('username = ?'); values.push(username || null); }
    if (email) { updates.push('email = ?'); values.push(email); }
    if (typeof name === 'string' && name.trim()) { updates.push('name = ?'); values.push(name.trim()); }
    updates.push('updated_at = ?'); values.push(now);
    values.push(userId);

    if (updates.length > 1) {
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      audit('auth.profile.update', req, { detail: { fields: updates.slice(0, -1) } });
    }

    const user = db
      .prepare('SELECT id, email, username, name, role, currency, created_at, must_change_password FROM users WHERE id = ?')
      .get(userId) as any;
    res.json(publicUser(user));
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ---------------------------------------------------------------------------
// PUT /change-password
// ---------------------------------------------------------------------------
router.put('/change-password', authMiddleware, (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    const userId = req.user!.id;

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' });
      return;
    }

    const user = db.prepare('SELECT password_hash, email FROM users WHERE id = ?').get(userId) as any;
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      audit('auth.password.change', req, { outcome: 'failure', detail: { reason: 'wrong_current_password' } });
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }

    if (currentPassword === newPassword) {
      res.status(400).json({ error: 'New password must be different from the current one' });
      return;
    }

    const strength = validatePassword(newPassword, user.email);
    if (!strength.ok) {
      res.status(400).json({ error: strength.reason });
      return;
    }

    const now = new Date().toISOString();
    const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);

    db.prepare(
      `UPDATE users
          SET password_hash = ?, updated_at = ?, password_changed_at = ?,
              must_change_password = 0, failed_login_count = 0, locked_until = NULL,
              token_version = COALESCE(token_version, 0) + 1
        WHERE id = ?`
    ).run(hash, now, now, userId);

    audit('auth.password.change', req, { userId });

    // Old sessions (including any attacker's) are now dead. Issue a fresh token
    // so the caller isn't logged out of the tab they just changed it in.
    const updated = db.prepare('SELECT id, email, role, token_version FROM users WHERE id = ?').get(userId) as any;
    const token = generateToken(updated.id, updated.email, updated.role || 'client', updated.token_version ?? 0);

    res.json({ message: 'Password changed. All other sessions have been signed out.', token });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ---------------------------------------------------------------------------
// GET /security-log — the account's own recent security events
// ---------------------------------------------------------------------------
router.get('/security-log', authMiddleware, (req: Request, res: Response) => {
  try {
    const rows = db
      .prepare(
        `SELECT action, outcome, ip, user_agent, created_at
           FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
      )
      .all(req.user!.id);
    res.json(rows);
  } catch (error) {
    console.error('Security log error:', error);
    res.status(500).json({ error: 'Failed to load security log' });
  }
});

export default router;
