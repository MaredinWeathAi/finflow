import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// POST /register
router.post('/register', (req: Request, res: Response) => {
  try {
    const { email, password, name, username, role } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    // Check if user already exists
    const existing = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(email);

    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    if (username) {
      const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existingUsername) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
    }

    const id = crypto.randomUUID();
    const password_hash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();
    const userRole = role || 'client';

    // Auto-assign to the first admin as advisor so they appear in the admin panel
    let advisorId: string | null = null;
    if (userRole === 'client') {
      const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get() as any;
      if (admin) {
        advisorId = admin.id;
      }
    }

    db.prepare(
      `INSERT INTO users (id, email, username, password_hash, name, role, advisor_id, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?)`
    ).run(id, email, username || null, password_hash, name, userRole, advisorId, now, now);

    const token = generateToken(id, email, userRole);

    res.status(201).json({
      token,
      user: { id, email, username: username || null, name, role: userRole, currency: 'USD', created_at: now },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// POST /login
router.post('/login', (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;
    const identifier = email || username;

    if (!identifier || !password) {
      res.status(400).json({ error: 'Email or username and password are required' });
      return;
    }

    // Allow login with either email or username - auto-detect by checking for @
    const isEmail = identifier.includes('@');
    const query = isEmail ? 'SELECT * FROM users WHERE email = ?' : 'SELECT * FROM users WHERE username = ?';
    let user = db.prepare(query).get(identifier) as any;

    // If not found by primary method, try the other
    if (!user) {
      const fallbackQuery = isEmail ? 'SELECT * FROM users WHERE username = ?' : 'SELECT * FROM users WHERE email = ?';
      user = db.prepare(fallbackQuery).get(identifier) as any;
    }

    if (!user) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    const valid = bcrypt.compareSync(password, user.password_hash);

    if (!valid) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    const token = generateToken(user.id, user.email, user.role || 'client');

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role || 'client',
        currency: user.currency,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// POST /admin-reset-password (temporary - remove after use)
router.post('/admin-reset-password', (req: Request, res: Response) => {
  try {
    const { secret, username, newPassword } = req.body;
    console.log('Reset attempt for:', username, 'secret match:', secret === process.env.JWT_SECRET);
    if (secret !== process.env.JWT_SECRET) {
      res.status(403).json({ error: 'Forbidden', hint: 'Secret mismatch' });
      return;
    }
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any;
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    res.json({ success: true, message: `Password reset for ${username}` });
  } catch (error: any) {
    console.error('Reset error:', error?.message, error?.stack);
    res.status(500).json({ error: 'Failed to reset password', detail: error?.message });
  }
});

// GET /me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = db
      .prepare(
        'SELECT id, email, username, name, role, currency, created_at, updated_at FROM users WHERE id = ?'
      )
      .get(req.user!.id) as any;

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /forgot-password
router.post('/forgot-password', (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;

    // Always return success message for security
    if (!user) {
      res.json({ message: 'If an account exists, a reset code has been generated' });
      return;
    }

    const token = Math.random().toString(36).substring(2, 8).toUpperCase(); // 6-char code
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, user.id, token, expiresAt, now);

    res.json({ message: 'If an account exists, a reset code has been generated', resetCode: token });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// POST /reset-password
router.post('/reset-password', (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      res.status(400).json({ error: 'Token and new password required' });
      return;
    }

    const resetToken = db.prepare(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?'
    ).get(token, new Date().toISOString()) as any;

    if (!resetToken) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, new Date().toISOString(), resetToken.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// PUT /update-profile (auth required)
router.put('/update-profile', authMiddleware, (req: Request, res: Response) => {
  try {
    const { username, email, name } = req.body;
    const userId = req.user!.id;
    const now = new Date().toISOString();

    // Check uniqueness
    if (username) {
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId) as any;
      if (existing) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
    }
    if (email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId) as any;
      if (existing) {
        res.status(409).json({ error: 'Email already in use' });
        return;
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (username !== undefined) { updates.push('username = ?'); values.push(username); }
    if (email) { updates.push('email = ?'); values.push(email); }
    if (name) { updates.push('name = ?'); values.push(name); }
    updates.push('updated_at = ?');
    values.push(now);
    values.push(userId);

    if (updates.length > 1) { // At least one field besides updated_at
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const user = db.prepare('SELECT id, email, username, name, role, currency, created_at FROM users WHERE id = ?').get(userId) as any;
    res.json(user);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /change-password (auth required)
router.put('/change-password', authMiddleware, (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' });
      return;
    }

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as any;
    if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, new Date().toISOString(), userId);

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
