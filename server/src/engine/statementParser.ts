// ---------------------------------------------------------------------------
// Bank Statement Parser
// Intelligent parser for recognizing and extracting structured data from
// bank statements (checking, savings, credit cards, etc.)
// ---------------------------------------------------------------------------

export interface StatementMetadata {
  institution: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'unknown';
  accountNumber: string;
  accountNickname: string;  // e.g., "CHK 8434", "CC 7533"
  statementPeriod: { start: string; end: string };
  beginningBalance: number;
  endingBalance: number;
  ownerName: string;
}

export interface ParsedTransaction {
  date: string;
  postingDate?: string;
  description: string;
  amount: number;
  section: string;
  isTransfer: boolean;
  transferType?: string;
  transferAccountRef?: string;
  merchantName?: string;
  category?: string;
  flags: string[];
  rawLine: string;
}

export interface StatementParseResult {
  metadata: StatementMetadata;
  transactions: ParsedTransaction[];
  summary: {
    totalDeposits: number;
    totalWithdrawals: number;
    totalTransfers: number;
    totalFees: number;
    totalInterest: number;
    transactionCount: number;
    transferCount: number;
  };
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main parser entry point
// ---------------------------------------------------------------------------

export function parseStatement(text: string): StatementParseResult | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Try to detect statement type
  const statementType = detectStatementType(text);
  if (!statementType) {
    return null;
  }

  // Parse based on detected type
  if (statementType.type === 'bofa_checking') {
    return parseBofaChecking(text, lines);
  } else if (statementType.type === 'bofa_credit_card') {
    return parseBofaCreditCard(text, lines);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Statement Type Detection
// ---------------------------------------------------------------------------

interface DetectedStatement {
  type: 'bofa_checking' | 'bofa_credit_card';
  title: string;
}

function detectStatementType(text: string): DetectedStatement | null {
  // Bank of America Checking patterns
  if (/Your Regular Checking|Your Adv Plus Banking|Your Adv Tiered Interest Chkg/i.test(text)) {
    return { type: 'bofa_checking', title: 'Bank of America Checking' };
  }

  // Bank of America Credit Card patterns
  if (/Visa Signature|American Express|MasterCard/i.test(text) && /Account#\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}/i.test(text)) {
    return { type: 'bofa_credit_card', title: 'Bank of America Credit Card' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// BofA Checking Parser
// ---------------------------------------------------------------------------

function parseBofaChecking(fullText: string, lines: string[]): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Extract metadata
  const metadata = extractBofaCheckingMetadata(fullText, lines, errors);

  // Find and parse sections
  let currentSection = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect section headers
    if (/Deposits and other additions/i.test(line)) {
      currentSection = 'deposits';
      i++;
      continue;
    } else if (/Withdrawals and other subtractions/i.test(line)) {
      currentSection = 'withdrawals';
      i++;
      continue;
    } else if (/Checks/i.test(line) && currentSection) {
      currentSection = 'checks';
      i++;
      continue;
    } else if (/Service fees/i.test(line)) {
      currentSection = 'fees';
      i++;
      continue;
    }

    // Skip header lines and total lines
    if (!line || /^Date\s+Description\s+Amount$/i.test(line) || /^Total\s+/i.test(line)) {
      i++;
      continue;
    }

    // Try to parse transaction line
    if (currentSection) {
      const dateMatch = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2})\s+(.+)/);
      if (dateMatch) {
        const [, rawDate, rest] = dateMatch;
        const amountMatch = rest.match(/\s+([\d,]+\.\d{2})$/);

        if (amountMatch) {
          const description = rest.slice(0, amountMatch.index).trim();
          const rawAmount = amountMatch[1];

          // Accumulate continuation lines
          let fullDescription = description;
          let j = i + 1;
          while (j < lines.length) {
            const nextLine = lines[j];
            // Continuation line: no date at start, but has content
            if (nextLine && !nextLine.match(/^\d{1,2}\/\d{1,2}\/\d{2}/)) {
              fullDescription += ' ' + nextLine;
              j++;
            } else {
              break;
            }
          }
          i = j - 1;

          try {
            const txn = parseBofaCheckingTransaction(
              rawDate,
              fullDescription,
              rawAmount,
              currentSection,
              metadata
            );
            transactions.push(txn);
          } catch (err: any) {
            errors.push(`BofA Checking line parse error: ${err.message}`);
          }
        }
      }
    }

    i++;
  }

