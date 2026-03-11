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

  console.log(`Detected statement type: ${statementType.type} (${statementType.title})`);

  // Parse based on detected type
  if (statementType.type === 'bofa_checking') {
    return parseBofaChecking(text, lines);
  } else if (statementType.type === 'bofa_credit_card') {
    return parseBofaCreditCard(text, lines);
  } else if (statementType.type === 'amex_credit_card') {
    return parseAmexCreditCard(text, lines);
  } else if (statementType.type === 'chase_credit_card') {
    return parseGenericCreditCardStatement(text, lines, 'Chase');
  } else if (statementType.type === 'chase_checking') {
    return parseGenericCheckingStatement(text, lines, 'Chase');
  } else if (statementType.type === 'generic_credit_card') {
    return parseGenericCreditCardStatement(text, lines, extractInstitutionName(text));
  } else if (statementType.type === 'generic_checking') {
    return parseGenericCheckingStatement(text, lines, extractInstitutionName(text));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Statement Type Detection
// ---------------------------------------------------------------------------

interface DetectedStatement {
  type: 'bofa_checking' | 'bofa_credit_card' | 'amex_credit_card' | 'chase_credit_card' | 'chase_checking' | 'generic_credit_card' | 'generic_checking';
  title: string;
}

function detectStatementType(text: string): DetectedStatement | null {
  // Bank of America Checking patterns
  if (/Your Regular Checking|Your Adv Plus Banking|Your Adv Tiered Interest Chkg/i.test(text)) {
    return { type: 'bofa_checking', title: 'Bank of America Checking' };
  }

  // Bank of America Credit Card patterns
  if ((/Visa Signature|MasterCard/i.test(text) || (/American Express/i.test(text) && /Bank of America/i.test(text))) && /Account#\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}/i.test(text)) {
    return { type: 'bofa_credit_card', title: 'Bank of America Credit Card' };
  }

  // American Express statement patterns
  if (/American Express/i.test(text) && (/Member Since|Membership Rewards|Payment Due Date|New Charges|Total Balance/i.test(text))) {
    return { type: 'amex_credit_card', title: 'American Express Credit Card' };
  }
  // Amex alternate detection: account ending pattern + Amex branding
  if (/amex|american express/i.test(text) && /account ending/i.test(text)) {
    return { type: 'amex_credit_card', title: 'American Express Credit Card' };
  }

  // Chase credit card
  if (/Chase|JPMorgan/i.test(text) && (/Sapphire|Freedom|Ink|credit card/i.test(text) || /Previous Balance.*New Balance/is.test(text))) {
    return { type: 'chase_credit_card', title: 'Chase Credit Card' };
  }

  // Chase checking
  if (/Chase|JPMorgan/i.test(text) && /checking|savings/i.test(text) && /Beginning Balance|Ending Balance/i.test(text)) {
    return { type: 'chase_checking', title: 'Chase Checking' };
  }

  // Generic credit card detection: look for common CC statement patterns
  if (/Previous Balance|New Balance|Minimum Payment|Payment Due Date|Credit Limit|Available Credit/i.test(text) &&
      /Payments.*Credits|Purchases|Interest Charged|Finance Charge/i.test(text)) {
    return { type: 'generic_credit_card', title: 'Credit Card Statement' };
  }

  // Generic checking: look for checking/savings statement patterns
  if (/Beginning Balance|Ending Balance/i.test(text) &&
      (/Deposits|Withdrawals|Checks/i.test(text))) {
    return { type: 'generic_checking', title: 'Bank Statement' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// BofA Checking Parser (Tab-Delimited Format)
// ---------------------------------------------------------------------------

function parseBofaChecking(fullText: string, lines: string[]): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Extract metadata
  const metadata = extractBofaCheckingMetadata(fullText, lines, errors);

  // Parse deposits section
  parseCheckingSection(fullText, 'deposits', transactions, metadata, errors);

  // Parse withdrawals section (and continued)
  parseCheckingSection(fullText, 'withdrawals', transactions, metadata, errors);

  // Parse checks section (special two-per-line format)
  parseCheckingChecksSection(fullText, transactions, metadata, errors);

  // Parse service fees section
  parseCheckingSection(fullText, 'fees', transactions, metadata, errors);

  // Calculate summary
  const summary = calculateSummary(transactions);

  return {
    metadata,
    transactions,
    summary,
    errors,
  };
}

/**
 * Parse a standard checking section (deposits, withdrawals, or fees)
 * Format: Tab-delimited fields, transactions start with date MM/DD/YY
 */
function parseCheckingSection(
  fullText: string,
  section: 'deposits' | 'withdrawals' | 'fees',
  transactions: ParsedTransaction[],
  metadata: StatementMetadata,
  errors: string[]
): void {
  let startPattern: RegExp;
  let endPattern: RegExp;

  if (section === 'deposits') {
    startPattern = /^Deposits and other additions\s*\n\s*Date\s+Description\s+Amount/m;
    endPattern = /^Total deposits and other additions/m;
  } else if (section === 'withdrawals') {
    startPattern = /^Withdrawals and other subtractions[^\n]*\n\s*Date\s+Description\s+Amount/m;
    endPattern = /^Total withdrawals and other subtractions/m;
  } else {
    // fees
    startPattern = /^Service fees\s*\n\s*Date\s+Transaction description\s+Amount/m;
    endPattern = /^Total service fees/m;
  }

  const startMatch = fullText.match(startPattern);
  const endMatch = fullText.match(endPattern);

  if (!startMatch) {
    return; // Section not found
  }

  const startIdx = startMatch.index! + startMatch[0].length;
  const endIdx = endMatch ? endMatch.index! : fullText.length;
  const sectionText = fullText.substring(startIdx, endIdx);

  // Split into lines and process
  const sectionLines = sectionText.split('\n');
  let i = 0;

  while (i < sectionLines.length) {
    const line = sectionLines[i];
    const trimmed = line.trim();

    // Skip empty lines, headers, and total lines
    if (
      !trimmed ||
      /^Date\s+/i.test(trimmed) ||
      /^Total\s+/i.test(trimmed) ||
      /^Total #/i.test(trimmed) ||
      /^\*/i.test(trimmed) ||
      /^There is a gap/i.test(trimmed)
    ) {
      i++;
      continue;
    }

    // Check if line starts with a date (MM/DD/YY format)
    const dateMatch = trimmed.match(/^(\d{1,2}\/\d{1,2}\/\d{2})\s*\t(.*)$/);
    if (dateMatch) {
      const rawDate = dateMatch[1];
      let description = '';
      let rawAmount: string | null = null;
      let tabFields = dateMatch[2].split('\t');

      // Collect this line and continuation lines
      let j = i + 1;
      while (j < sectionLines.length) {
        const nextLine = sectionLines[j];
        const nextTrimmed = nextLine.trim();
        // Continuation line: does NOT start with a date
        if (nextTrimmed && !nextTrimmed.match(/^\d{1,2}\/\d{1,2}\/\d{2}\s*\t/)) {
          // Add continuation to tab fields
          const continuationFields = nextTrimmed.split('\t');
          tabFields = tabFields.concat(continuationFields);
          j++;
        } else {
          break;
        }
      }

      // Extract amount (last numeric field in tab-delimited line)
      // Amount pattern: -?[\d,]+\.\d{2}
      for (let k = tabFields.length - 1; k >= 0; k--) {
        const field = tabFields[k].trim();
        if (/^-?[\d,]+\.\d{2}$/.test(field)) {
          rawAmount = field;
          // Description is everything except this field and the date
          description = tabFields.slice(0, k).join(' ').trim();
          break;
        }
      }

      // If we found an amount, create a transaction
      if (rawAmount !== null) {
        try {
          const txn = parseBofaCheckingTransaction(
            rawDate,
            description,
            rawAmount,
            section,
            metadata
          );
          transactions.push(txn);
        } catch (err: any) {
          errors.push(`BofA Checking parse error at ${rawDate}: ${err.message}`);
        }
      }

      i = j;
    } else {
      i++;
    }
  }
}

/**
 * Parse the Checks section which has a special format:
 * Date [TAB] Check# [TAB] Amount [TAB] Date [TAB] Check# [TAB] Amount
 * (up to 2 checks per line)
 */
function parseCheckingChecksSection(
  fullText: string,
  transactions: ParsedTransaction[],
  metadata: StatementMetadata,
  errors: string[]
): void {
  const startPattern = /^Checks$/m;
  const endPattern = /^Total checks/m;

  const startMatch = fullText.match(startPattern);
  const endMatch = fullText.match(endPattern);

  if (!startMatch) {
    return; // No checks section
  }

  const startIdx = startMatch.index! + startMatch[0].length;
  const endIdx = endMatch ? endMatch.index! : fullText.length;
  const sectionText = fullText.substring(startIdx, endIdx);

  const sectionLines = sectionText.split('\n');

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i].trim();

    // Skip headers and empty lines
    if (
      !line ||
      /^Date\s+Check/i.test(line) ||
      /^Total\s+/i.test(line) ||
      /^\*/i.test(line) ||
      /^There is a gap/i.test(line)
    ) {
      continue;
    }

    // Parse check line format: Date TAB Check# TAB Amount [TAB Date TAB Check# TAB Amount]
    const fields = line.split(/\s*\t\s*/).map((f) => f.trim());

    if (fields.length >= 3) {
      // Parse first check
      if (fields[0] && /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(fields[0].trim())) {
        const checkNum = fields[1];
        const amount = fields[2];

        if (checkNum && /^\d+\*?$/.test(checkNum) && /^-?[\d,]+\.\d{2}$/.test(amount)) {
          try {
            const description = `Check #${checkNum}`;
            const txn = parseBofaCheckingTransaction(
              fields[0],
              description,
              amount,
              'checks',
              metadata
            );
            transactions.push(txn);
          } catch (err: any) {
            errors.push(`BofA Checking check parse error: ${err.message}`);
          }
        }
      }

      // Parse second check if present
      if (fields.length >= 6 && fields[3] && /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(fields[3].trim())) {
        const checkNum = fields[4];
        const amount = fields[5];

        if (checkNum && /^\d+\*?$/.test(checkNum) && /^-?[\d,]+\.\d{2}$/.test(amount)) {
          try {
            const description = `Check #${checkNum}`;
            const txn = parseBofaCheckingTransaction(
              fields[3],
              description,
              amount,
              'checks',
              metadata
            );
            transactions.push(txn);
          } catch (err: any) {
            errors.push(`BofA Checking check parse error: ${err.message}`);
          }
        }
      }
    }
  }
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

  // Extract account number - pattern: "Account number: 0055 0942 8434"
  let match = fullText.match(/Account\s+number:\s*([\d\s]+)/i);
  if (match) {
    accountNumber = match[1].replace(/\s+/g, ' ').trim();
    const last4 = accountNumber.match(/\d{4}$/);
    if (last4) {
      accountNickname = `CHK ${last4[0]}`;
    }
  }

  // Extract owner name
  match = fullText.match(/^([A-Z][A-Z\s]+)\n.*?\nAccount/m);
  if (match) {
    const nameCandidate = match[1].trim();
    if (nameCandidate.length > 2 && nameCandidate.length < 100) {
      ownerName = nameCandidate;
    }
  }

  // Extract statement period from text format: "for September 12, 2025 to October 14, 2025"
  match = fullText.match(/for\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+to\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const [, startMonthName, startDay, startYear, endMonthName, endDay, endYear] = match;
    const startMonthNum = monthNameToNumber(startMonthName);
    const endMonthNum = monthNameToNumber(endMonthName);
    if (startMonthNum && endMonthNum) {
      statementStart = `${startYear}-${String(startMonthNum).padStart(2, '0')}-${startDay.padStart(2, '0')}`;
      statementEnd = `${endYear}-${String(endMonthNum).padStart(2, '0')}-${endDay.padStart(2, '0')}`;
    }
  }

  // Extract beginning balance - "Beginning balance on September 12, 2025 [TAB] $6,673.23"
  match = fullText.match(/Beginning\s+balance[^$]*\$?([\d,]+\.\d{2})/i);
  if (match) {
    beginningBalance = normalizeAmount(match[1]);
  }

  // Extract ending balance - "Ending balance on October 14, 2025 [TAB] $5,824.43"
  match = fullText.match(/Ending\s+balance[^$]*\$?([\d,]+\.\d{2})/i);
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
  const date = normalizeDate(rawDate, parseInt(metadata.statementPeriod.end.split('-')[0], 10));
  const amount = normalizeAmount(rawAmount);

  // Determine sign based on section
  let signedAmount = amount;
  if (section === 'withdrawals' || section === 'checks' || section === 'fees') {
    // These sections should be negative, but the amount might already have the sign
    if (amount >= 0) {
      signedAmount = -Math.abs(amount);
    } else {
      signedAmount = amount;
    }
  } else if (section === 'deposits') {
    // Deposits should be positive
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

    // CC transaction lines are tab-delimited:
    // MM/DD TAB MM/DD TAB DESCRIPTION TAB REFNUM TAB ACCTLAST4 TAB AMOUNT
    // MM/DD TAB MM/DD TAB INTEREST CHARGED ON ... TAB AMOUNT
    if (currentSection) {
      // Split by tabs and parse
      const fields = line.split(/\t/).map(f => f.trim()).filter(f => f.length > 0);

      // Must start with date pattern MM/DD
      if (fields.length >= 3 && /^\d{1,2}\/\d{1,2}$/.test(fields[0]) && /^\d{1,2}\/\d{1,2}$/.test(fields[1])) {
        const txDate = fields[0];
        const postDate = fields[1];

        // Find amount: last field that looks like a number
        let rawAmount = '';
        let descFields: string[] = [];

        for (let fi = fields.length - 1; fi >= 2; fi--) {
          if (/^-?[\d,]+\.\d{2}$/.test(fields[fi])) {
            rawAmount = fields[fi];
            descFields = fields.slice(2, fi);
            break;
          }
        }

        // If no amount found in trailing fields, check if last field has amount embedded
        if (!rawAmount) {
          const lastField = fields[fields.length - 1];
          const amtMatch = lastField.match(/(-?[\d,]+\.\d{2})$/);
          if (amtMatch) {
            rawAmount = amtMatch[1];
            const descPart = lastField.slice(0, amtMatch.index).trim();
            descFields = [...fields.slice(2, fields.length - 1), descPart].filter(f => f.length > 0);
          } else {
            descFields = fields.slice(2);
          }
        }

        // Filter out ref numbers and account suffixes from description
        const description = descFields.filter(f => !/^\d{4}$/.test(f)).join(' ').trim();

        if (rawAmount && description) {
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
// ---------------------------------------------------------------------------
// American Express Credit Card Parser
// ---------------------------------------------------------------------------

function parseAmexCreditCard(fullText: string, lines: string[]): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Extract metadata
  const metadata = extractAmexMetadata(fullText, lines, errors);

  // Amex PDFs typically have transactions in sections:
  // - "New Charges" or "Recent Charges" or just listed by date
  // - "Payments and Credits"
  // - "Fees" or "Interest"
  // Transaction format varies but commonly:
  //   MM/DD/YY[*]  Description  $Amount
  //   or MM/DD  Description  $Amount
  //   or Date field followed by description and amount on same/next line

  let currentSection = 'charges';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section headers
    if (/^Payments?\s*(and|&)\s*Credits?/i.test(line) || /^Payments\s*Received/i.test(line)) {
      currentSection = 'payments';
      continue;
    }
    if (/^New\s*Charges|^Recent\s*Activity|^Recent\s*Charges|^Transactions?/i.test(line)) {
      currentSection = 'charges';
      continue;
    }
    if (/^Fees?\s*$/i.test(line) || /^Interest\s*Charge/i.test(line)) {
      currentSection = 'interest';
      continue;
    }
    if (/^Total\s+/i.test(line) || /^TOTAL\s+/i.test(line)) {
      continue;
    }

    // Try to parse transaction lines
    // Amex pattern 1: MM/DD/YY[*]  DESCRIPTION  $AMOUNT or AMOUNT
    const amexLine1 = line.match(/^(\d{1,2}\/\d{1,2}\/?\d{0,4})\*?\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/);
    if (amexLine1) {
      const [, rawDate, description, rawAmount] = amexLine1;
      try {
        const periodYear = metadata.statementPeriod.end ? parseInt(metadata.statementPeriod.end.split('-')[0], 10) : new Date().getFullYear();
        const date = normalizeDate(rawDate, periodYear);
        let amount = normalizeAmount(rawAmount);

        // Amex: charges are positive in the statement but should be negative (expenses)
        // Payments are negative in statement but should be positive (credits to card)
        if (currentSection === 'charges' || currentSection === 'interest') {
          amount = -Math.abs(amount);
        } else if (currentSection === 'payments') {
          amount = Math.abs(amount);
        }

        const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
        const merchantName = cleanMerchantName(description);
        const category = autoCategorize(description, isTransfer);
        const flags = extractFlags(description);

        if (currentSection === 'interest') {
          flags.push('fee');
        }

        transactions.push({
          date,
          description,
          amount,
          section: currentSection,
          isTransfer,
          transferType,
          transferAccountRef,
          merchantName,
          category,
          flags,
          rawLine: line,
        });
      } catch (err: any) {
        errors.push(`Amex parse error: ${err.message} — "${line}"`);
      }
      continue;
    }

    // Amex pattern 2: MM/DD  DESCRIPTION  AMOUNT (tab or multi-space separated)
    const amexLine2 = line.match(/^(\d{1,2}\/\d{1,2})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/);
    if (amexLine2) {
      const [, rawDate, description, rawAmount] = amexLine2;
      try {
        const periodYear = metadata.statementPeriod.end ? parseInt(metadata.statementPeriod.end.split('-')[0], 10) : new Date().getFullYear();
        const date = normalizeDate(rawDate, periodYear);
        let amount = normalizeAmount(rawAmount);

        if (currentSection === 'charges' || currentSection === 'interest') {
          amount = -Math.abs(amount);
        } else if (currentSection === 'payments') {
          amount = Math.abs(amount);
        }

        const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
        const merchantName = cleanMerchantName(description);
        const category = autoCategorize(description, isTransfer);
        const flags = extractFlags(description);

        transactions.push({
          date,
          description,
          amount,
          section: currentSection,
          isTransfer,
          transferType,
          transferAccountRef,
          merchantName,
          category,
          flags,
          rawLine: line,
        });
      } catch (err: any) {
        errors.push(`Amex parse error: ${err.message} — "${line}"`);
      }
      continue;
    }

    // Amex pattern 3: tab-delimited — Date\tDescription\tAmount
    const tabFields = line.split('\t').map(f => f.trim()).filter(f => f);
    if (tabFields.length >= 3) {
      const possibleDate = tabFields[0];
      if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(possibleDate)) {
        // Find amount from the end
        let rawAmount = '';
        let descParts: string[] = [];
        for (let ti = tabFields.length - 1; ti >= 1; ti--) {
          if (/^-?\$?[\d,]+\.\d{2}$/.test(tabFields[ti].replace(/[$]/g, ''))) {
            rawAmount = tabFields[ti].replace(/[$]/g, '');
            descParts = tabFields.slice(1, ti);
            break;
          }
        }
        if (!rawAmount && tabFields.length >= 2) {
          // Try last field
          const lastClean = tabFields[tabFields.length - 1].replace(/[$]/g, '');
          if (/^-?[\d,]+\.\d{2}$/.test(lastClean)) {
            rawAmount = lastClean;
            descParts = tabFields.slice(1, tabFields.length - 1);
          }
        }

        if (rawAmount && descParts.length > 0) {
          const description = descParts.join(' ').trim();
          try {
            const periodYear = metadata.statementPeriod.end ? parseInt(metadata.statementPeriod.end.split('-')[0], 10) : new Date().getFullYear();
            const date = normalizeDate(possibleDate, periodYear);
            let amount = normalizeAmount(rawAmount);

            if (currentSection === 'charges' || currentSection === 'interest') {
              amount = -Math.abs(amount);
            } else if (currentSection === 'payments') {
              amount = Math.abs(amount);
            }

            const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
            const merchantName = cleanMerchantName(description);
            const category = autoCategorize(description, isTransfer);
            const flags = extractFlags(description);

            transactions.push({
              date,
              description,
              amount,
              section: currentSection,
              isTransfer,
              transferType,
              transferAccountRef,
              merchantName,
              category,
              flags,
              rawLine: line,
            });
          } catch (err: any) {
            errors.push(`Amex tab parse error: ${err.message}`);
          }
        }
      }
    }
  }

  const summary = calculateSummary(transactions);

  return { metadata, transactions, summary, errors };
}

function extractAmexMetadata(
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

  // Account number patterns for Amex
  // "Account Ending: 1-12345" or "Account Ending 1-12345" or "XXXX-XXXXXX-12345"
  let match = fullText.match(/Account\s+Ending[:\s]*(\S+)/i);
  if (match) {
    accountNumber = match[1].replace(/[^0-9-]/g, '');
    const last4or5 = accountNumber.match(/(\d{4,5})$/);
    accountNickname = last4or5 ? `Amex ${last4or5[1]}` : 'American Express';
  }

  // Alternate: "Account Number: XXXX-XXXXXX-12345"
  if (!accountNumber) {
    match = fullText.match(/Account\s+Number[:\s]*[\dX*-]+?(\d{4,5})\s/i);
    if (match) {
      accountNumber = match[1];
      accountNickname = `Amex ${match[1]}`;
    }
  }

  // Alternate: just find "x-xxxxx" or similar near "account"
  if (!accountNumber) {
    match = fullText.match(/\d-\d{4,5}(?:\s|$)/);
    if (match) {
      accountNumber = match[0].trim();
      const last = accountNumber.match(/(\d{4,5})$/);
      accountNickname = last ? `Amex ${last[1]}` : 'American Express';
    }
  }

  if (!accountNickname) accountNickname = 'American Express';

  // Owner name
  match = fullText.match(/Card\s*Member[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$)/);
  if (match) {
    ownerName = match[1].trim();
  }

  // Statement period
  // "Closing Date: 01/15/2025" or "Statement Closing Date January 15, 2025"
  match = fullText.match(/Closing\s+Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (match) {
    statementEnd = normalizeDate(match[1]);
  }
  match = fullText.match(/Opening\s+Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (match) {
    statementStart = normalizeDate(match[1]);
  }

  // Try text date format: "December 15 - January 14, 2025"
  if (!statementEnd) {
    match = fullText.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
    if (match) {
      const [, sm, sd, em, ed, year] = match;
      const smn = monthNameToNumber(sm);
      const emn = monthNameToNumber(em);
      if (smn && emn) {
        statementStart = `${year}-${String(smn).padStart(2, '0')}-${sd.padStart(2, '0')}`;
        statementEnd = `${year}-${String(emn).padStart(2, '0')}-${ed.padStart(2, '0')}`;
      }
    }
  }

  // Previous/New Balance
  match = fullText.match(/Previous\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) beginningBalance = normalizeAmount(match[1]);

  match = fullText.match(/New\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (!match) match = fullText.match(/Total\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (!match) match = fullText.match(/Amount\s+Due[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) endingBalance = normalizeAmount(match[1]);

  return {
    institution: 'American Express',
    accountType: 'credit_card',
    accountNumber,
    accountNickname,
    statementPeriod: { start: statementStart, end: statementEnd },
    beginningBalance,
    endingBalance,
    ownerName,
  };
}

// ---------------------------------------------------------------------------
// Generic Credit Card Statement Parser
// ---------------------------------------------------------------------------

function parseGenericCreditCardStatement(
  fullText: string,
  lines: string[],
  institution: string
): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  const metadata = extractGenericCCMetadata(fullText, lines, institution, errors);

  let currentSection = 'charges';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect sections
    if (/Payments?\s*(and|&)\s*Credits?|Payments?\s*Received/i.test(line)) {
      currentSection = 'payments';
      continue;
    }
    if (/New\s*Charges|Purchases?\s*(and|&)?|Transactions?/i.test(line)) {
      currentSection = 'charges';
      continue;
    }
    if (/Interest\s*Charge|Fees?\s*$/i.test(line)) {
      currentSection = 'interest';
      continue;
    }
    if (/^TOTAL|^Total\s+/i.test(line)) continue;

    // Try to extract date + description + amount
    const txMatch = line.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/);
    if (txMatch) {
      const [, rawDate, description, rawAmount] = txMatch;
      try {
        const periodYear = metadata.statementPeriod.end ? parseInt(metadata.statementPeriod.end.split('-')[0], 10) : new Date().getFullYear();
        const date = normalizeDate(rawDate, periodYear);
        let amount = normalizeAmount(rawAmount);

        if (currentSection === 'charges' || currentSection === 'interest') {
          amount = -Math.abs(amount);
        } else if (currentSection === 'payments') {
          amount = Math.abs(amount);
        }

        const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
        const merchantName = cleanMerchantName(description);
        const category = autoCategorize(description, isTransfer);
        const flags = extractFlags(description);

        transactions.push({
          date, description, amount, section: currentSection,
          isTransfer, transferType, transferAccountRef,
          merchantName, category, flags, rawLine: line,
        });
      } catch (err: any) {
        errors.push(`CC parse error: ${err.message}`);
      }
      continue;
    }

    // Tab-separated variant
    const tabFields = line.split('\t').map(f => f.trim()).filter(f => f);
    if (tabFields.length >= 3 && /^\d{1,2}\/\d{1,2}/.test(tabFields[0])) {
      let rawAmount = '';
      let descParts: string[] = [];
      for (let ti = tabFields.length - 1; ti >= 1; ti--) {
        if (/^-?\$?[\d,]+\.\d{2}$/.test(tabFields[ti].replace(/[$]/g, ''))) {
          rawAmount = tabFields[ti].replace(/[$]/g, '');
          descParts = tabFields.slice(1, ti);
          break;
        }
      }
      if (rawAmount && descParts.length > 0) {
        try {
          const periodYear = metadata.statementPeriod.end ? parseInt(metadata.statementPeriod.end.split('-')[0], 10) : new Date().getFullYear();
          const date = normalizeDate(tabFields[0], periodYear);
          let amount = normalizeAmount(rawAmount);

          if (currentSection === 'charges' || currentSection === 'interest') {
            amount = -Math.abs(amount);
          } else if (currentSection === 'payments') {
            amount = Math.abs(amount);
          }

          const description = descParts.filter(f => !/^\d{4}$/.test(f)).join(' ').trim();
          const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
          const merchantName = cleanMerchantName(description);
          const category = autoCategorize(description, isTransfer);
          const flags = extractFlags(description);

          transactions.push({
            date, description, amount, section: currentSection,
            isTransfer, transferType, transferAccountRef,
            merchantName, category, flags, rawLine: line,
          });
        } catch (err: any) {
          errors.push(`CC tab parse error: ${err.message}`);
        }
      }
    }
  }

  return { metadata, transactions, summary: calculateSummary(transactions), errors };
}

function extractGenericCCMetadata(
  fullText: string,
  lines: string[],
  institution: string,
  errors: string[]
): StatementMetadata {
  let accountNumber = '';
  let accountNickname = '';
  let ownerName = '';
  let statementStart = '';
  let statementEnd = '';
  let beginningBalance = 0;
  let endingBalance = 0;

  // Account number
  let match = fullText.match(/Account\s*(?:#|Number|Ending)[:\s]*([\d\s*X-]+)/i);
  if (match) {
    accountNumber = match[1].trim();
    const last4 = accountNumber.match(/(\d{4})$/);
    accountNickname = last4 ? `${institution} CC ${last4[1]}` : `${institution} Credit Card`;
  } else {
    accountNickname = `${institution} Credit Card`;
  }

  // Statement period
  match = fullText.match(/Statement\s+(?:Period|Date).*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:to|through|-|–)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (match) {
    statementStart = normalizeDate(match[1]);
    statementEnd = normalizeDate(match[2]);
  }

  if (!statementEnd) {
    match = fullText.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
    if (match) {
      const [, sm, sd, em, ed, year] = match;
      const smn = monthNameToNumber(sm);
      const emn = monthNameToNumber(em);
      if (smn && emn) {
        statementStart = `${year}-${String(smn).padStart(2, '0')}-${sd.padStart(2, '0')}`;
        statementEnd = `${year}-${String(emn).padStart(2, '0')}-${ed.padStart(2, '0')}`;
      }
    }
  }

  match = fullText.match(/Previous\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) beginningBalance = normalizeAmount(match[1]);

  match = fullText.match(/New\s+Balance[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) endingBalance = normalizeAmount(match[1]);

  return {
    institution,
    accountType: 'credit_card',
    accountNumber,
    accountNickname,
    statementPeriod: { start: statementStart, end: statementEnd },
    beginningBalance,
    endingBalance,
    ownerName,
  };
}

// ---------------------------------------------------------------------------
// Generic Checking/Savings Statement Parser
// ---------------------------------------------------------------------------

function parseGenericCheckingStatement(
  fullText: string,
  lines: string[],
  institution: string
): StatementParseResult {
  const errors: string[] = [];
  const transactions: ParsedTransaction[] = [];

  let accountNumber = '';
  let accountNickname = '';
  let statementStart = '';
  let statementEnd = '';
  let beginningBalance = 0;
  let endingBalance = 0;

  // Extract metadata
  let match = fullText.match(/Account\s*(?:#|Number)[:\s]*([\d\s]+)/i);
  if (match) {
    accountNumber = match[1].trim();
    const last4 = accountNumber.match(/(\d{4})$/);
    accountNickname = last4 ? `${institution} CHK ${last4[1]}` : `${institution} Checking`;
  } else {
    accountNickname = `${institution} Checking`;
  }

  match = fullText.match(/Beginning\s+(?:Balance|Bal)[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) beginningBalance = normalizeAmount(match[1]);

  match = fullText.match(/Ending\s+(?:Balance|Bal)[:\s]*\$?([\d,]+\.\d{2})/i);
  if (match) endingBalance = normalizeAmount(match[1]);

  // Parse statement period
  match = fullText.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+(?:to|through|-|–)\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const smn = monthNameToNumber(match[1]);
    const emn = monthNameToNumber(match[4]);
    if (smn && emn) {
      statementStart = `${match[3]}-${String(smn).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      statementEnd = `${match[6]}-${String(emn).padStart(2, '0')}-${match[5].padStart(2, '0')}`;
    }
  }

  let currentSection = 'deposits';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/Deposits?\s*(and|&)/i.test(line)) { currentSection = 'deposits'; continue; }
    if (/Withdrawals?\s*(and|&)/i.test(line)) { currentSection = 'withdrawals'; continue; }
    if (/Service\s+Fees?/i.test(line)) { currentSection = 'fees'; continue; }
    if (/Checks?\s*$/i.test(line)) { currentSection = 'checks'; continue; }

    // Try to parse: Date Description Amount
    const txMatch = line.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/);
    if (txMatch) {
      const [, rawDate, description, rawAmount] = txMatch;
      try {
        const periodYear = statementEnd ? parseInt(statementEnd.split('-')[0], 10) : new Date().getFullYear();
        const date = normalizeDate(rawDate, periodYear);
        let amount = normalizeAmount(rawAmount);

        if (currentSection === 'withdrawals' || currentSection === 'fees' || currentSection === 'checks') {
          if (amount > 0) amount = -amount;
        } else {
          amount = Math.abs(amount);
        }

        const { isTransfer, transferType, transferAccountRef } = detectTransfer(description);
        const merchantName = cleanMerchantName(description);
        const category = autoCategorize(description, isTransfer);
        const flags = extractFlags(description);

        transactions.push({
          date, description, amount, section: currentSection,
          isTransfer, transferType, transferAccountRef,
          merchantName, category, flags, rawLine: line,
        });
      } catch (err: any) {
        errors.push(`Checking parse error: ${err.message}`);
      }
    }
  }

  const metadata: StatementMetadata = {
    institution,
    accountType: 'checking',
    accountNumber,
    accountNickname,
    statementPeriod: { start: statementStart, end: statementEnd },
    beginningBalance,
    endingBalance,
    ownerName: '',
  };

  return { metadata, transactions, summary: calculateSummary(transactions), errors };
}

// ---------------------------------------------------------------------------
// Institution Name Extraction (for generic statements)
// ---------------------------------------------------------------------------

function extractInstitutionName(text: string): string {
  const institutions = [
    { pattern: /Chase|JPMorgan/i, name: 'Chase' },
    { pattern: /Bank of America|BofA/i, name: 'Bank of America' },
    { pattern: /Wells?\s*Fargo/i, name: 'Wells Fargo' },
    { pattern: /Citi(?:bank|group)?/i, name: 'Citi' },
    { pattern: /Capital\s*One/i, name: 'Capital One' },
    { pattern: /US\s*Bank/i, name: 'US Bank' },
    { pattern: /TD\s*Bank/i, name: 'TD Bank' },
    { pattern: /PNC/i, name: 'PNC' },
    { pattern: /USAA/i, name: 'USAA' },
    { pattern: /Navy\s*Federal/i, name: 'Navy Federal' },
    { pattern: /Discover/i, name: 'Discover' },
    { pattern: /American Express|Amex/i, name: 'American Express' },
    { pattern: /Ally/i, name: 'Ally Bank' },
    { pattern: /Marcus/i, name: 'Marcus by Goldman Sachs' },
    { pattern: /Synchrony/i, name: 'Synchrony' },
    { pattern: /Barclays/i, name: 'Barclays' },
    { pattern: /Fifth\s*Third/i, name: 'Fifth Third Bank' },
    { pattern: /Regions/i, name: 'Regions Bank' },
    { pattern: /KeyBank/i, name: 'KeyBank' },
    { pattern: /Huntington/i, name: 'Huntington Bank' },
  ];

  for (const inst of institutions) {
    if (inst.pattern.test(text)) {
      return inst.name;
    }
  }

  return 'Unknown Bank';
}
// Build trigger: 1773180580
