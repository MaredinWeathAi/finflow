import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// POST /register
router.post('/register', (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

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

    const id = crypto.randomUUID();
    const password_hash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'USD', ?, ?)`
    ).run(id, email, password_hash, name, now, now);

    const token = generateToken(id, email);

    res.status(201).json({
      token,
      user: { id, email, name, currency: 'USD', created_at: now },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// POST /login
router.post('/login', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as any;

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = bcrypt.compareSync(password, user.password_hash);

    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = generateToken(user.id, user.email);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        currency: user.currency,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// GET /me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = db
      .prepare(
        'SELECT id, email, name, currency, created_at, updated_at FROM users WHERE id = ?'
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

export default router;
