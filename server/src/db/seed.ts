import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../../finflow.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const now = new Date().toISOString();

// Demo user
const userId = randomUUID();
const passwordHash = bcrypt.hashSync('demo123', 10);

console.log('🌱 Seeding FinFlow with realistic data...\n');

// Clean existing demo data
db.exec(`DELETE FROM net_worth_snapshots WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM investments WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM goals WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM recurring_expenses WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM budgets WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM categories WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email='demo@finflow.com')`);
db.exec(`DELETE FROM users WHERE email='demo@finflow.com'`);

// 1. Create user
db.prepare(`INSERT INTO users (id, email, password_hash, name, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(userId, 'demo@finflow.com', passwordHash, 'Marcelo Zinn', 'USD', now, now);
console.log('✅ Created demo user (demo@finflow.com / demo123)');

// 2. Create accounts
const accounts: Record<string, string> = {};
const acctData = [
  { name: 'Chase Checking', type: 'checking', institution: 'Chase', balance: 8450.32, last_four: '4521', icon: '🏦' },
  { name: 'Ally Savings', type: 'savings', institution: 'Ally Bank', balance: 15200.00, last_four: '8834', icon: '💰' },
  { name: 'Amex Gold', type: 'credit', institution: 'American Express', balance: -2340.56, last_four: '1008', icon: '💳' },
  { name: 'Fidelity 401k', type: 'investment', institution: 'Fidelity', balance: 45600.00, last_four: '9912', icon: '📈' },
];

const insertAcct = db.prepare(`INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
for (const a of acctData) {
  const id = randomUUID();
  accounts[a.type] = id;
  insertAcct.run(id, userId, a.name, a.type, a.institution, a.balance, a.last_four, a.icon, now, now);
}
console.log('✅ Created 4 accounts');

// 3. Create categories
const cats: Record<string, string> = {};
const catData = [
  { name: 'Housing', icon: '🏠', color: '#6366F1', budget: 1800, isIncome: false },
  { name: 'Food & Dining', icon: '🍔', color: '#F59E0B', budget: 650, isIncome: false },
  { name: 'Transportation', icon: '🚗', color: '#3B82F6', budget: 450, isIncome: false },
  { name: 'Entertainment', icon: '🎬', color: '#EC4899', budget: 200, isIncome: false },
  { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', budget: 350, isIncome: false },
  { name: 'Utilities', icon: '💡', color: '#14B8A6', budget: 280, isIncome: false },
  { name: 'Health & Fitness', icon: '🏥', color: '#EF4444', budget: 200, isIncome: false },
  { name: 'Subscriptions', icon: '📱', color: '#F97316', budget: 120, isIncome: false },
  { name: 'Insurance', icon: '🛡️', color: '#06B6D4', budget: 350, isIncome: false },
  { name: 'Personal Care', icon: '💇', color: '#D946EF', budget: 100, isIncome: false },
  { name: 'Education', icon: '📚', color: '#0EA5E9', budget: 150, isIncome: false },
  { name: 'Salary', icon: '💵', color: '#10B981', budget: 0, isIncome: true },
  { name: 'Freelance', icon: '💼', color: '#22D3EE', budget: 0, isIncome: true },
  { name: 'Investments', icon: '📊', color: '#A78BFA', budget: 0, isIncome: true },
];

const insertCat = db.prepare(`INSERT INTO categories (id, user_id, name, icon, color, budget_amount, is_income, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
let sortOrder = 0;
for (const c of catData) {
  const id = randomUUID();
  cats[c.name] = id;
  insertCat.run(id, userId, c.name, c.icon, c.color, c.budget > 0 ? c.budget : null, c.isIncome ? 1 : 0, sortOrder++);
}
console.log('✅ Created 14 categories');

// 4. Create budgets for current and past months
const insertBudget = db.prepare(`INSERT INTO budgets (id, user_id, category_id, month, amount, rollover, rollover_amount) VALUES (?, ?, ?, ?, ?, 0, 0)`);
const budgetCats = catData.filter(c => c.budget > 0);
for (let m = 5; m >= 0; m--) {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  for (const c of budgetCats) {
    insertBudget.run(randomUUID(), userId, cats[c.name], month, c.budget);
  }
}
console.log('✅ Created budgets for 6 months');

// 5. Create transactions (6 months of realistic data)
const insertTx = db.prepare(`INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, recurring_id, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, '[]', ?, ?)`);

const merchants: Record<string, { minAmt: number; maxAmt: number; acct: string }> = {
  'Food & Dining': { minAmt: 8, maxAmt: 45, acct: 'credit' },
  'Transportation': { minAmt: 15, maxAmt: 85, acct: 'credit' },
  'Entertainment': { minAmt: 10, maxAmt: 65, acct: 'credit' },
  'Shopping': { minAmt: 15, maxAmt: 120, acct: 'credit' },
  'Health & Fitness': { minAmt: 20, maxAmt: 80, acct: 'credit' },
  'Personal Care': { minAmt: 15, maxAmt: 50, acct: 'credit' },
  'Education': { minAmt: 20, maxAmt: 80, acct: 'credit' },
};

const merchantNames: Record<string, string[]> = {
  'Food & Dining': ['Whole Foods', 'Trader Joe\'s', 'Chipotle', 'Starbucks', 'DoorDash', 'Panera Bread', 'Safeway', 'Costco', 'In-N-Out', 'Panda Express'],
  'Transportation': ['Shell Gas', 'Chevron', 'Uber', 'Lyft', 'Car Wash Express', 'Parking Garage'],
  'Entertainment': ['AMC Theatres', 'Steam Games', 'Bowling Alley', 'Concert Tickets', 'Barnes & Noble'],
  'Shopping': ['Amazon', 'Target', 'Nordstrom', 'Best Buy', 'Nike.com', 'Apple Store', 'Etsy'],
  'Health & Fitness': ['Planet Fitness', 'CVS Pharmacy', 'Walgreens', 'Doctor Co-pay', 'GNC Supplements'],
  'Personal Care': ['Great Clips', 'Sephora', 'Bath & Body Works', 'Dentist Office'],
  'Education': ['Udemy Course', 'O\'Reilly Books', 'Skillshare', 'Coursera'],
};

function randBetween(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

let txCount = 0;
for (let m = 5; m >= 0; m--) {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  const year = d.getFullYear();
  const month = d.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStr = String(month + 1).padStart(2, '0');

  // Income: salary twice a month
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Payroll - TechCorp Inc', 3850, cats['Salary'], `${year}-${monthStr}-01`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Payroll - TechCorp Inc', 3850, cats['Salary'], `${year}-${monthStr}-15`, 0, now, now);
  txCount += 2;

  // Freelance income (some months)
  if (Math.random() > 0.4) {
    const freelanceDay = String(Math.min(Math.floor(Math.random() * 20) + 5, daysInMonth)).padStart(2, '0');
    insertTx.run(randomUUID(), userId, accounts['checking'], 'Freelance - Web Project', randBetween(500, 2000), cats['Freelance'], `${year}-${monthStr}-${freelanceDay}`, 0, now, now);
    txCount++;
  }

  // Fixed expenses: Rent
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Rent Payment', -1800, cats['Housing'], `${year}-${monthStr}-01`, 0, now, now);
  txCount++;

  // Insurance
  insertTx.run(randomUUID(), userId, accounts['checking'], 'State Farm Auto Insurance', -175, cats['Insurance'], `${year}-${monthStr}-05`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Health Insurance Premium', -185, cats['Insurance'], `${year}-${monthStr}-05`, 0, now, now);
  txCount += 2;

  // Utilities
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Electric Company', -randBetween(80, 140), cats['Utilities'], `${year}-${monthStr}-10`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Internet - Comcast', -89.99, cats['Utilities'], `${year}-${monthStr}-10`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['checking'], 'Phone Bill - Verizon', -75, cats['Utilities'], `${year}-${monthStr}-12`, 0, now, now);
  txCount += 3;

  // Subscriptions
  insertTx.run(randomUUID(), userId, accounts['credit'], 'Spotify Premium', -10.99, cats['Subscriptions'], `${year}-${monthStr}-08`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['credit'], 'Netflix', -15.49, cats['Subscriptions'], `${year}-${monthStr}-08`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['credit'], 'ChatGPT Plus', -20, cats['Subscriptions'], `${year}-${monthStr}-08`, 0, now, now);
  insertTx.run(randomUUID(), userId, accounts['credit'], 'iCloud Storage', -2.99, cats['Subscriptions'], `${year}-${monthStr}-08`, 0, now, now);
  txCount += 4;

  // Variable expenses
  for (const [catName, info] of Object.entries(merchants)) {
    const names = merchantNames[catName];
    if (!names) continue;

    const numTx = catName === 'Food & Dining' ? Math.floor(Math.random() * 8) + 12
      : catName === 'Transportation' ? Math.floor(Math.random() * 3) + 3
      : catName === 'Shopping' ? Math.floor(Math.random() * 3) + 2
      : catName === 'Entertainment' ? Math.floor(Math.random() * 2) + 1
      : Math.floor(Math.random() * 2) + 1;

    for (let t = 0; t < numTx; t++) {
      const day = String(Math.min(Math.floor(Math.random() * daysInMonth) + 1, daysInMonth)).padStart(2, '0');
      const date = `${year}-${monthStr}-${day}`;
      const name = names[Math.floor(Math.random() * names.length)];
      const amount = -randBetween(info.minAmt, info.maxAmt);
      const isPending = m === 0 && parseInt(day) >= new Date().getDate() - 2 ? 1 : 0;
      insertTx.run(randomUUID(), userId, accounts[info.acct], name, amount, cats[catName], date, isPending, now, now);
      txCount++;
    }
  }
}
console.log(`✅ Created ${txCount} transactions across 6 months`);

// 6. Recurring expenses
const insertRecurring = db.prepare(`INSERT INTO recurring_expenses (id, user_id, account_id, name, amount, category_id, frequency, next_date, last_charged_date, is_active, notes, price_history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`);

const recurringData = [
  { name: 'Rent', amount: 1800, cat: 'Housing', freq: 'monthly', acct: 'checking' },
  { name: 'Spotify Premium', amount: 10.99, cat: 'Subscriptions', freq: 'monthly', acct: 'credit' },
  { name: 'Netflix', amount: 15.49, cat: 'Subscriptions', freq: 'monthly', acct: 'credit' },
  { name: 'ChatGPT Plus', amount: 20, cat: 'Subscriptions', freq: 'monthly', acct: 'credit' },
  { name: 'Planet Fitness', amount: 25, cat: 'Health & Fitness', freq: 'monthly', acct: 'credit' },
  { name: 'Internet - Comcast', amount: 89.99, cat: 'Utilities', freq: 'monthly', acct: 'checking' },
  { name: 'Phone - Verizon', amount: 75, cat: 'Utilities', freq: 'monthly', acct: 'checking' },
  { name: 'Auto Insurance', amount: 175, cat: 'Insurance', freq: 'monthly', acct: 'checking' },
  { name: 'Health Insurance', amount: 185, cat: 'Insurance', freq: 'monthly', acct: 'checking' },
  { name: 'iCloud Storage', amount: 2.99, cat: 'Subscriptions', freq: 'monthly', acct: 'credit' },
];

const nextMonth = new Date();
nextMonth.setMonth(nextMonth.getMonth() + 1);
nextMonth.setDate(1);
const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
const thisMonthStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;

for (const r of recurringData) {
  const priceHistory = JSON.stringify([{ date: thisMonthStr, amount: r.amount }]);
  insertRecurring.run(randomUUID(), userId, accounts[r.acct], r.name, r.amount, cats[r.cat], r.freq, nextMonthStr, thisMonthStr, priceHistory, now, now);
}
console.log('✅ Created 10 recurring expenses');

// 7. Goals
const insertGoal = db.prepare(`INSERT INTO goals (id, user_id, name, target_amount, current_amount, target_date, icon, color, is_completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

[
  { name: 'Emergency Fund', target: 20000, current: 15200, date: '2026-12-31', icon: '🛡️', color: '#10B981' },
  { name: 'Vacation to Japan', target: 5000, current: 2800, date: '2026-09-01', icon: '✈️', color: '#3B82F6' },
  { name: 'New MacBook Pro', target: 3000, current: 1200, date: '2026-06-15', icon: '💻', color: '#8B5CF6' },
  { name: 'Car Down Payment', target: 8000, current: 3500, date: '2027-03-01', icon: '🚗', color: '#F59E0B' },
].forEach(g => insertGoal.run(randomUUID(), userId, g.name, g.target, g.current, g.date, g.icon, g.color, 0, now, now));
console.log('✅ Created 4 savings goals');

// 8. Investments
const insertInvest = db.prepare(`INSERT INTO investments (id, user_id, account_id, symbol, name, type, shares, cost_basis, current_price, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

[
  { symbol: 'VOO', name: 'Vanguard S&P 500', type: 'etf', shares: 25, cost: 420.50, current: 485.32 },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', type: 'etf', shares: 15, cost: 380.00, current: 445.18 },
  { symbol: 'AAPL', name: 'Apple Inc.', type: 'stock', shares: 20, cost: 175.30, current: 198.45 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', type: 'stock', shares: 10, cost: 365.00, current: 412.80 },
  { symbol: 'BTC', name: 'Bitcoin', type: 'crypto', shares: 0.15, cost: 42000, current: 67500 },
  { symbol: 'VTI', name: 'Vanguard Total Stock', type: 'etf', shares: 30, cost: 225.50, current: 258.90 },
].forEach(inv => insertInvest.run(randomUUID(), userId, accounts['investment'], inv.symbol, inv.name, inv.type, inv.shares, inv.cost, inv.current, now));
console.log('✅ Created 6 investment holdings');

// 9. Net worth snapshots
const insertSnapshot = db.prepare(`INSERT INTO net_worth_snapshots (id, user_id, date, total_assets, total_liabilities, net_worth, breakdown) VALUES (?, ?, ?, ?, ?, ?, ?)`);

for (let m = 5; m >= 0; m--) {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  d.setDate(28);
  const snapDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-28`;
  const baseAssets = 62000 + (5 - m) * 2500 + Math.random() * 3000;
  const baseLiabilities = 3000 - (5 - m) * 200 + Math.random() * 500;
  const assets = Math.round(baseAssets * 100) / 100;
  const liabilities = Math.round(baseLiabilities * 100) / 100;
  const netWorth = Math.round((assets - liabilities) * 100) / 100;
  const breakdown = JSON.stringify({
    cash: Math.round((8000 + (5 - m) * 500) * 100) / 100,
    investments: Math.round((45000 + (5 - m) * 1800) * 100) / 100,
    property: 0,
    crypto: Math.round((5000 + (5 - m) * 400) * 100) / 100,
    debts: Math.round(liabilities * 100) / 100,
  });
  insertSnapshot.run(randomUUID(), userId, snapDate, assets, liabilities, netWorth, breakdown);
}
console.log('✅ Created 6 months of net worth history');

console.log('\n🎉 Seeding complete!');
console.log('   Login: demo@finflow.com / demo123');
console.log(`   Total transactions: ${txCount}`);

db.close();