  // Calculate summary
  const summary = calculateSummary(transactions);

  return {
    metadata,
    transactions,
    summary,
    errors,
  };
}

function extractBofaCheckingMetadata(
  fullText: string,
  lines: string[],
  errors: string[]
): StatementMetadata {
  let accountNumber = '';
  let accountNickname = '';
  let ownerName = '';
  let statementStart = '';
  let statementEnd = '';
  let beginningBalance = 0;
  let endingBalance = 0;

  // Extract account number
  let match = fullText.match(/Account\s+(?:number|#):\s*([X\d\s]+)/i);
  if (match) {
    accountNumber = match[1].replace(/\s+/g, ' ').trim();
    // Try to extract last 4 digits for nickname
    const last4 = accountNumber.match(/\d{4}$/);
    if (last4) {
      accountNickname = `CHK ${last4[0]}`;
    }
  }

  // Extract owner name
  match = fullText.match(/Account\s+Holder:\s*(.+?)(?:\n|$)/i);
  if (match) {
    ownerName = match[1].trim();
  }

  // Extract statement period
  match = fullText.match(/Statement\s+(?:Period|Date).*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:to|through|-|–)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (match) {
    statementStart = normalizeDate(match[1]);
    statementEnd = normalizeDate(match[2]);
  }

  // Extract beginning and ending balance
  match = fullText.match(/Beginning\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) {
    beginningBalance = normalizeAmount(match[1]);
  }

  match = fullText.match(/Ending\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) {
    endingBalance = normalizeAmount(match[1]);
  }

  return {
    institution: 'Bank of America',
    accountType: 'checking',
    accountNumber,
    accountNickname,
    statementPeriod: { start: statementStart, end: statementEnd },
    beginningBalance,
    endingBalance,
    ownerName,
  };
}

function parseBofaCheckingTransaction(
  rawDate: string,
  description: string,
  rawAmount: string,
  section: string,
  metadata: StatementMetadata
): ParsedTransaction {
  const date = normalizeDate(rawDate, new Date().getFullYear());
  const amount = normalizeAmount(rawAmount);

  // Determine actual sign based on section
  let signedAmount = amount;
  if (section === 'withdrawals' || section === 'checks' || section === 'fees') {
    signedAmount = -Math.abs(amount);
  } else if (section === 'deposits') {
    signedAmount = Math.abs(amount);
  }

  // Detect transfer
  const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);

  // Clean merchant name
  const merchantName = cleanMerchantName(description);

  // Auto-categorize
  const category = autoCategorize(description, isTransfer);

  // Extract flags
  const flags = extractFlags(description);

  return {
    date,
    description,
    amount: signedAmount,
    section,
    isTransfer,
    transferType,
    transferAccountRef,
    merchantName,
    category,
    flags,
    rawLine: description,
  };
}

// ---------------------------------------------------------------------------
// BofA Credit Card Parser
// ---------------------------------------------------------------------------

function parseBofaCreditCard(fullText: string, lines: string[]): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Extract metadata
  const metadata = extractBofaCreditCardMetadata(fullText, lines, errors);

  // Find and parse sections
  let currentSection = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect section headers
    if (/Payments and Other Credits/i.test(line)) {
      currentSection = 'payments';
      i++;
      continue;
    } else if (/Purchases and Adjustments/i.test(line)) {
      currentSection = 'purchases';
      i++;
      continue;
    } else if (/Interest Charged/i.test(line)) {
      currentSection = 'interest';
      i++;
      continue;
    }

    // Skip headers and totals
    if (!line || /^TOTAL\s+/i.test(line) || /^Trans|^Post/i.test(line)) {
      i++;
      continue;
    }

    // CC transaction line formats:
    // MM/DD MM/DD DESCRIPTION REFNUM ACCTLAST4 AMOUNT  (normal)
    // MM/DD MM/DD DESCRIPTION REFNUM ACCTLAST4 -AMOUNT (payments/credits)
    // MM/DD MM/DD INTEREST CHARGED ON ... AMOUNT (no ref/acct)
    if (currentSection) {
      // Pattern 1: with ref number and account suffix
      let ccMatch = line.match(/^(\d{1,2}\/\d{1,2})\s+(\d{1,2}\/\d{1,2})\s+(.+?)\s+(\d{4})\s+(\d{4})\s+(-?[\d,]+\.\d{2})$/);
      if (!ccMatch) {
        // Pattern 2: interest lines without ref/acct
        ccMatch = line.match(/^(\d{1,2}\/\d{1,2})\s+(\d{1,2}\/\d{1,2})\s+(INTEREST CHARGED.+?)\s+(-?[\d,]+\.\d{2})$/);
        if (ccMatch) {
          // Pad missing fields
          ccMatch = [...ccMatch.slice(0, 4), '', '', ccMatch[4]] as any;
        }
      }
      if (ccMatch) {
        const txDate = ccMatch[1];
        const postDate = ccMatch[2];
        const description = ccMatch[3];
        const rawAmount = ccMatch[ccMatch.length - 1] || ccMatch[6];

        try {
          const txn = parseBofaCreditCardTransaction(
            txDate,
            postDate,
            description,
            rawAmount,
            currentSection,
            metadata
          );
          transactions.push(txn);
        } catch (err: any) {
          errors.push(`BofA CC line parse error: ${err.message}`);
        }
      }
    }

    i++;
  }

  // Calculate summary
  const summary = calculateSummary(transactions);

  return {
    metadata,
    transactions,
    summary,
    errors,
  };
}

