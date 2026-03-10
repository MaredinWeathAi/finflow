import { db } from '../db/database.js';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategorizationResult {
  categoryId: string | null;
  confidence: number;
  categoryName?: string;
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

  // 1. Check user's custom category_rules table
  const userRuleResult = matchUserRules(lowerName, userId);
  if (userRuleResult) {
    return userRuleResult;
  }

  // 2. Fall back to built-in keyword map
  const keywordResult = matchKeywordMap(lowerName, userId);
  if (keywordResult) {
    return keywordResult;
  }

  // 3. No match found
  return { categoryId: null, confidence: 0 };
}

// ---------------------------------------------------------------------------
// User custom rules matching
// ---------------------------------------------------------------------------

function matchUserRules(lowerName: string, userId: string): CategorizationResult | null {
  const rules = db
    .prepare(
      `SELECT cr.pattern, cr.category_id, cr.match_type, c.name as category_name
       FROM category_rules cr
       JOIN categories c ON c.id = cr.category_id
       WHERE cr.user_id = ?
       ORDER BY cr.match_type ASC`
    )
    .all(userId) as Array<{
      pattern: string;
      category_id: string;
      match_type: string;
      category_name: string;
    }>;

  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase();

    switch (rule.match_type) {
      case 'exact':
        if (lowerName === pattern) {
          return {
            categoryId: rule.category_id,
            confidence: 1.0,
            categoryName: rule.category_name,
          };
        }
        break;

      case 'contains':
        if (lowerName.includes(pattern)) {
          return {
            categoryId: rule.category_id,
            confidence: 0.8,
            categoryName: rule.category_name,
          };
        }
        break;

      case 'starts_with':
        if (lowerName.startsWith(pattern)) {
          return {
            categoryId: rule.category_id,
            confidence: 0.8,
            categoryName: rule.category_name,
          };
        }
        break;
    }
  }

  return null;
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
