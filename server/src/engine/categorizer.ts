import { db } from '../db/database.js';
import crypto from 'crypto';
import { lookupMerchant, getMerchantDbStats } from './merchant-db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategorizationResult {
  categoryId: string | null;
  confidence: number;
  categoryName?: string;
  /** When a user rule specifies a type override (income / expense / transfer) */
  assignType?: 'income' | 'expense' | 'transfer' | null;
}

// ---------------------------------------------------------------------------
// Built-in keyword map  (keyword -> category name)
// ---------------------------------------------------------------------------

const KEYWORD_CATEGORY_MAP: Record<string, string> = {
  // Housing
  'rent': 'Housing',
  'mortgage': 'Mortgage',
  'airbnb': 'Housing',
  'hoa': 'Housing',
  'property tax': 'Housing',
  'apartment': 'Housing',
  'auto lease': 'Auto Lease',
  'landlord': 'Housing',

  // Groceries
  'whole foods': 'Groceries',
  'trader joe': 'Groceries',
  'kroger': 'Groceries',
  'safeway': 'Groceries',
  'walmart': 'Groceries',
  'costco': 'Groceries',
  'aldi': 'Groceries',
  'publix': 'Groceries',
  'sprouts': 'Groceries',
  'wegmans': 'Groceries',
  'h-e-b': 'Groceries',
  'food lion': 'Groceries',
  'piggly wiggly': 'Groceries',
  'meijer': 'Groceries',
  'winco': 'Groceries',
  'grocery': 'Groceries',

  // Shopping
  'target': 'Shopping',
  'amazon': 'Shopping',
  'etsy': 'Shopping',
  'ebay': 'Shopping',
  'best buy': 'Shopping',
  'home depot': 'Shopping',
  'lowes': 'Shopping',
  'ikea': 'Shopping',
  'nordstrom': 'Shopping',
  'tj maxx': 'Shopping',
  'marshalls': 'Shopping',
  'ross': 'Shopping',
  'nike': 'Shopping',
  'adidas': 'Shopping',
  'macys': 'Shopping',

  // Transportation
  'uber': 'Transportation',
  'lyft': 'Transportation',
  'gas': 'Transportation',
  'shell': 'Transportation',
  'chevron': 'Transportation',
  'exxon': 'Transportation',
  'bp': 'Transportation',
  'parking': 'Transportation',
  'toll': 'Transportation',
  'car wash': 'Transportation',
  'jiffy lube': 'Transportation',
  'autozone': 'Transportation',
  'car payment': 'Transportation',
  'metro': 'Transportation',
  'transit': 'Transportation',

  // Subscriptions
  'netflix': 'Subscriptions',
  'spotify': 'Subscriptions',
  'hulu': 'Subscriptions',
  'disney+': 'Subscriptions',
  'disney plus': 'Subscriptions',
  'amazon prime': 'Subscriptions',
  'apple': 'Subscriptions',
  'youtube premium': 'Subscriptions',
  'hbo max': 'Subscriptions',
  'paramount+': 'Subscriptions',
  'peacock': 'Subscriptions',
  'audible': 'Subscriptions',
  'icloud': 'Subscriptions',
  'dropbox': 'Subscriptions',
  'adobe': 'Subscriptions',

  // Food & Dining
  'starbucks': 'Food & Dining',
  'chipotle': 'Food & Dining',
  'mcdonald': 'Food & Dining',
  'doordash': 'Food & Dining',
  'grubhub': 'Food & Dining',
  'uber eats': 'Food & Dining',
  'subway': 'Food & Dining',
  'pizza': 'Food & Dining',
  'burger king': 'Food & Dining',
  'wendy': 'Food & Dining',
  'taco bell': 'Food & Dining',
  'chick-fil-a': 'Food & Dining',
  'panera': 'Food & Dining',
  'panda express': 'Food & Dining',
  'olive garden': 'Food & Dining',
  'applebee': 'Food & Dining',
  'restaurant': 'Food & Dining',
  'cafe': 'Food & Dining',
  'coffee': 'Food & Dining',
  'diner': 'Food & Dining',
  'sushi': 'Food & Dining',
  'shake shack': 'Food & Dining',
  'in-n-out': 'Food & Dining',
  'five guys': 'Food & Dining',
  'sweetgreen': 'Food & Dining',
  'postmates': 'Food & Dining',

  // Utilities
  'electric': 'Utilities',
  'gas bill': 'Utilities',
  'water': 'Utilities',
  'internet': 'Utilities',
  'phone': 'Utilities',
  'at&t': 'Utilities',
  'verizon': 'Utilities',
  'comcast': 'Utilities',
  'xfinity': 'Utilities',
  't-mobile': 'Utilities',
  'sprint': 'Utilities',
  'spectrum': 'Utilities',
  'pg&e': 'Utilities',
  'sewer': 'Utilities',
  'trash': 'Utilities',
  'utility': 'Utilities',

  // Health & Fitness / Healthcare
  'gym': 'Health & Fitness',
  'equinox': 'Health & Fitness',
  'planet fitness': 'Health & Fitness',
  'peloton': 'Health & Fitness',
  'crossfit': 'Health & Fitness',
  'pharmacy': 'Healthcare',
  'cvs': 'Healthcare',
  'walgreens': 'Healthcare',
  'doctor': 'Healthcare',
  'hospital': 'Healthcare',
  'dental': 'Healthcare',
  'optometrist': 'Healthcare',
  'urgent care': 'Healthcare',
  'medical': 'Healthcare',
  'health': 'Healthcare',
  'prescription': 'Healthcare',

  // Investments
  'vanguard': 'Investments',
  'fidelity': 'Investments',
  'schwab': 'Investments',
  'etrade': 'Investments',
  'e-trade': 'Investments',
  'robinhood': 'Investments',
  'coinbase': 'Investments',
  'wealthfront': 'Investments',
  'betterment': 'Investments',
  'merrill': 'Investments',
  'td ameritrade': 'Investments',
  'charles schwab': 'Investments',

  // Insurance
  'insurance': 'Insurance',
  'geico': 'Insurance',
  'progressive': 'Insurance',
  'allstate': 'Insurance',
  'state farm': 'Insurance',
  'liberty mutual': 'Insurance',
  'lemonade': 'Insurance',
  'usaa': 'Insurance',

  // Income
  'salary': 'Income',
  'payroll': 'Income',
  'direct deposit': 'Income',
  'freelance': 'Income',
  'interest': 'Income',
  'dividend': 'Income',
  'refund': 'Income',
  'reimbursement': 'Income',
  'bonus': 'Income',
  'commission': 'Income',
  'deposit': 'Income',

  // Travel
  'airline': 'Travel',
  'hotel': 'Travel',
  'flight': 'Travel',
  'booking.com': 'Travel',
  'expedia': 'Travel',
  'marriott': 'Travel',
  'hilton': 'Travel',
  'hertz': 'Travel',
  'enterprise rent': 'Travel',

  // Entertainment
  'amc theatre': 'Entertainment',
  'regal cinema': 'Entertainment',
  'ticketmaster': 'Entertainment',
  'stubhub': 'Entertainment',
  'steam': 'Entertainment',
  'playstation': 'Entertainment',
  'xbox': 'Entertainment',
  'nintendo': 'Entertainment',
  'bowling': 'Entertainment',

  // Education
  'udemy': 'Education',
  'coursera': 'Education',
  'skillshare': 'Education',
  'tuition': 'Education',
  'textbook': 'Education',

  // Personal Care
  'salon': 'Personal Care',
  'barber': 'Personal Care',
  'spa': 'Personal Care',
  'sephora': 'Personal Care',
  'ulta': 'Personal Care',
  'massage': 'Personal Care',

  // Pets
  'petsmart': 'Pets',
  'petco': 'Pets',
  'chewy': 'Pets',
  'vet': 'Pets',
  'veterinary': 'Pets',

  // Gifts
  'gift': 'Gifts',
  'donation': 'Gifts',
  'charity': 'Gifts',
  'flowers': 'Gifts',
  'hallmark': 'Gifts',
};