function extractBofaCreditCardMetadata(
  fullText: string,
  lines: string[],
  errors: string[]
): StatementMetadata {
  let accountNumber = '';
  let accountNickname = '';
  let ownerName = '';
  let statementStart = '';
  let statementEnd = '';
  let beginningBalance = 0;
  let endingBalance = 0;

  // Extract account number
  let match = fullText.match(/Account#\s*(\d{4})\s+(\d{4})\s+(\d{4})\s+(\d{4})/);
  if (match) {
    accountNumber = `${match[1]} ${match[2]} ${match[3]} ${match[4]}`;
    accountNickname = `CC ${match[4]}`;
  }

  // Extract owner name
  match = fullText.match(/Cardholder:\s*(.+?)(?:\n|$)/i);
  if (match) {
    ownerName = match[1].trim();
  }

  // Extract statement period - try numeric format first
  match = fullText.match(/Statement\s+(?:Period|Date).*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:to|through|-|–)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (match) {
    statementStart = normalizeDate(match[1]);
    statementEnd = normalizeDate(match[2]);
  }

  // Try text date format: "September 18 - October 17, 2025"
  if (!statementStart || !statementEnd) {
    match = fullText.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
    if (match) {
      const [, startMonth, startDay, endMonth, endDay, year] = match;
      const startMonthNum = monthNameToNumber(startMonth);
      const endMonthNum = monthNameToNumber(endMonth);
      if (startMonthNum && endMonthNum) {
        statementStart = `${year}-${String(startMonthNum).padStart(2, '0')}-${startDay.padStart(2, '0')}`;
        statementEnd = `${year}-${String(endMonthNum).padStart(2, '0')}-${endDay.padStart(2, '0')}`;
      }
    }
  }

  // For CC: extract previous balance / credit limit
  match = fullText.match(/Previous\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) {
    beginningBalance = normalizeAmount(match[1]);
  }

  // Get ending balance
  match = fullText.match(/New\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) {
    endingBalance = normalizeAmount(match[1]);
  }

  return {
    institution: 'Bank of America',
    accountType: 'credit_card',
    accountNumber,
    accountNickname,
    statementPeriod: { start: statementStart, end: statementEnd },
    beginningBalance,
    endingBalance,
    ownerName,
  };
}

function parseBofaCreditCardTransaction(
  txDate: string,
  postDate: string,
  description: string,
  rawAmount: string,
  section: string,
  metadata: StatementMetadata
): ParsedTransaction {
  // Infer year from statement period
  const periodYear = metadata.statementPeriod.end.split('-')[0];
  const date = normalizeDate(txDate, parseInt(periodYear, 10));
  const postingDate = normalizeDate(postDate, parseInt(periodYear, 10));
  const amount = normalizeAmount(rawAmount);

  // Determine sign based on section and raw amount
  // Raw amounts from BofA CC statements already have sign for payments (negative)
  let signedAmount = amount;
  if (section === 'payments' && amount > 0) {
    signedAmount = -Math.abs(amount);
  } else if (section === 'purchases' || section === 'interest') {
    signedAmount = Math.abs(amount);
  }

  // Detect transfer
  const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);

  // Clean merchant name
  const merchantName = cleanMerchantName(description);

  // Auto-categorize
  const category = autoCategorize(description, isTransfer);

  // Extract flags
  const flags = extractFlags(description);

  return {
    date,
    postingDate,
    description,
    amount: signedAmount,
    section,
    isTransfer,
    transferType,
    transferAccountRef,
    merchantName,
    category,
    flags,
    rawLine: description,
  };
}

