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
  'mortgage': 'Housing',
  'airbnb': 'Housing',
  'hoa': 'Housing',
  'property tax': 'Housing',
  'apartment': 'Housing',
  'lease': 'Housing',
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

export function categorizeItem(
  name: string,
  amount: number,
  userId: string
): CategorizationResult {
  const lowerName = name.toLowerCase().trim();

  // 1. Check user's custom category_rules table (highest priority — user overrides)
  const userRuleResult = matchUserRules(lowerName, userId, amount);
  if (userRuleResult) {
    return userRuleResult;
  }

  // 2. Smart Merchant Recognition — 1500+ known US merchants & brands
  const merchantResult = matchMerchantDb(lowerName, userId);
  if (merchantResult) {
    return merchantResult;
  }

  // 3. Fall back to built-in keyword map (generic terms like "restaurant", "gas")
  const keywordResult = matchKeywordMap(lowerName, userId);
  if (keywordResult) {
    return keywordResult;
  }

  // 4. No match found
  return { categoryId: null, confidence: 0 };
}

// ---------------------------------------------------------------------------
// User custom rules matching
// ---------------------------------------------------------------------------

function matchUserRules(lowerName: string, userId: string, amount?: number): CategorizationResult | null {
  const rules = db
    .prepare(
      `SELECT cr.pattern, cr.category_id, cr.match_type, c.name as category_name,
              cr.amount_min, cr.amount_max, cr.amount_exact, cr.account_id, cr.is_enabled, cr.priority,
              cr.assign_type
       FROM category_rules cr
       JOIN categories c ON c.id = cr.category_id
       WHERE cr.user_id = ? AND (cr.is_enabled = 1 OR cr.is_enabled IS NULL)
       ORDER BY cr.priority DESC, cr.match_type ASC`
    )
    .all(userId) as any[];

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
        case 'contains':
        default:
          // Word-based matching: ALL words in the pattern must appear in the name
          // e.g. "zelle received" matches "Zelle Payment Received"
          const words = pattern.split(/\s+/).filter(Boolean);
          nameMatch = words.length > 0 && words.every((w: string) => lowerName.includes(w));
          break;
      }
      if (!nameMatch) continue;
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

function matchMerchantDb(lowerName: string, userId: string): CategorizationResult | null {
  const merchant = lookupMerchant(lowerName);
  if (!merchant) return null;

  // Map the merchant's category name to the user's category ID
  const categoryId = getCategoryByKeyword(merchant.category, userId);

  return {
    categoryId,
    confidence: merchant.confidence,
    categoryName: merchant.category,
  };
}

// ---------------------------------------------------------------------------
// Built-in keyword matching
// ---------------------------------------------------------------------------

function matchKeywordMap(lowerName: string, userId: string): CategorizationResult | null {
  // Sort keywords by length descending so more specific matches win first
  // e.g., "uber eats" should match before "uber"
  const sortedKeywords = Object.keys(KEYWORD_CATEGORY_MAP).sort(
    (a, b) => b.length - a.length
  );

  for (const keyword of sortedKeywords) {
    if (lowerName.includes(keyword)) {
      const categoryName = KEYWORD_CATEGORY_MAP[keyword];
      const categoryId = getCategoryByKeyword(categoryName, userId);

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

export function learnRule(
  userId: string,
  pattern: string,
  categoryId: string,
  matchType: string
): void {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO category_rules (id, user_id, pattern, category_id, match_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, pattern, categoryId, matchType, createdAt);
}

// ---------------------------------------------------------------------------
// Helper: look up a category ID by matching the keyword to category name
// ---------------------------------------------------------------------------

export function getCategoryByKeyword(keyword: string, userId: string): string | null {
  const lowerKeyword = keyword.toLowerCase();

  // Try exact match first
  const exact = db
    .prepare(
      `SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) = ?`
    )
    .get(userId, lowerKeyword) as { id: string; name: string } | undefined;

  if (exact) {
    return exact.id;
  }

  // Try LIKE match (partial / contains)
  const partial = db
    .prepare(
      `SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) LIKE ?`
    )
    .get(userId, `%${lowerKeyword}%`) as { id: string; name: string } | undefined;

  if (partial) {
    return partial.id;
  }

  return null;
}