// ---------------------------------------------------------------------------
// Main categorization function
// ---------------------------------------------------------------------------

export async function categorizeItem(
  name: string,
  amount: number,
  userId: string,
  accountId?: string | null,
): Promise<CategorizationResult> {
  const lowerName = name.toLowerCase().trim();

  // 1. Check user's custom category_rules table (highest priority — user overrides)
  const userRuleResult = await matchUserRules(lowerName, userId, amount, accountId);
  if (userRuleResult) {
    return userRuleResult;
  }

  // 2. Smart Merchant Recognition — 1500+ known US merchants & brands
  const merchantResult = await matchMerchantDb(lowerName, userId);
  if (merchantResult) {
    return merchantResult;
  }

  // 3. Fall back to built-in keyword map (generic terms like "restaurant", "gas")
  const keywordResult = await matchKeywordMap(lowerName, userId, amount);
  if (keywordResult) {
    return keywordResult;
  }

  // 4. No match found
  return { categoryId: null, confidence: 0 };
}

// ---------------------------------------------------------------------------
// User custom rules matching
// ---------------------------------------------------------------------------

export async function loadUserRules(userId: string): Promise<any[]> {
  return await db.all(`SELECT cr.pattern, cr.category_id, cr.match_type, c.name as category_name,
              cr.amount_min, cr.amount_max, cr.amount_exact, cr.account_id, cr.is_enabled, cr.priority,
              cr.assign_type
       FROM category_rules cr
       JOIN categories c ON c.id = cr.category_id
       WHERE cr.user_id = ? AND (cr.is_enabled = 1 OR cr.is_enabled IS NULL)
       ORDER BY cr.priority DESC, cr.match_type ASC`, userId) as any[];
}