// ---------------------------------------------------------------------------
// Transfer Detection
// ---------------------------------------------------------------------------

function detectTransfer(description: string): {
  isTransfer: boolean;
  transferType?: string;
  transferAccountRef?: string;
} {
  const desc = description.toUpperCase();

  // Internal transfer patterns
  const transferPatterns = [
    { pattern: /Online Banking transfer from (CHK|SAV|CRD)\s+(\d+)/i, type: 'transfer_from' },
    { pattern: /Online Banking transfer to (CHK|SAV|CRD)\s+(\d+)/i, type: 'transfer_to' },
    { pattern: /Online scheduled transfer to (CHK|SAV|CRD)\s+(\d+)/i, type: 'transfer_to' },
    { pattern: /Online Banking payment to (CHK|SAV|CRD)\s+(\d+)/i, type: 'cc_payment' },
    { pattern: /Automatic Transfer to (CHK|SAV|CRD)\s+(\d+)/i, type: 'auto_transfer' },
    { pattern: /OVERDRAFT PROTECTION TO (\d+)/i, type: 'overdraft_to' },
    { pattern: /OVERDRAFT PROTECTION FROM (\d+)/i, type: 'overdraft_from' },
    { pattern: /TRANSFER NAME:/i, type: 'self_transfer' },
    { pattern: /Online payment from (CHK|SAV)\s+(\d+)/i, type: 'payment_from' },
    { pattern: /STATEMENT CREDIT/i, type: 'statement_credit' },
  ];

  for (const { pattern, type } of transferPatterns) {
    const match = description.match(pattern);
    if (match) {
      const accountRef = match[1] ? `${match[1].toUpperCase()} ${match[2] || ''}`.trim() : undefined;
      return {
        isTransfer: true,
        transferType: type,
        transferAccountRef: accountRef,
      };
    }
  }

  return { isTransfer: false };
}

// ---------------------------------------------------------------------------
// Merchant Name Cleaning
// ---------------------------------------------------------------------------

