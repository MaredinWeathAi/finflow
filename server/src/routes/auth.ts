import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
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

// ── TEMP: Seed demo account with realistic data ──
router.post('/seed-demo', (req: Request, res: Response) => {
  try {
    const { secret, userId } = req.body;
    if (secret !== 'finbudget-seed-2024') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const uid = userId;
    const now = new Date().toISOString();
    const uuid = () => randomUUID();

    // ── 1. Create Accounts ──
    const checkingId = uuid();
    const savingsId = uuid();
    const creditId = uuid();
    const fourOhOneKId = uuid();

    const insertAccount = db.prepare(`INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)`);
    insertAccount.run(checkingId, uid, 'Chase Checking', 'checking', 'Chase', 8742.53, '4521', 'building', now, now);
    insertAccount.run(savingsId, uid, 'Chase Savings', 'savings', 'Chase', 25340.00, '8833', 'piggy-bank', now, now);
    insertAccount.run(creditId, uid, 'Capital One Venture', 'credit', 'Capital One', -2847.32, '9012', 'credit-card', now, now);
    insertAccount.run(fourOhOneKId, uid, 'Fidelity 401(k)', '401k', 'Fidelity', 87500.00, null, 'briefcase', now, now);

    // ── 2. Create Categories ──
    const cats: Record<string, string> = {};
    const insertCat = db.prepare(`INSERT INTO categories (id, user_id, name, icon, color, budget_amount, is_income, sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    const catData = [
      ['Salary', '💰', '#10B981', null, 1, 1],
      ['Freelance', '💻', '#06B6D4', null, 1, 2],
      ['Housing', '🏠', '#6366F1', 2200, 0, 3],
      ['Groceries', '🛒', '#F59E0B', 650, 0, 4],
      ['Restaurants', '🍽️', '#EF4444', 350, 0, 5],
      ['Transportation', '🚗', '#8B5CF6', 350, 0, 6],
      ['Utilities', '💡', '#3B82F6', 300, 0, 7],
      ['Insurance', '🛡️', '#14B8A6', 200, 0, 8],
      ['Subscriptions', '📺', '#EC4899', 120, 0, 9],
      ['Shopping', '🛍️', '#F97316', 300, 0, 10],
      ['Healthcare', '🏥', '#10B981', 200, 0, 11],
      ['Entertainment', '🎬', '#A855F7', 200, 0, 12],
      ['Personal Care', '💇', '#F43F5E', 100, 0, 13],
      ['Education', '📚', '#0EA5E9', 100, 0, 14],
      ['Transfer', '🔄', '#64748B', null, 0, 15],
      ['CC PMT', '💳', '#94A3B8', null, 0, 16],
      ['Home Improvements', '🔨', '#D97706', 200, 0, 17],
      ['Gifts & Donations', '🎁', '#E11D48', 150, 0, 18],
    ];
    for (const [name, icon, color, budget, isIncome, order] of catData) {
      const id = uuid();
      cats[name as string] = id;
      insertCat.run(id, uid, name, icon, color, budget, isIncome, order);
    }

    // ── 3. Generate 6 months of transactions (Oct 2025 – Mar 2026) ──
    const insertTx = db.prepare(`INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, source) VALUES (?,?,?,?,?,?,?,?,0,?,?)`);

    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'];

    // Helper to get a random day in a month
    const rday = (m: string, min = 1, max = 28) => {
      const d = min + Math.floor(Math.random() * (max - min + 1));
      return `${m}-${String(d).padStart(2, '0')}`;
    };
    const ramt = (base: number, variance: number) => {
      return Math.round((base + (Math.random() - 0.5) * 2 * variance) * 100) / 100;
    };

    let txCount = 0;

    for (const m of months) {
      // ── INCOME ──
      // Salary (bi-weekly, 1st and 15th)
      insertTx.run(uuid(), uid, checkingId, 'ACME CORP PAYROLL', 3750.00, cats['Salary'], `${m}-01`, 'Bi-weekly salary', 0, 1, 'seed');
      insertTx.run(uuid(), uid, checkingId, 'ACME CORP PAYROLL', 3750.00, cats['Salary'], `${m}-15`, 'Bi-weekly salary', 0, 1, 'seed');
      txCount += 2;

      // Occasional freelance (some months)
      if (['2025-10', '2025-12', '2026-02'].includes(m)) {
        insertTx.run(uuid(), uid, checkingId, 'UPWORK PAYMENT', ramt(850, 200), cats['Freelance'], rday(m, 8, 22), 'Freelance web dev project', 0, 0, 'seed');
        txCount++;
      }

      // ── HOUSING ──
      insertTx.run(uuid(), uid, checkingId, 'CITYWIDE PROPERTY MGMT', -2200.00, cats['Housing'], `${m}-01`, 'Monthly rent', 0, 1, 'seed');
      txCount++;

      // ── UTILITIES ──
      insertTx.run(uuid(), uid, checkingId, 'CONSOLIDATED EDISON', ramt(-135, 30), cats['Utilities'], rday(m, 5, 12), 'Electric bill', 0, 1, 'seed');
      insertTx.run(uuid(), uid, checkingId, 'NATIONAL GRID GAS', ramt(-75, 20), cats['Utilities'], rday(m, 8, 15), 'Gas bill', 0, 1, 'seed');
      insertTx.run(uuid(), uid, checkingId, 'VERIZON FIOS', -89.99, cats['Utilities'], rday(m, 18, 22), 'Internet', 0, 1, 'seed');
      txCount += 3;

      // ── INSURANCE ──
      insertTx.run(uuid(), uid, checkingId, 'STATE FARM INSURANCE', -178.50, cats['Insurance'], rday(m, 1, 5), 'Auto + renters insurance', 0, 1, 'seed');
      txCount++;

      // ── GROCERIES (4-6 trips per month) ──
      const groceryStores = ['WHOLE FOODS MARKET', 'TRADER JOES', 'COSTCO WHOLESALE', 'STOP AND SHOP', 'ALDI GROCERY'];
      const groceryTrips = 4 + Math.floor(Math.random() * 3);
      for (let g = 0; g < groceryTrips; g++) {
        const store = groceryStores[Math.floor(Math.random() * groceryStores.length)];
        const amt = store === 'COSTCO WHOLESALE' ? ramt(-145, 35) : ramt(-78, 25);
        insertTx.run(uuid(), uid, checkingId, store, amt, cats['Groceries'], rday(m, 1, 28), null, 0, 0, 'seed');
        txCount++;
      }

      // ── RESTAURANTS (3-5 per month) ──
      const restaurants = ['CHIPOTLE MEXICAN', 'OLIVE GARDEN', 'PANERA BREAD', 'LOCAL PIZZA SHOP', 'STARBUCKS COFFEE', 'DOORDASH DELIVERY', 'UBER EATS', 'GRUBHUB ORDER'];
      const diningTrips = 3 + Math.floor(Math.random() * 3);
      for (let r = 0; r < diningTrips; r++) {
        const rest = restaurants[Math.floor(Math.random() * restaurants.length)];
        const amt = rest.includes('STARBUCKS') ? ramt(-6.50, 2) : ramt(-38, 15);
        const acct = Math.random() > 0.5 ? creditId : checkingId;
        insertTx.run(uuid(), uid, acct, rest, amt, cats['Restaurants'], rday(m, 1, 28), null, 0, 0, 'seed');
        txCount++;
      }

      // ── TRANSPORTATION ──
      insertTx.run(uuid(), uid, checkingId, 'SHELL GAS STATION', ramt(-52, 8), cats['Transportation'], rday(m, 3, 10), null, 0, 0, 'seed');
      insertTx.run(uuid(), uid, checkingId, 'EXXON MOBIL', ramt(-48, 8), cats['Transportation'], rday(m, 17, 24), null, 0, 0, 'seed');
      if (Math.random() > 0.5) {
        insertTx.run(uuid(), uid, checkingId, 'JIFFY LUBE OIL CHANGE', -79.99, cats['Transportation'], rday(m, 10, 20), 'Oil change', 0, 0, 'seed');
        txCount++;
      }
      txCount += 2;

      // ── SUBSCRIPTIONS (recurring, on credit card) ──
      insertTx.run(uuid(), uid, creditId, 'NETFLIX SUBSCRIPTION', -15.99, cats['Subscriptions'], `${m}-05`, null, 0, 1, 'seed');
      insertTx.run(uuid(), uid, creditId, 'SPOTIFY PREMIUM', -10.99, cats['Subscriptions'], `${m}-07`, null, 0, 1, 'seed');
      insertTx.run(uuid(), uid, creditId, 'PLANET FITNESS', -24.99, cats['Subscriptions'], `${m}-15`, null, 0, 1, 'seed');
      insertTx.run(uuid(), uid, creditId, 'ICLOUD STORAGE', -2.99, cats['Subscriptions'], `${m}-12`, null, 0, 1, 'seed');
      insertTx.run(uuid(), uid, creditId, 'CHATGPT PLUS', -20.00, cats['Subscriptions'], `${m}-18`, null, 0, 1, 'seed');
      txCount += 5;

      // ── SHOPPING (2-4 per month, on credit card) ──
      const shops = ['AMAZON.COM', 'TARGET STORE', 'BEST BUY', 'HOME DEPOT', 'WALMART SUPERCENTER', 'NORDSTROM'];
      const shopTrips = 2 + Math.floor(Math.random() * 3);
      for (let s = 0; s < shopTrips; s++) {
        const shop = shops[Math.floor(Math.random() * shops.length)];
        const amt = shop === 'BEST BUY' ? ramt(-120, 60) : ramt(-55, 30);
        insertTx.run(uuid(), uid, creditId, shop, amt, cats['Shopping'], rday(m, 1, 28), null, 0, 0, 'seed');
        txCount++;
      }

      // ── HEALTHCARE (occasional) ──
      if (Math.random() > 0.4) {
        const hcNames = ['CVS PHARMACY', 'WALGREENS PHARMACY', 'DR JOHNSON OFFICE', 'QUEST DIAGNOSTICS'];
        const hc = hcNames[Math.floor(Math.random() * hcNames.length)];
        insertTx.run(uuid(), uid, checkingId, hc, ramt(-45, 25), cats['Healthcare'], rday(m, 5, 25), null, 0, 0, 'seed');
        txCount++;
      }

      // ── ENTERTAINMENT (occasional) ──
      if (Math.random() > 0.3) {
        const entNames = ['AMC THEATRES', 'TICKETMASTER', 'BARNES AND NOBLE', 'BOWLERO BOWLING'];
        const ent = entNames[Math.floor(Math.random() * entNames.length)];
        insertTx.run(uuid(), uid, creditId, ent, ramt(-35, 15), cats['Entertainment'], rday(m, 10, 25), null, 0, 0, 'seed');
        txCount++;
      }

      // ── PERSONAL CARE ──
      if (Math.random() > 0.5) {
        insertTx.run(uuid(), uid, checkingId, 'SUPERCUTS HAIRCUT', -28.00, cats['Personal Care'], rday(m, 10, 25), null, 0, 0, 'seed');
        txCount++;
      }

      // ── HOME IMPROVEMENTS (occasional) ──
      if (['2025-11', '2026-01', '2026-03'].includes(m)) {
        const hiNames = ['HOME DEPOT', 'LOWES HOME IMPROVEMENT', 'ACE HARDWARE'];
        const hi = hiNames[Math.floor(Math.random() * hiNames.length)];
        insertTx.run(uuid(), uid, checkingId, hi, ramt(-125, 50), cats['Home Improvements'], rday(m, 5, 20), null, 0, 0, 'seed');
        txCount++;
      }

      // ── GIFTS & DONATIONS ──
      if (['2025-12', '2026-02'].includes(m)) {
        insertTx.run(uuid(), uid, creditId, 'AMAZON GIFT PURCHASE', ramt(-85, 30), cats['Gifts & Donations'], rday(m, 10, 22), 'Birthday gift', 0, 0, 'seed');
        txCount++;
      }
      if (m === '2025-12') {
        insertTx.run(uuid(), uid, checkingId, 'RED CROSS DONATION', -100.00, cats['Gifts & Donations'], '2025-12-20', 'Holiday donation', 0, 0, 'seed');
        txCount++;
      }

      // ── TRANSFERS & CC PAYMENT ──
      insertTx.run(uuid(), uid, checkingId, 'TRANSFER TO SAVINGS', -500.00, cats['Transfer'], rday(m, 2, 5), 'Monthly savings', 0, 1, 'seed');
      insertTx.run(uuid(), uid, savingsId, 'TRANSFER FROM CHECKING', 500.00, cats['Transfer'], rday(m, 2, 5), 'Monthly savings', 0, 1, 'seed');
      insertTx.run(uuid(), uid, checkingId, 'CAPITAL ONE CC PAYMENT', ramt(-1200, 200), cats['CC PMT'], rday(m, 20, 25), 'Credit card payment', 0, 1, 'seed');
      txCount += 3;

      // ── EDUCATION (some months) ──
      if (['2025-10', '2026-01'].includes(m)) {
        insertTx.run(uuid(), uid, creditId, 'UDEMY COURSE PURCHASE', -14.99, cats['Education'], rday(m, 5, 15), 'Online course', 0, 0, 'seed');
        txCount++;
      }
    }

    // ── 4. Create Recurring Expenses ──
    const insertRecurring = db.prepare(`INSERT INTO recurring_expenses (id, user_id, account_id, name, amount, category_id, frequency, next_date, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`);
    insertRecurring.run(uuid(), uid, checkingId, 'Rent', 2200, cats['Housing'], 'monthly', '2026-04-01', now, now);
    insertRecurring.run(uuid(), uid, creditId, 'Netflix', 15.99, cats['Subscriptions'], 'monthly', '2026-04-05', now, now);
    insertRecurring.run(uuid(), uid, creditId, 'Spotify', 10.99, cats['Subscriptions'], 'monthly', '2026-04-07', now, now);
    insertRecurring.run(uuid(), uid, creditId, 'Planet Fitness', 24.99, cats['Subscriptions'], 'monthly', '2026-04-15', now, now);
    insertRecurring.run(uuid(), uid, creditId, 'ChatGPT Plus', 20.00, cats['Subscriptions'], 'monthly', '2026-04-18', now, now);
    insertRecurring.run(uuid(), uid, checkingId, 'Verizon FiOS', 89.99, cats['Utilities'], 'monthly', '2026-04-20', now, now);
    insertRecurring.run(uuid(), uid, checkingId, 'State Farm Insurance', 178.50, cats['Insurance'], 'monthly', '2026-04-03', now, now);

    // ── 5. Create Budgets for March 2026 ──
    const insertBudget = db.prepare(`INSERT INTO budgets (id, user_id, category_id, month, amount, rollover, rollover_amount) VALUES (?,?,?,?,?,0,0)`);
    const budgetCats = [
      ['Housing', 2200], ['Groceries', 650], ['Restaurants', 350],
      ['Transportation', 350], ['Utilities', 300], ['Insurance', 200],
      ['Subscriptions', 120], ['Shopping', 300], ['Healthcare', 200],
      ['Entertainment', 200], ['Personal Care', 100], ['Home Improvements', 200],
      ['Gifts & Donations', 150],
    ];
    for (const [catName, amt] of budgetCats) {
      insertBudget.run(uuid(), uid, cats[catName as string], '2026-03', amt);
    }

    // ── 6. Create Goals ──
    const insertGoal = db.prepare(`INSERT INTO goals (id, user_id, name, target_amount, current_amount, target_date, icon, color, is_completed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)`);
    insertGoal.run(uuid(), uid, 'Emergency Fund', 30000, 25340, '2026-12-31', '🛡️', '#10B981', now, now);
    insertGoal.run(uuid(), uid, 'Vacation to Italy', 5000, 1800, '2026-08-01', '✈️', '#3B82F6', now, now);
    insertGoal.run(uuid(), uid, 'New Car Down Payment', 15000, 6200, '2027-06-01', '🚗', '#8B5CF6', now, now);

    // ── 7. Create Category Rules ──
    const insertRule = db.prepare(`INSERT INTO category_rules (id, user_id, pattern, category_id, match_type, created_at) VALUES (?,?,?,?,?,?)`);
    insertRule.run(uuid(), uid, 'ACME CORP PAYROLL', cats['Salary'], 'contains', now);
    insertRule.run(uuid(), uid, 'UPWORK', cats['Freelance'], 'contains', now);
    insertRule.run(uuid(), uid, 'CITYWIDE PROPERTY', cats['Housing'], 'contains', now);
    insertRule.run(uuid(), uid, 'CONSOLIDATED EDISON', cats['Utilities'], 'contains', now);
    insertRule.run(uuid(), uid, 'NATIONAL GRID', cats['Utilities'], 'contains', now);
    insertRule.run(uuid(), uid, 'VERIZON', cats['Utilities'], 'contains', now);
    insertRule.run(uuid(), uid, 'STATE FARM', cats['Insurance'], 'contains', now);
    insertRule.run(uuid(), uid, 'NETFLIX', cats['Subscriptions'], 'contains', now);
    insertRule.run(uuid(), uid, 'SPOTIFY', cats['Subscriptions'], 'contains', now);
    insertRule.run(uuid(), uid, 'PLANET FITNESS', cats['Subscriptions'], 'contains', now);
    insertRule.run(uuid(), uid, 'WHOLE FOODS', cats['Groceries'], 'contains', now);
    insertRule.run(uuid(), uid, 'TRADER JOES', cats['Groceries'], 'contains', now);
    insertRule.run(uuid(), uid, 'COSTCO', cats['Groceries'], 'contains', now);
    insertRule.run(uuid(), uid, 'SHELL GAS', cats['Transportation'], 'contains', now);
    insertRule.run(uuid(), uid, 'EXXON', cats['Transportation'], 'contains', now);
    insertRule.run(uuid(), uid, 'AMAZON', cats['Shopping'], 'contains', now);
    insertRule.run(uuid(), uid, 'TARGET', cats['Shopping'], 'contains', now);

    // ── 8. Net Worth Snapshots ──
    const insertSnap = db.prepare(`INSERT INTO net_worth_snapshots (id, user_id, date, total_assets, total_liabilities, net_worth, breakdown) VALUES (?,?,?,?,?,?,?)`);
    const snapData = [
      ['2025-10-31', 113500, 3100, 110400],
      ['2025-11-30', 115200, 2950, 112250],
      ['2025-12-31', 117800, 3200, 114600],
      ['2026-01-31', 119100, 2800, 116300],
      ['2026-02-28', 120500, 2900, 117600],
      ['2026-03-31', 121582.53, 2847.32, 118735.21],
    ];
    for (const [date, assets, liab, nw] of snapData) {
      insertSnap.run(uuid(), uid, date, assets, liab, nw, JSON.stringify({ checking: 8742.53, savings: 25340, credit: -(liab as number), '401k': 87500 }));
    }

    res.json({ success: true, message: `Seeded ${txCount} transactions + accounts, categories, budgets, goals, rules, recurring expenses for demo user`, userId: uid });
  } catch (error: any) {
    console.error('Seed demo error:', error);
    res.status(500).json({ error: error.message || 'Failed to seed demo data' });
  }
});

export default router;