async function matchUserRules(
  lowerName: string,
  userId: string,
  amount?: number,
  accountId?: string | null,
): Promise<CategorizationResult | null> {
  const rules = await loadUserRules(userId);

  return matchRuleList(lowerName, rules, amount, accountId);
}

/**
 * Does one rule apply to this name/amount? Pure — no database.
 *
 * Extracted so the single-row path and the bulk re-categorise path share the
 * exact same predicate. Two copies of this logic would eventually disagree,
 * and the symptom would be a rule that behaves differently depending on which
 * screen triggered it.
 */
export function matchRuleList(
  lowerName: string,
  rules: any[],
  amount?: number,
  accountId?: string | null,
): CategorizationResult | null {
  for (const rule of rules) {
    const pattern = (rule.pattern || '').toLowerCase().trim();

    // Name/pattern matching (skip if no pattern — rule is amount-only)
    if (pattern) {
      let nameMatch = false;
      switch (rule.match_type) {
        case 'exact':
          nameMatch = lowerName === pattern;
          break;
        case 'starts_with':
          nameMatch = lowerName.startsWith(pattern);
          break;
        case 'ends_with':
          nameMatch = lowerName.endsWith(pattern);
          break;
        case 'substring':
          // Literal: the pattern appears verbatim, in order.
          nameMatch = lowerName.includes(pattern);
          break;
        case 'contains':
        default:
          // Word-based: ALL words in the pattern appear SOMEWHERE in the name,
          // in any order. Deliberately loose so "zelle received" matches
          // "Zelle Payment Received" — but it is much broader than it reads,
          // and a rule written as a phrase will match text that never contains
          // that phrase. A rule for "transfer marcelo zinn" also matched
          // "INTERACTIVE BROK DES:ACH TRANSFER ... INDN:MARCELO ZINN", because
          // all three words are present. Use 'substring' or 'starts_with' when
          // the phrase itself is what identifies the payee.
          const words = pattern.split(/\s+/).filter(Boolean);
          nameMatch = words.length > 0 && words.every((w: string) => lowerName.includes(w));
          break;
      }
      if (!nameMatch) continue;
    }

    // Account condition. The Rules screen offers an account picker and stores
    // account_id, but nothing ever read it — a rule scoped to one account
    // applied to every account, which is the opposite of what the user asked
    // for and silently widens every rule they thought they had narrowed.
    // Enforced only when we know which account the row belongs to; when we
    // don't, an account-scoped rule is skipped rather than applied blindly.
    if (rule.account_id) {
      if (accountId === undefined || accountId === null) continue;
      if (rule.account_id !== accountId) continue;
    }

    // Amount conditions (only check if amount is provided)
    if (amount != null) {
      const absAmount = Math.abs(amount);
      if (rule.amount_exact != null && Math.abs(absAmount - Math.abs(rule.amount_exact)) > 0.01) continue;
      if (rule.amount_min != null && absAmount < rule.amount_min) continue;
      if (rule.amount_max != null && absAmount > rule.amount_max) continue;
    }

    return {
      categoryId: rule.category_id,
      confidence: pattern ? (rule.match_type === 'exact' ? 1.0 : 0.8) : 0.7,
      categoryName: rule.category_name,
      assignType: rule.assign_type || null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Smart Merchant Database matching (1500+ known US merchants)
// ---------------------------------------------------------------------------

async function matchMerchantDb(lowerName: string, userId: string): Promise<CategorizationResult | null> {
  const merchant = lookupMerchant(lowerName);
  if (!merchant) return null;

  // Map the merchant's category name to the user's category ID
  const categoryId = await getCategoryByKeyword(merchant.category, userId);

  return {
    categoryId,
    confidence: merchant.confidence,
    categoryName: merchant.category,
  };
}

// ---------------------------------------------------------------------------
// Built-in keyword matching
// ---------------------------------------------------------------------------

/**
 * Whole-word keyword match. Plain `.includes()` matched 'spa' inside "SPACE
 * COAST CREDIT UNION" (a loan payment filed under Personal Care) and 'gas'
 * inside any word containing those letters. Short keywords collide with the
 * most words and did the most damage.
 */
const KEYWORD_RE_CACHE = new Map<string, RegExp>();

function keywordRegex(keyword: string): RegExp {
  let re = KEYWORD_RE_CACHE.get(keyword);
  if (re) return re;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = /^\w/.test(keyword) ? '\\b' : '';
  const close = /\w$/.test(keyword) ? '\\b' : '';
  re = new RegExp(open + escaped + close, 'i');
  KEYWORD_RE_CACHE.set(keyword, re);
  return re;
}

async function matchKeywordMap(lowerName: string, userId: string, amount: number): Promise<CategorizationResult | null> {
  // Sort keywords by length descending so more specific matches win first
  // e.g., "uber eats" should match before "uber"
  const sortedKeywords = Object.keys(KEYWORD_CATEGORY_MAP).sort(
    (a, b) => b.length - a.length
  );

  for (const keyword of sortedKeywords) {
    if (keywordRegex(keyword).test(lowerName)) {
      const categoryName = KEYWORD_CATEGORY_MAP[keyword];
      // An income keyword on money going OUT is a false match, not income.
      // 'treasury' matched "US TREASURY IRS DES:PAYMENT" — a $6,598 tax
      // payment filed as Other Income — and 'deposit'/'refund' do the same to
      // any debit that happens to contain the word.
      if (categoryName === 'Income' && amount < 0) continue;
      const categoryId = await getCategoryByKeyword(categoryName, userId);

      return {
        categoryId,
        confidence: 0.6,
        categoryName,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Learn a new categorization rule
// ---------------------------------------------------------------------------

export async function learnRule(
  userId: string,
  pattern: string,
  categoryId: string,
  matchType: string
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await db.run(`INSERT INTO category_rules (id, user_id, pattern, category_id, match_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`, id, userId, pattern, categoryId, matchType, createdAt);
}

// ---------------------------------------------------------------------------
// Helper: look up a category ID by matching the keyword to category name
// ---------------------------------------------------------------------------

export async function getCategoryByKeyword(keyword: string, userId: string): Promise<string | null> {
  const lowerKeyword = keyword.toLowerCase();

  // Try exact match first
  const exact = await db.get(`SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) = ?`, userId, lowerKeyword) as { id: string; name: string } | undefined;

  if (exact) {
    return exact.id;
  }

  // Try LIKE match (partial / contains)
  const partial = await db.get(`SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) LIKE ?`, userId, `%${lowerKeyword}%`) as { id: string; name: string } | undefined;

  if (partial) {
    return partial.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Merchant stem + similarity — "things that are the same, or close enough"
// ---------------------------------------------------------------------------

/**
 * Reduce a bank descriptor to the merchant underneath it.
 *
 * Two rows are the same payee to a person even though the bank stamps a
 * different date, confirmation number and reference on every one:
 *
 *   "PUBLIX SUPER M 08/24 PURCHASE PALMETTO BAY FL"
 *   "PUBLIX SUPER M 07/11 PURCHASE PALMETTO BAY FL"   -> same stem
 */
export function merchantStem(rawName: string): string {
  let s = String(rawName || '').toLowerCase();
  // P2P lines carry a free-text memo that differs every time; the payee is the
  // merchant, the memo is not.
  if (/\b(?:zelle|venmo|cash app|paypal)\b/.test(s)) {
    s = s.replace(/\bfor\b.*$/, ' ');
  }
  s = s.replace(/conf(irmation)?#\s*\S+/g, ' ');
  s = s.replace(/\b(?:id|indn|co id|trn|seq|ref|ppd|web|tel|arc|des):\S*/g, ' ');
  s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
  s = s.replace(/\b[a-z]*\d[a-z\d]{4,}\b/g, ' ');
  s = s.replace(/\b\d{3,}\b/g, ' ');
  s = s.replace(/\b(purchase|payment|pos|debit|card|recurring|checkcard|des)\b/g, ' ');
  s = s.replace(/[^a-z0-9&' ]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Words that carry no identity. Note how many of these are *bank* words rather
 * than English ones: zelle, venmo, des, indn and withdrwl appear on thousands
 * of unrelated lines, and treating them as evidence is what made an early
 * version of this match "SPACE COAST CU WITHDRWL" to Publix and "VENMO
 * DES:PAYMENT" to a child's debit card.
 */
const STOP_TOKENS = new Set([
  'the', 'and', 'inc', 'llc', 'corp', 'co', 'ltd', 'com', 'www', 'store',
  'usa', 'online', 'bill', 'pay', 'payment', 'payments', 'purchase', 'from',
  'transaction', 'transfer', 'withdrwl', 'withdrawal', 'deposit',
  'zelle', 'venmo', 'paypal', 'cash', 'app', 'des', 'indn', 'conf', 'ach',
  'checkcard', 'debit', 'credit', 'auto', 'service', 'services', 'llc',
]);

function identityTokens(stem: string): string[] {
  return stem.split(' ').filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/**
 * How rare is each token across this user's own descriptors?
 *
 * A fixed stop-list can only remove the words we thought of. Document
 * frequency removes the rest automatically: whatever a particular person's
 * bank stamps on every line becomes worthless as evidence, while the token
 * that names an actual merchant stays valuable. This is what makes the match
 * "this specific payee" rather than "two lines from the same bank".
 */
function buildTokenWeights(allTokens: string[][]): Map<string, number> {
  const docCount = allTokens.length || 1;
  const df = new Map<string, number>();
  for (const toks of allTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const weights = new Map<string, number>();
  for (const [t, n] of df) {
    // A token on more than 4% of lines is scaffolding, not a name.
    weights.set(t, n / docCount > 0.04 ? 0 : Math.log(docCount / n));
  }
  return weights;
}

/**
 * Weighted overlap: shared rare tokens count, shared common ones do not.
 * Returns 0 unless the two names share at least one genuinely distinctive
 * token, so nothing can match on scaffolding alone.
 */
function tokenSimilarity(a: string[], b: string[], weights: Map<string, number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a), sb = new Set(b);
  let sharedWeight = 0, totalWeight = 0, distinctiveShared = 0;
  for (const t of new Set([...sa, ...sb])) {
    const w = weights.get(t) ?? 0;
    totalWeight += w;
    if (sa.has(t) && sb.has(t)) {
      sharedWeight += w;
      if (w > 0) distinctiveShared++;
    }
  }
  if (distinctiveShared === 0 || totalWeight === 0) return 0;
  return sharedWeight / totalWeight;
}

export interface RecategorizeSuggestion {
  transactionId: string;
  name: string;
  suggestedCategoryId: string;
  confidence: number;
}

export interface RecategorizeSummary {
  scanned: number;
  changed: number;
  byRule: number;
  byMerchant: number;
  bySimilarity: number;
  stillUncategorized: number;
  /** Close-but-not-certain matches. Nothing was changed for these. */
  suggestions: RecategorizeSuggestion[];
}

/**
 * Re-run categorisation over every transaction the user already has, in place.
 *
 * Without this, improving a rule meant deleting and re-importing every
 * statement to see the benefit — which also throws away anything else about
 * those rows. This keeps ids, notes and edits and just re-decides the category.
 *
 * Three passes, most-certain first:
 *   1. the normal pipeline — user rules, then the merchant database, then the
 *      keyword map. User rules win, so hand corrections are never undone.
 *   2. merchant stem — a row inherits from other rows with the same payee,
 *      even when the descriptors differ in date and reference.
 *   3. similarity — token overlap, weighted by a repeating amount. A charge of
 *      the same size from a similarly-named payee, recurring, is the same
 *      thing; that is how a subscription or a monthly service shows up.
 *
 * Passes 2 and 3 only ever fill in a BLANK category. They never overrule a
 * category that a rule or the merchant database decided, and never overrule
 * the user.
 */
export async function recategorizeAll(userId: string): Promise<RecategorizeSummary> {
  const rules = await loadUserRules(userId);
  const categories = await db.all(
    'SELECT id, name FROM categories WHERE user_id = ?', userId,
  ) as Array<{ id: string; name: string }>;

  const byExactName = new Map<string, string>();
  for (const c of categories) byExactName.set(c.name.toLowerCase(), c.id);
  const resolveCategory = (name: string): string | null => {
    const lower = name.toLowerCase();
    const exact = byExactName.get(lower);
    if (exact) return exact;
    for (const c of categories) {
      if (c.name.toLowerCase().includes(lower)) return c.id;
    }
    return null;
  };

  // Collapse the legacy "Uncategorized" CATEGORY into the NULL bucket.
  //
  // A category that means "no category" gave every report two adjacent rows for
  // the same idea — the real category and the NULL bucket — which the monthly
  // matrix made impossible to miss. A row with no category IS uncategorised;
  // reports label the NULL bucket for display. Safe to run repeatedly, and it
  // leaves the empty category in place rather than risking a foreign key.
  const legacyUncat = await db.all(
    `SELECT id FROM categories WHERE user_id = ? AND LOWER(name) IN ('uncategorized', 'uncategorised')`,
    userId,
  ) as Array<{ id: string }>;
  for (const c of legacyUncat) {
    await db.run(
      'UPDATE transactions SET category_id = NULL WHERE user_id = ? AND category_id = ?',
      userId, c.id,
    );
  }

  const rows = await db.all(
    'SELECT id, name, amount, category_id as "categoryId", date, account_id as "accountId" FROM transactions WHERE user_id = ?',
    userId,
  ) as Array<{ id: string; name: string; amount: number; categoryId: string | null; date: string; accountId: string | null }>;

  const uncategorizedId = byExactName.get('uncategorized') ?? null;
  const isBlank = (id: string | null) => !id || id === uncategorizedId;

  const decided = new Map<string, string>();   // transaction id -> category id
  const suggestions: RecategorizeSuggestion[] = [];
  let byRule = 0, byMerchant = 0, bySimilarity = 0;

  // ---- Pass 1: the deterministic pipeline -------------------------------
  for (const r of rows) {
    const lower = String(r.name || '').toLowerCase().trim();

    const ruleHit = matchRuleList(lower, rules, r.amount, r.accountId);
    if (ruleHit?.categoryId) { decided.set(r.id, ruleHit.categoryId); byRule++; continue; }

    const merchant = lookupMerchant(lower);
    if (merchant) {
      const id = resolveCategory(merchant.category);
      if (id) { decided.set(r.id, id); byMerchant++; continue; }
    }

    for (const keyword of Object.keys(KEYWORD_CATEGORY_MAP).sort((a, b) => b.length - a.length)) {
      if (!keywordRegex(keyword).test(lower)) continue;
      const categoryName = KEYWORD_CATEGORY_MAP[keyword];
      if (categoryName === 'Income' && r.amount < 0) continue;
      const id = resolveCategory(categoryName);
      if (id) { decided.set(r.id, id); byMerchant++; }
      break;
    }
  }

  // Everything known so far, plus whatever the user had already set.
  const known = new Map<string, string>();
  for (const r of rows) {
    const id = decided.get(r.id) ?? (isBlank(r.categoryId) ? null : r.categoryId);
    if (id) known.set(r.id, id);
  }

  const stems = new Map<string, string>();
  for (const r of rows) stems.set(r.id, merchantStem(r.name));

  // ---- Pass 2: same payee ------------------------------------------------
  // What does this stem usually get called? Majority vote among rows that
  // already have an answer, so one stray edit cannot drag a whole merchant.
  const stemVotes = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const cat = known.get(r.id);
    const stem = stems.get(r.id)!;
    if (!cat || stem.length < 6) continue;
    if (!stemVotes.has(stem)) stemVotes.set(stem, new Map());
    const votes = stemVotes.get(stem)!;
    votes.set(cat, (votes.get(cat) ?? 0) + 1);
  }
  const stemWinner = new Map<string, string>();
  for (const [stem, votes] of stemVotes) {
    let best = '', bestN = 0;
    for (const [cat, n] of votes) if (n > bestN) { best = cat; bestN = n; }
    if (best) stemWinner.set(stem, best);
  }

  for (const r of rows) {
    if (known.has(r.id)) continue;
    const stem = stems.get(r.id)!;
    if (stem.length < 6) continue;
    const win = stemWinner.get(stem);
    if (win) { decided.set(r.id, win); known.set(r.id, win); bySimilarity++; }
  }

  // ---- Pass 3: close enough, and repeating -------------------------------
  // Index the rows that DO have an answer, by identity token and by amount, so
  // this stays linear-ish instead of comparing every row to every other row.
  const byToken = new Map<string, string[]>();          // token -> row ids
  const byAmount = new Map<string, string[]>();         // "12.34" -> row ids
  const tokensOf = new Map<string, string[]>();
  for (const r of rows) tokensOf.set(r.id, identityTokens(stems.get(r.id)!));
  const weights = buildTokenWeights([...tokensOf.values()]);
  for (const r of rows) {
    const toks = tokensOf.get(r.id)!;
    if (!known.has(r.id)) continue;
    for (const t of toks) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t)!.push(r.id);
    }
    const key = Math.abs(r.amount).toFixed(2);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key)!.push(r.id);
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));

  for (const r of rows) {
    if (known.has(r.id)) continue;
    const toks = tokensOf.get(r.id)!;
    if (toks.length === 0) continue;

    // Candidates: anything sharing an identity token, or the exact same amount
    // (a repeating charge of identical size is a strong signal on its own).
    const candidates = new Set<string>();
    for (const t of toks) for (const id of byToken.get(t) ?? []) candidates.add(id);
    for (const id of byAmount.get(Math.abs(r.amount).toFixed(2)) ?? []) candidates.add(id);

    let bestCat: string | null = null, bestScore = 0;
    for (const cid of candidates) {
      const other = rowById.get(cid)!;
      const nameScore = tokenSimilarity(toks, tokensOf.get(cid)!, weights);
      // No distinctive token in common means no match, whatever the amount.
      // The amount can only strengthen a name match, never stand in for one —
      // two unrelated $25.00 charges are not the same thing.
      if (nameScore <= 0) continue;
      // Opposite directions of money: a refund is not the purchase.
      if ((other.amount < 0) !== (r.amount < 0)) continue;
      let score = nameScore;
      // Same amount to the cent is the signature of a recurring commitment —
      // a subscription, a lesson, a monthly service.
      if (Math.abs(Math.abs(other.amount) - Math.abs(r.amount)) < 0.005) score += 0.2;
      if (score > bestScore) { bestScore = score; bestCat = known.get(cid)!; }
    }

    // Two bars, because the cost of the two mistakes is not symmetric. A blank
    // asks to be looked at; a wrong label quietly distorts a total nobody
    // re-checks. Measured against 2,629 real transactions, a 0.6 bar was right
    // about a third of the time — it matched a parking meter to a supermarket
    // because they share a city, and a credit-union withdrawal to Publix.
    //
    // So only a near-identical name applies itself ("T J MAXX #1203" against
    // "TJ MAXX # 1358" scores 1.00 — same shop, different store number and
    // spacing). Anything weaker is returned as a suggestion for the owner to
    // confirm, and changes nothing until they do.
    if (bestCat && bestScore >= 0.9) {
      decided.set(r.id, bestCat);
      known.set(r.id, bestCat);
      bySimilarity++;
    } else if (bestCat && bestScore >= 0.55) {
      suggestions.push({
        transactionId: r.id,
        name: r.name,
        suggestedCategoryId: bestCat,
        confidence: Math.round(bestScore * 100) / 100,
      });
    }
  }

  // ---- Write back only what actually changed -----------------------------
  const changedIds: string[] = [];
  const now = new Date().toISOString();
  await db.tx(async (t) => {
    for (const r of rows) {
      const next = decided.get(r.id);
      if (!next || next === r.categoryId) continue;
      await t.run(
        'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        next, now, r.id, userId,
      );
      changedIds.push(r.id);
    }
  });

  const stillUncategorized = rows.filter((r) => {
    const final = decided.get(r.id) ?? r.categoryId;
    return isBlank(final ?? null);
  }).length;

  return {
    scanned: rows.length,
    changed: changedIds.length,
    byRule, byMerchant, bySimilarity,
    stillUncategorized,
    suggestions: suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 50),
  };
}