function cleanMerchantName(description: string): string {
  // Remove common prefixes
  let cleaned = description
    .replace(/^CHECKCARD\s+\d{4}\s+/i, '')
    .replace(/^PURCHASE\s+\d{4}\s+/i, '')
    .replace(/^DEBIT\s+\d{4}\s+/i, '')
    .replace(/^ATM\s+WITHDRAWAL\s+/i, 'ATM ');

  // Extract merchant name from complex descriptions
  // Format: "MERCHANT #123 CITY STATE"
  const merchantMatch = cleaned.match(/^([A-Z\s&'-]+?)\s*#?\d*\s+[A-Z]{2}\s*$/i);
  if (merchantMatch) {
    cleaned = merchantMatch[1].trim();
  }

  // Handle specific patterns
  if (/IC\*\s+INSTACART/i.test(cleaned)) {
    return 'Instacart';
  }
  if (/^Zelle/i.test(cleaned)) {
    if (/from/i.test(cleaned)) {
      return 'Zelle Payment Received';
    } else if (/to/i.test(cleaned)) {
      const match = cleaned.match(/to\s+(.+?)(?:\s+for|$)/i);
      return match ? `Zelle to ${match[1].trim()}` : 'Zelle Payment';
    }
    return 'Zelle';
  }
  if (/WIRE\s+(?:IN|OUT)/i.test(cleaned)) {
    return /IN/i.test(cleaned) ? 'Wire Transfer In' : 'Wire Transfer Out';
  }
  if (/Bill\s+Payment/i.test(cleaned)) {
    // Extract bank/company name
    const match = cleaned.match(/^(.+?)\s+Bill\s+Payment/i);
    return match ? `${match[1].trim()}` : 'Bill Payment';
  }
  if (/PAYROLL|DES:PAYROLL/i.test(cleaned)) {
    const match = cleaned.match(/INDN:([A-Z\s,]+)/i);
    return match ? match[1].trim().split(',')[0].trim() + ' (Payroll)' : 'Payroll';
  }

  // Remove junk at end like confirmation codes
  cleaned = cleaned
    .replace(/\s+Confirmation#\s+.+$/i, '')
    .replace(/\s+ID:\d+.*/i, '')
    .replace(/\s+\d{20,}.*$/i, '');

  // Capitalize properly
  return cleaned
    .split(/\s+/)
    .map((word) => {
      if (word.length < 3 && word.toLowerCase() !== 'to' && word.toLowerCase() !== 'at') {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Auto-Categorization
// ---------------------------------------------------------------------------

function autoCategorize(description: string, isTransfer: boolean): string | undefined {
  if (isTransfer) {
    return 'Transfer';
  }

  const desc = description.toUpperCase();

  // Payroll / Income
  if (/PAYROLL|DES:PAYROLL|DIRECT DEPOSIT/i.test(desc)) {
    return 'Income';
  }
  if (/ZELLE.*FROM/i.test(desc)) {
    return 'Income';
  }
  if (/WIRE.*IN/i.test(desc)) {
    return 'Income';
  }

  // Food & Dining
  if (/MCDONALD|CHICK-FIL-A|STARBUCKS|DUNKIN|SUSHI|RESTAURANT|CAFE|PIZZA|BURGER|DINER/i.test(desc)) {
    return 'Food & Dining';
  }

  // Shopping
  if (/INSTACART|PUBLIX|MARSHALLS|AMAZON|WALMART|TARGET|COSTCO|KROGER/i.test(desc)) {
    return 'Shopping';
  }

  // Transportation
  if (/SHELL|EXXON|CHEVRON|MOBIL|UBER|LYFT|TAXI|GAS\s+STATION|PARKING/i.test(desc)) {
    return 'Transportation';
  }

  // Home & Utilities
  if (/HOME DEPOT|LOWES|UTILITY|ELECTRIC|GAS|WATER|INTERNET|PHONE/i.test(desc)) {
    return 'Home & Utilities';
  }

  // Bills & Services
  if (/BILL\s+PAYMENT|INSURANCE|MORTGAGE|RENT|LOAN|SUBSCRIPTION/i.test(desc)) {
    return 'Bills & Utilities';
  }

  // ATM / Cash
  if (/ATM\s+WITHDR|ATM\s+WITHDRAWAL|CASH\s+WITHDRAWAL/i.test(desc)) {
    return 'Cash & ATM';
  }

  // Finance Charges
  if (/INTEREST\s+CHARGED|LATE\s+FEE|OVERDRAFT\s+FEE|SERVICE\s+FEE|ANNUAL\s+FEE/i.test(desc)) {
    return 'Finance Charges';
  }

  // Bank Fees
  if (/SERVICE\s+FEE|BANK\s+FEE|MAINTENANCE\s+FEE/i.test(desc)) {
    return 'Bank Fees';
  }

  // Refunds
  if (/REFUND|RETURN|CREDIT/i.test(desc)) {
    return 'Refund';
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Flags Extraction
// ---------------------------------------------------------------------------

function extractFlags(description: string): string[] {
  const flags: string[] = [];
  const desc = description.toUpperCase();

  if (/PENDING|HOLD/i.test(desc)) flags.push('pending');
  if (/DISPUTE|FRAUD|UNAUTHORIZED/i.test(desc)) flags.push('disputed');
  if (/RECURRING|SUBSCRIPTION|AUTO|AUTOMATIC/i.test(desc)) flags.push('recurring');
  if (/INTERNATIONAL|FOREIGN/i.test(desc)) flags.push('international');
  if (/OVERDRAFT/i.test(desc)) flags.push('overdraft');
  if (/FEE|CHARGE/i.test(desc)) flags.push('fee');

  return flags;
}

// ---------------------------------------------------------------------------
// Summary Calculation
// ---------------------------------------------------------------------------

function calculateSummary(transactions: ParsedTransaction[]) {
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalTransfers = 0;
  let totalFees = 0;
  let totalInterest = 0;
  let transferCount = 0;

  for (const txn of transactions) {
    if (txn.isTransfer) {
      totalTransfers += Math.abs(txn.amount);
      transferCount++;
    } else if (txn.category === 'Bank Fees' || txn.category === 'Finance Charges') {
      if (txn.amount > 0) {
        totalFees += txn.amount;
      } else {
        totalFees += Math.abs(txn.amount);
      }
    } else if (txn.category === 'Income') {
      totalDeposits += txn.amount;
    } else if (txn.amount > 0) {
      totalDeposits += txn.amount;
    } else {
      totalWithdrawals += Math.abs(txn.amount);
    }
  }

  return {
    totalDeposits,
    totalWithdrawals,
    totalTransfers,
    totalFees,
    totalInterest,
    transactionCount: transactions.length,
    transferCount,
  };
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function monthNameToNumber(name: string): number | null {
  const months: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  return months[name.toLowerCase()] ?? null;
}

export function normalizeDate(raw: string, fallbackYear?: number): string {
  const trimmed = raw.trim();

  // YYYY-MM-DD (already in target format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // MM/DD/YYYY or M/D/YYYY
  const slashFull = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashFull) {
    const [, m, d, y] = slashFull;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // MM/DD/YY or M/D/YY
  const slashShort = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (slashShort) {
    const [, m, d, yy] = slashShort;
    const fullYear = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
    return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // MM/DD (no year - use fallback)
  const slashNoYear = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashNoYear) {
    const [, m, d] = slashNoYear;
    const year = fallbackYear ?? new Date().getFullYear();
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // MM-DD-YYYY
  const dashMDY = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMDY) {
    const [, m, d, y] = dashMDY;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // MM-DD-YY
  const dashMDYShort = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (dashMDYShort) {
    const [, m, d, yy] = dashMDYShort;
    const fullYear = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
    return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  throw new Error(`Unable to parse date: "${raw}"`);
}

export function normalizeAmount(raw: string): number {
  let cleaned = raw.trim();

  // Handle parentheses notation: (100.00) means negative
  const isParenNegative = /^\(.*\)$/.test(cleaned);
  if (isParenNegative) {
    cleaned = cleaned.slice(1, -1);
  }

  // Strip currency symbols and whitespace
  cleaned = cleaned.replace(/[$ \u00A0\u20AC\u00A3\u00A5]/g, '');

  // Strip commas
  cleaned = cleaned.replace(/,/g, '');

  // Handle explicit negative sign
  const isExplicitNegative = cleaned.startsWith('-');
  if (isExplicitNegative) {
    cleaned = cleaned.slice(1);
  }

  const value = parseFloat(cleaned);
  if (isNaN(value)) {
    return 0;
  }

  let result = value;

  // Apply sign: parentheses or explicit negative both mean negative
  if (isParenNegative || isExplicitNegative) {
    result = -Math.abs(result);
  }

  // Round to 2 decimal places
  return Math.round(result * 100) / 100;
}
