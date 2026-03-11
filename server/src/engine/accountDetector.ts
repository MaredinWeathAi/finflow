// ---------------------------------------------------------------------------
// Account Detector
// Detects institution, account type, and account details from:
// 1. Filename patterns (e.g., "Amex_Statement_Jan2025.csv")
// 2. CSV/Excel headers (institution-specific column names)
// 3. Data content patterns (transaction descriptions, amounts)
// 4. Statement text content (for PDF fallback)
// ---------------------------------------------------------------------------

export interface DetectedAccount {
  institution: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'unknown';
  accountNumber: string;  // last 4 or full masked
  accountNickname: string;
  confidence: number; // 0-1
  source: string; // what triggered the detection
}

// ---------------------------------------------------------------------------
// Main Detection - tries multiple strategies
// ---------------------------------------------------------------------------

export function detectAccount(
  filename: string,
  headers: string[],
  sampleRows: Record<string, string>[],
  allDataRows?: Record<string, string>[]
): DetectedAccount | null {
  // Strategy 1: Filename-based detection (highest priority)
  const fromFilename = detectFromFilename(filename);
  if (fromFilename && fromFilename.confidence >= 0.7) {
    return fromFilename;
  }

  // Strategy 2: Header-based detection (institution-specific columns)
  const fromHeaders = detectFromHeaders(headers);
  if (fromHeaders && fromHeaders.confidence >= 0.6) {
    // Merge with filename info if available
    if (fromFilename) {
      return {
        ...fromHeaders,
        institution: fromHeaders.institution || fromFilename.institution,
        accountNumber: fromHeaders.accountNumber || fromFilename.accountNumber,
        confidence: Math.max(fromHeaders.confidence, fromFilename.confidence),
      };
    }
    return fromHeaders;
  }

  // Strategy 3: Data content analysis
  const fromContent = detectFromContent(headers, sampleRows, allDataRows);
  if (fromContent && fromContent.confidence >= 0.5) {
    // Merge with previous detections
    const base = fromFilename || fromHeaders;
    if (base) {
      return {
        ...fromContent,
        institution: fromContent.institution || base.institution,
        accountNumber: fromContent.accountNumber || base.accountNumber,
        confidence: Math.max(fromContent.confidence, base.confidence),
      };
    }
    return fromContent;
  }

  // Return best guess from filename if we have one
  if (fromFilename) return fromFilename;
  if (fromHeaders) return fromHeaders;

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 1: Filename Detection
// ---------------------------------------------------------------------------

interface FilenamePattern {
  pattern: RegExp;
  institution: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment';
  confidence: number;
}

const FILENAME_PATTERNS: FilenamePattern[] = [
  // American Express
  { pattern: /amex/i, institution: 'American Express', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /american\s*express/i, institution: 'American Express', accountType: 'credit_card', confidence: 0.95 },
  { pattern: /amex.*statement/i, institution: 'American Express', accountType: 'credit_card', confidence: 0.95 },

  // Chase
  { pattern: /chase.*credit/i, institution: 'Chase', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /chase.*checking/i, institution: 'Chase', accountType: 'checking', confidence: 0.9 },
  { pattern: /chase.*saving/i, institution: 'Chase', accountType: 'savings', confidence: 0.9 },
  { pattern: /chase.*sapphire/i, institution: 'Chase', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /chase.*freedom/i, institution: 'Chase', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /chase/i, institution: 'Chase', accountType: 'checking', confidence: 0.6 },

  // Capital One
  { pattern: /capital\s*one.*credit/i, institution: 'Capital One', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /capital\s*one.*venture/i, institution: 'Capital One', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /capital\s*one.*quicksilver/i, institution: 'Capital One', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /capital\s*one.*sav/i, institution: 'Capital One', accountType: 'savings', confidence: 0.9 },
  { pattern: /capital\s*one/i, institution: 'Capital One', accountType: 'credit_card', confidence: 0.7 },

  // Citi
  { pattern: /citi.*card/i, institution: 'Citi', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /citi.*credit/i, institution: 'Citi', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /citi.*double\s*cash/i, institution: 'Citi', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /citi.*checking/i, institution: 'Citi', accountType: 'checking', confidence: 0.9 },
  { pattern: /citi/i, institution: 'Citi', accountType: 'credit_card', confidence: 0.6 },

  // Discover
  { pattern: /discover/i, institution: 'Discover', accountType: 'credit_card', confidence: 0.85 },

  // Bank of America
  { pattern: /bofa|bank\s*of\s*america/i, institution: 'Bank of America', accountType: 'checking', confidence: 0.7 },
  { pattern: /bofa.*credit|bank\s*of\s*america.*credit/i, institution: 'Bank of America', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /bofa.*check|bank\s*of\s*america.*check/i, institution: 'Bank of America', accountType: 'checking', confidence: 0.9 },

  // Wells Fargo
  { pattern: /wells?\s*fargo.*credit/i, institution: 'Wells Fargo', accountType: 'credit_card', confidence: 0.9 },
  { pattern: /wells?\s*fargo.*checking/i, institution: 'Wells Fargo', accountType: 'checking', confidence: 0.9 },
  { pattern: /wells?\s*fargo/i, institution: 'Wells Fargo', accountType: 'checking', confidence: 0.6 },

  // US Bank
  { pattern: /us\s*bank/i, institution: 'US Bank', accountType: 'checking', confidence: 0.6 },

  // TD Bank
  { pattern: /td\s*bank/i, institution: 'TD Bank', accountType: 'checking', confidence: 0.6 },

  // PNC
  { pattern: /pnc/i, institution: 'PNC', accountType: 'checking', confidence: 0.6 },

  // USAA
  { pattern: /usaa/i, institution: 'USAA', accountType: 'checking', confidence: 0.6 },

  // Navy Federal
  { pattern: /navy\s*federal/i, institution: 'Navy Federal', accountType: 'checking', confidence: 0.6 },

  // Marcus / Goldman Sachs
  { pattern: /marcus/i, institution: 'Marcus by Goldman Sachs', accountType: 'savings', confidence: 0.85 },

  // Ally
  { pattern: /ally/i, institution: 'Ally Bank', accountType: 'savings', confidence: 0.7 },

  // Fidelity
  { pattern: /fidelity/i, institution: 'Fidelity', accountType: 'investment', confidence: 0.8 },

  // Schwab
  { pattern: /schwab/i, institution: 'Charles Schwab', accountType: 'investment', confidence: 0.8 },

  // Vanguard
  { pattern: /vanguard/i, institution: 'Vanguard', accountType: 'investment', confidence: 0.8 },

  // Generic type indicators in filename
  { pattern: /credit\s*card/i, institution: '', accountType: 'credit_card', confidence: 0.8 },
  { pattern: /checking/i, institution: '', accountType: 'checking', confidence: 0.8 },
  { pattern: /savings?/i, institution: '', accountType: 'savings', confidence: 0.7 },
  { pattern: /investment/i, institution: '', accountType: 'investment', confidence: 0.7 },
  { pattern: /brokerage/i, institution: '', accountType: 'investment', confidence: 0.7 },
  { pattern: /mortgage/i, institution: '', accountType: 'loan', confidence: 0.8 },
  { pattern: /loan/i, institution: '', accountType: 'loan', confidence: 0.7 },
];

function detectFromFilename(filename: string): DetectedAccount | null {
  const cleanName = filename.replace(/\.[^.]+$/, ''); // Remove extension

  // Try to extract account number from filename (last 4 digits pattern)
  let accountNumber = '';
  const acctNumMatch = cleanName.match(/[-_x*](\d{4})(?:\D|$)/);
  if (acctNumMatch) {
    accountNumber = acctNumMatch[1];
  }

  for (const fp of FILENAME_PATTERNS) {
    if (fp.pattern.test(cleanName)) {
      const nickname = fp.institution
        ? `${fp.institution} ${formatAccountType(fp.accountType)}${accountNumber ? ' ' + accountNumber : ''}`
        : `${formatAccountType(fp.accountType)}${accountNumber ? ' ' + accountNumber : ''}`;

      return {
        institution: fp.institution,
        accountType: fp.accountType,
        accountNumber,
        accountNickname: nickname,
        confidence: fp.confidence,
        source: 'filename',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategy 2: Header Detection
// ---------------------------------------------------------------------------

interface HeaderSignature {
  requiredHeaders: string[];
  optionalHeaders?: string[];
  institution: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'unknown';
  confidence: number;
}

const HEADER_SIGNATURES: HeaderSignature[] = [
  // American Express CSV export
  {
    requiredHeaders: ['date', 'description', 'amount'],
    optionalHeaders: ['extended details', 'appears on your statement as', 'address', 'city/state', 'zip code', 'country', 'reference', 'category'],
    institution: 'American Express',
    accountType: 'credit_card',
    confidence: 0.85,
  },
  // Amex alternate format
  {
    requiredHeaders: ['date', 'description', 'card member', 'amount'],
    institution: 'American Express',
    accountType: 'credit_card',
    confidence: 0.9,
  },
  // Amex another format
  {
    requiredHeaders: ['date', 'receipt', 'description', 'amount'],
    institution: 'American Express',
    accountType: 'credit_card',
    confidence: 0.85,
  },
  // Chase credit card CSV
  {
    requiredHeaders: ['transaction date', 'post date', 'description', 'category', 'type', 'amount'],
    institution: 'Chase',
    accountType: 'credit_card',
    confidence: 0.9,
  },
  // Chase checking CSV
  {
    requiredHeaders: ['details', 'posting date', 'description', 'amount', 'type', 'balance', 'check or slip #'],
    institution: 'Chase',
    accountType: 'checking',
    confidence: 0.9,
  },
  // Capital One CSV
  {
    requiredHeaders: ['transaction date', 'posted date', 'card no.', 'description', 'category', 'debit', 'credit'],
    institution: 'Capital One',
    accountType: 'credit_card',
    confidence: 0.9,
  },
  // Citi CSV
  {
    requiredHeaders: ['status', 'date', 'description', 'debit', 'credit'],
    institution: 'Citi',
    accountType: 'credit_card',
    confidence: 0.85,
  },
  // Discover CSV
  {
    requiredHeaders: ['trans. date', 'post date', 'description', 'amount', 'category'],
    institution: 'Discover',
    accountType: 'credit_card',
    confidence: 0.9,
  },
  // Bank of America checking CSV
  {
    requiredHeaders: ['date', 'description', 'amount', 'running bal.'],
    institution: 'Bank of America',
    accountType: 'checking',
    confidence: 0.85,
  },
  // Wells Fargo CSV
  {
    requiredHeaders: ['date', 'amount', 'description'],
    optionalHeaders: ['balance'],
    institution: 'Wells Fargo',
    accountType: 'checking',
    confidence: 0.6, // lower confidence - generic headers
  },
  // Generic credit card indicators in headers
  {
    requiredHeaders: ['card no.'],
    institution: '',
    accountType: 'credit_card',
    confidence: 0.75,
  },
  {
    requiredHeaders: ['card number'],
    institution: '',
    accountType: 'credit_card',
    confidence: 0.75,
  },
  {
    requiredHeaders: ['card member'],
    institution: '',
    accountType: 'credit_card',
    confidence: 0.75,
  },
  // Running balance usually means checking/savings
  {
    requiredHeaders: ['running bal.'],
    institution: '',
    accountType: 'checking',
    confidence: 0.6,
  },
  {
    requiredHeaders: ['balance'],
    institution: '',
    accountType: 'checking',
    confidence: 0.4,
  },
];

function detectFromHeaders(headers: string[]): DetectedAccount | null {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  let bestMatch: DetectedAccount | null = null;
  let bestScore = 0;

  for (const sig of HEADER_SIGNATURES) {
    const requiredMatches = sig.requiredHeaders.filter(req =>
      lowerHeaders.some(h => h === req.toLowerCase() || h.includes(req.toLowerCase()))
    ).length;

    const requiredTotal = sig.requiredHeaders.length;
    const matchRatio = requiredMatches / requiredTotal;

    // Need at least 70% of required headers to match
    if (matchRatio < 0.7) continue;

    // Boost score if optional headers also match
    let optionalBoost = 0;
    if (sig.optionalHeaders) {
      const optMatches = sig.optionalHeaders.filter(opt =>
        lowerHeaders.some(h => h === opt.toLowerCase() || h.includes(opt.toLowerCase()))
      ).length;
      optionalBoost = (optMatches / sig.optionalHeaders.length) * 0.15;
    }

    const score = matchRatio * sig.confidence + optionalBoost;

    if (score > bestScore) {
      bestScore = score;

      // Try to find account number in headers
      let accountNumber = '';
      const cardNoIdx = lowerHeaders.findIndex(h => h.includes('card no') || h.includes('card number') || h.includes('account'));
      if (cardNoIdx >= 0) {
        // We'll need to look at sample data for this
        accountNumber = '';
      }

      bestMatch = {
        institution: sig.institution,
        accountType: sig.accountType,
        accountNumber,
        accountNickname: sig.institution
          ? `${sig.institution} ${formatAccountType(sig.accountType)}`
          : formatAccountType(sig.accountType),
        confidence: Math.min(score, 1.0),
        source: 'headers',
      };
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Strategy 3: Content Analysis
// ---------------------------------------------------------------------------

function detectFromContent(
  headers: string[],
  sampleRows: Record<string, string>[],
  allDataRows?: Record<string, string>[]
): DetectedAccount | null {
  const rows = allDataRows || sampleRows;
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  // Look for card number in data
  let cardNumber = '';
  const cardNoCol = lowerHeaders.findIndex(h =>
    h.includes('card no') || h.includes('card number') || h.includes('account') || h.includes('card member')
  );
  if (cardNoCol >= 0) {
    const headerName = headers[cardNoCol];
    for (const row of sampleRows) {
      const val = (row[headerName] || '').trim();
      // Typical: last 4 digits or masked number like "XXXX-XXXX-XXXX-1234"
      const last4Match = val.match(/(\d{4})\s*$/);
      if (last4Match) {
        cardNumber = last4Match[1];
        break;
      }
      // Just digits
      if (/^\d{4,}$/.test(val.replace(/[\s-]/g, ''))) {
        const digits = val.replace(/[\s-]/g, '');
        cardNumber = digits.slice(-4);
        break;
      }
    }
  }

  // Analyze transaction descriptions for institution clues
  const allDescriptions: string[] = [];
  const descCol = lowerHeaders.findIndex(h =>
    h.includes('description') || h.includes('name') || h.includes('memo') || h.includes('payee')
  );
  if (descCol >= 0) {
    const headerName = headers[descCol];
    for (const row of rows.slice(0, 50)) {
      const val = (row[headerName] || '').trim();
      if (val) allDescriptions.push(val.toLowerCase());
    }
  }

  // Analyze amounts to determine if this is a credit card
  const amountCol = lowerHeaders.findIndex(h => h.includes('amount'));
  const debitCol = lowerHeaders.findIndex(h => h.includes('debit'));
  const creditCol = lowerHeaders.findIndex(h => h.includes('credit'));

  let positiveCount = 0;
  let negativeCount = 0;
  const amtHeaderName = amountCol >= 0 ? headers[amountCol] : '';

  if (amtHeaderName) {
    for (const row of rows.slice(0, 100)) {
      const val = parseFloat((row[amtHeaderName] || '0').replace(/[$,]/g, ''));
      if (val > 0) positiveCount++;
      else if (val < 0) negativeCount++;
    }
  }

  // Credit card statements often have mostly positive amounts (charges)
  // with occasional negative (payments/credits) — opposite of checking
  // But Amex uses negative for charges, so check both patterns
  const totalAmounts = positiveCount + negativeCount;

  // Look for Amex-specific content patterns
  const hasAmexPatterns = allDescriptions.some(d =>
    /amex|american express|membership reward/i.test(d)
  );

  // Check for "appears on your statement as" column (Amex-specific)
  const hasAmexColumn = lowerHeaders.some(h =>
    h.includes('appears on your statement') || h.includes('extended details')
  );

  if (hasAmexPatterns || hasAmexColumn) {
    return {
      institution: 'American Express',
      accountType: 'credit_card',
      accountNumber: cardNumber,
      accountNickname: `American Express${cardNumber ? ' ' + cardNumber : ''}`,
      confidence: hasAmexColumn ? 0.9 : 0.75,
      source: 'content',
    };
  }

  // Look for other CC indicators in descriptions
  const ccPaymentPatterns = allDescriptions.filter(d =>
    /interest charge|finance charge|late fee|minimum payment|annual fee|cash advance fee|payment.*thank/i.test(d)
  ).length;

  if (ccPaymentPatterns >= 1) {
    return {
      institution: '',
      accountType: 'credit_card',
      accountNumber: cardNumber,
      accountNickname: `Credit Card${cardNumber ? ' ' + cardNumber : ''}`,
      confidence: 0.7,
      source: 'content',
    };
  }

  // Check for checking account indicators
  const checkingPatterns = allDescriptions.filter(d =>
    /direct deposit|payroll|ach.*credit|check.*\d{3,}|atm withdrawal|overdraft/i.test(d)
  ).length;

  if (checkingPatterns >= 2) {
    return {
      institution: '',
      accountType: 'checking',
      accountNumber: cardNumber,
      accountNickname: `Checking${cardNumber ? ' ' + cardNumber : ''}`,
      confidence: 0.6,
      source: 'content',
    };
  }

  // If card number found, likely a credit card
  if (cardNumber && cardNoCol >= 0) {
    return {
      institution: '',
      accountType: 'credit_card',
      accountNumber: cardNumber,
      accountNickname: `Credit Card ${cardNumber}`,
      confidence: 0.65,
      source: 'content',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAccountType(type: string): string {
  switch (type) {
    case 'credit_card': return 'Credit Card';
    case 'checking': return 'Checking';
    case 'savings': return 'Savings';
    case 'investment': return 'Investment';
    case 'loan': return 'Loan';
    default: return 'Account';
  }
}
