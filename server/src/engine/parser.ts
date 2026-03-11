import * as XLSX from 'xlsx';
import {
  parseStatement,
  StatementParseResult,
  normalizeDate as stmtNormalizeDate,
  normalizeAmount as stmtNormalizeAmount,
} from './statementParser.js';
import { detectAccount } from './accountDetector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRow {
  date: string;        // YYYY-MM-DD
  name: string;        // merchant/description
  amount: number;      // negative for expenses, positive for income
  category?: string;   // raw category string if present
  account?: string;    // raw account reference if present
  notes?: string;
  isTransfer?: boolean;
  transferType?: string;
  transferAccountRef?: string;
  flags?: string[];
  rawData: Record<string, string>;  // original row data
}

export interface ParseResult {
  rows: ParsedRow[];
  headers: string[];
  fileType: string;
  rowCount: number;
  errors: string[];
  statementMeta?: {
    institution: string;
    accountType: string;
    accountNickname: string;
    period: { start: string; end: string };
    beginningBalance: number;
    endingBalance: number;
    summary: {
      totalDeposits: number;
      totalWithdrawals: number;
      totalTransfers: number;
      totalFees: number;
      transactionCount: number;
      transferCount: number;
    };
  };
}

export interface ColumnMap {
  date: number | null;
  name: number | null;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
  account: number | null;
  notes: number | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function parseFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    case 'csv':
    case 'tsv':
    case 'txt': {
      const content = buffer.toString('utf-8');
      return parseCSV(content, filename);
    }
    case 'xlsx':
    case 'xls':
      return parseExcel(buffer, filename);
    case 'pdf':
      return parsePDF(buffer);
    default:
      return {
        rows: [],
        headers: [],
        fileType: ext,
        rowCount: 0,
        errors: [`Unsupported file type: .${ext}`],
      };
  }
}

// ---------------------------------------------------------------------------
// CSV Parser
// ---------------------------------------------------------------------------

export function parseCSV(content: string, filename?: string): ParseResult {
  const errors: string[] = [];

  // Auto-detect delimiter by counting occurrences in the first few lines
  const delimiter = detectDelimiter(content);

  // Split into lines, trimming trailing whitespace and removing empty lines
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { rows: [], headers: [], fileType: 'csv', rowCount: 0, errors: ['File is empty'] };
  }

  // Parse all lines into arrays of fields (handles quoted fields)
  const allRows = lines.map((line) => parseCSVLine(line, delimiter));

  const headers = allRows[0].map((h) => h.trim());
  const dataRows = allRows.slice(1);

  // Build sample rows as objects for detection
  const sampleRows = dataRows.slice(0, 5).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  // Build all data rows for deeper content analysis
  const allDataRowObjects = dataRows.slice(0, 100).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });

  const columnMap = detectColumns(headers, sampleRows);

  // Map each data row into a ParsedRow
  const rows: ParsedRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const fields = dataRows[i];
    const rawData: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rawData[h] = fields[idx] ?? '';
    });

    try {
      const row = mapRowToTransaction(fields, headers, columnMap);
      rows.push({ ...row, rawData });
    } catch (err: any) {
      errors.push(`Row ${i + 2}: ${err.message}`);
    }
  }

  // Detect account/institution from filename, headers, and content
  const detected = detectAccount(filename || '', headers, sampleRows, allDataRowObjects);

  const result: ParseResult = {
    rows,
    headers,
    fileType: 'csv',
    rowCount: rows.length,
    errors,
  };

  if (detected) {
    result.statementMeta = {
      institution: detected.institution,
      accountType: detected.accountType === 'unknown' ? 'checking' : detected.accountType,
      accountNickname: detected.accountNickname,
      period: { start: '', end: '' },
      beginningBalance: 0,
      endingBalance: 0,
      summary: {
        totalDeposits: rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0),
        totalWithdrawals: rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0),
        totalTransfers: 0,
        totalFees: 0,
        transactionCount: rows.length,
        transferCount: 0,
      },
    };
    console.log(`Account detected from CSV: ${detected.institution} ${detected.accountType} (confidence: ${detected.confidence}, source: ${detected.source})`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Excel Parser
// ---------------------------------------------------------------------------

export function parseExcel(buffer: Buffer, filename?: string): ParseResult {
  const errors: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err: any) {
    return {
      rows: [],
      headers: [],
      fileType: 'excel',
      rowCount: 0,
      errors: [`Failed to read Excel file: ${err.message}`],
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], headers: [], fileType: 'excel', rowCount: 0, errors: ['No sheets found'] };
  }

  const sheet = workbook.Sheets[sheetName];
  const jsonData: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (jsonData.length === 0) {
    return { rows: [], headers: [], fileType: 'excel', rowCount: 0, errors: ['Sheet is empty'] };
  }

  const headers = Object.keys(jsonData[0]);
  const sampleRows = jsonData.slice(0, 5).map((row) => {
    const obj: Record<string, string> = {};
    for (const key of headers) {
      obj[key] = String(row[key] ?? '');
    }
    return obj;
  });

  const allDataRowObjects = jsonData.slice(0, 100).map((row) => {
    const obj: Record<string, string> = {};
    for (const key of headers) {
      obj[key] = String(row[key] ?? '');
    }
    return obj;
  });

  const columnMap = detectColumns(headers, sampleRows);

  const rows: ParsedRow[] = [];
  for (let i = 0; i < jsonData.length; i++) {
    const record = jsonData[i];
    const fields = headers.map((h) => String(record[h] ?? ''));
    const rawData: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rawData[h] = fields[idx];
    });

    try {
      const row = mapRowToTransaction(fields, headers, columnMap);
      rows.push({ ...row, rawData });
    } catch (err: any) {
      errors.push(`Row ${i + 2}: ${err.message}`);
    }
  }

  // Detect account/institution from filename, headers, and content
  const detected = detectAccount(filename || '', headers, sampleRows, allDataRowObjects);

  const result: ParseResult = {
    rows,
    headers,
    fileType: 'excel',
    rowCount: rows.length,
    errors,
  };

  if (detected) {
    result.statementMeta = {
      institution: detected.institution,
      accountType: detected.accountType === 'unknown' ? 'checking' : detected.accountType,
      accountNickname: detected.accountNickname,
      period: { start: '', end: '' },
      beginningBalance: 0,
      endingBalance: 0,
      summary: {
        totalDeposits: rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0),
        totalWithdrawals: rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0),
        totalTransfers: 0,
        totalFees: 0,
        transactionCount: rows.length,
        transferCount: 0,
      },
    };
    console.log(`Account detected from Excel: ${detected.institution} ${detected.accountType} (confidence: ${detected.confidence}, source: ${detected.source})`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// PDF Parser
// ---------------------------------------------------------------------------

export async function parsePDF(buffer: Buffer): Promise<ParseResult> {
  const errors: string[] = [];

  let text: string;
  try {
    const { PDFParse } = await import('pdf-parse');
    const instance = new PDFParse({ data: buffer });
    const result = await instance.getText();
    text = result.text;
  } catch (err: any) {
    return {
      rows: [],
      headers: [],
      fileType: 'pdf',
      rowCount: 0,
      errors: [`Failed to parse PDF: ${err.message}`],
    };
  }

  // Try intelligent statement parsing first
  const statementResult = parseStatement(text);
  if (statementResult) {
    return convertStatementToParseResult(statementResult);
  }

  // Fall back to generic PDF parsing
  const genericResult = parseGenericPDF(text);

  // Even for generic PDFs, try to detect the institution and account type from the text
  if (!genericResult.statementMeta) {
    const textDetected = detectAccountFromPDFText(text);
    if (textDetected) {
      genericResult.statementMeta = {
        institution: textDetected.institution,
        accountType: textDetected.accountType === 'unknown' ? 'checking' : textDetected.accountType,
        accountNickname: textDetected.accountNickname,
        period: { start: '', end: '' },
        beginningBalance: 0,
        endingBalance: 0,
        summary: {
          totalDeposits: genericResult.rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0),
          totalWithdrawals: genericResult.rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0),
          totalTransfers: 0,
          totalFees: 0,
          transactionCount: genericResult.rows.length,
          transferCount: 0,
        },
      };
      console.log(`Account detected from PDF text: ${textDetected.institution} ${textDetected.accountType}`);
    }
  }

  return genericResult;
}

function convertStatementToParseResult(result: StatementParseResult): ParseResult {
  const rows: ParsedRow[] = result.transactions.map((txn) => ({
    date: txn.date,
    name: txn.merchantName || txn.description,
    amount: txn.amount,
    category: txn.category,
    account: result.metadata.accountNickname,
    notes: txn.description,
    isTransfer: txn.isTransfer,
    transferType: txn.transferType,
    transferAccountRef: txn.transferAccountRef,
    flags: txn.flags,
    rawData: {
      description: txn.description,
      section: txn.section,
      merchantName: txn.merchantName || '',
    },
  }));

  // Calculate summary statistics
  const deposits = rows.filter((r) => r.amount > 0);
  const withdrawals = rows.filter((r) => r.amount < 0);
  const transfers = rows.filter((r) => r.isTransfer);
  const fees = rows.filter((r) => r.flags?.includes('fee'));

  return {
    rows,
    headers: ['date', 'description', 'amount'],
    fileType: 'pdf',
    rowCount: rows.length,
    errors: result.errors,
    statementMeta: {
      institution: result.metadata.institution,
      accountType: result.metadata.accountType,
      accountNickname: result.metadata.accountNickname,
      period: {
        start: result.metadata.statementPeriod.start,
        end: result.metadata.statementPeriod.end,
      },
      beginningBalance: result.metadata.beginningBalance,
      endingBalance: result.metadata.endingBalance,
      summary: {
        totalDeposits: deposits.reduce((sum, r) => sum + r.amount, 0),
        totalWithdrawals: withdrawals.reduce((sum, r) => sum + Math.abs(r.amount), 0),
        totalTransfers: transfers.length,
        totalFees: fees.reduce((sum, r) => sum + Math.abs(r.amount), 0),
        transactionCount: rows.length,
        transferCount: transfers.length,
      },
    },
  };
}

function parseGenericPDF(text: string): ParseResult {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  // Common bank statement patterns:
  // Pattern 1: MM/DD/YYYY Description Amount
  // Pattern 2: MM/DD Description Amount
  // Pattern 3: YYYY-MM-DD Description Amount
  // Pattern 4: Date Description Debit Credit

  const datePatterns = [
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})/,           // MM/DD/YYYY or MM/DD/YY
    /^(\d{4}-\d{2}-\d{2})/,                      // YYYY-MM-DD
    /^(\d{1,2}-\d{1,2}-\d{2,4})/,               // MM-DD-YYYY
    /^(\w{3}\s+\d{1,2},?\s+\d{4})/,             // Jan 15, 2024
  ];

  // Regex for extracting amounts from end of line
  const amountEndPattern = /(-?\$?[\d,]+\.?\d{0,2})\s*$/;
  const debitCreditPattern = /(-?\$?[\d,]+\.?\d{0,2})\s+(-?\$?[\d,]+\.?\d{0,2})\s*$/;

  const rows: ParsedRow[] = [];

  for (const line of lines) {
    let dateMatch: RegExpMatchArray | null = null;
    for (const pattern of datePatterns) {
      dateMatch = line.match(pattern);
      if (dateMatch) break;
    }

    if (!dateMatch) continue;

    const rawDate = dateMatch[1];
    const rest = line.slice(dateMatch[0].length).trim();

    // Try to extract amount(s) from the end of the remaining text
    let name = '';
    let amount = 0;

    const debitCreditMatch = rest.match(debitCreditPattern);
    if (debitCreditMatch) {
      // Two amounts at end: debit and credit columns
      const debitStr = debitCreditMatch[1];
      const creditStr = debitCreditMatch[2];
      name = rest.slice(0, debitCreditMatch.index).trim();

      const debitVal = normalizeAmount(debitStr, true);
      const creditVal = normalizeAmount(creditStr, false);

      // Use whichever is non-zero; if both present, net them
      if (debitVal !== 0 && creditVal === 0) {
        amount = debitVal;
      } else if (creditVal !== 0 && debitVal === 0) {
        amount = creditVal;
      } else {
        amount = creditVal + debitVal;
      }
    } else {
      const amountMatch = rest.match(amountEndPattern);
      if (amountMatch) {
        name = rest.slice(0, amountMatch.index).trim();
        amount = normalizeAmount(amountMatch[1]);
      } else {
        // No amount found, skip this line
        continue;
      }
    }

    if (!name) continue;

    try {
      const date = normalizeDate(rawDate);
      rows.push({
        date,
        name,
        amount,
        rawData: { line },
      });
    } catch (err: any) {
      errors.push(`PDF line parse error: ${err.message} — "${line}"`);
    }
  }

  return {
    rows,
    headers: ['date', 'description', 'amount'],
    fileType: 'pdf',
    rowCount: rows.length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Column Detection
// ---------------------------------------------------------------------------

const DATE_HEADER_KEYWORDS = ['date', 'posted', 'trans', 'transaction date', 'posting date', 'effective date'];
const AMOUNT_HEADER_KEYWORDS = ['amount', 'total', 'sum', 'value', 'price'];
const DEBIT_HEADER_KEYWORDS = ['debit', 'withdrawal', 'charge', 'expense', 'payment'];
const CREDIT_HEADER_KEYWORDS = ['credit', 'deposit', 'income', 'refund'];
const NAME_HEADER_KEYWORDS = ['description', 'name', 'merchant', 'memo', 'payee', 'vendor', 'details', 'narrative', 'transaction description'];
const CATEGORY_HEADER_KEYWORDS = ['category', 'type', 'class', 'group', 'classification'];
const ACCOUNT_HEADER_KEYWORDS = ['account', 'account name', 'account number', 'source'];
const NOTES_HEADER_KEYWORDS = ['notes', 'note', 'comment', 'remarks', 'reference'];

const DATE_VALUE_PATTERNS = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,    // MM/DD/YYYY or M/D/YY
  /^\d{4}-\d{2}-\d{2}$/,              // YYYY-MM-DD
  /^\d{1,2}-\d{1,2}-\d{2,4}$/,        // MM-DD-YYYY
  /^\d{1,2}\.\d{1,2}\.\d{2,4}$/,      // MM.DD.YYYY (European)
  /^\w{3}\s+\d{1,2},?\s+\d{4}$/,      // Jan 15, 2024
  /^\d{1,2}\s+\w{3}\s+\d{4}$/,        // 15 Jan 2024
];

function looksLikeDate(value: string): boolean {
  const trimmed = value.trim();
  return DATE_VALUE_PATTERNS.some((p) => p.test(trimmed));
}

function looksLikeNumber(value: string): boolean {
  const trimmed = value.trim().replace(/[$,()]/g, '').replace(/^-/, '');
  return trimmed.length > 0 && !isNaN(Number(trimmed));
}

function headerMatches(header: string, keywords: string[]): boolean {
  const lower = header.toLowerCase().trim();
  return keywords.some((kw) => lower.includes(kw));
}

export function detectColumns(headers: string[], sampleRows: Record<string, string>[]): ColumnMap {
  const map: ColumnMap = {
    date: null,
    name: null,
    amount: null,
    debit: null,
    credit: null,
    category: null,
    account: null,
    notes: null,
  };

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const sampleValues = sampleRows.map((row) => row[header] ?? '');

    // Date column
    if (map.date === null && headerMatches(header, DATE_HEADER_KEYWORDS)) {
      const dateHits = sampleValues.filter((v) => looksLikeDate(v)).length;
      if (dateHits > 0 || sampleValues.length === 0) {
        map.date = i;
        continue;
      }
    }

    // Debit column
    if (map.debit === null && headerMatches(header, DEBIT_HEADER_KEYWORDS)) {
      const numHits = sampleValues.filter((v) => v.trim() === '' || looksLikeNumber(v)).length;
      if (numHits >= sampleValues.length * 0.5 || sampleValues.length === 0) {
        map.debit = i;
        continue;
      }
    }

    // Credit column
    if (map.credit === null && headerMatches(header, CREDIT_HEADER_KEYWORDS)) {
      const numHits = sampleValues.filter((v) => v.trim() === '' || looksLikeNumber(v)).length;
      if (numHits >= sampleValues.length * 0.5 || sampleValues.length === 0) {
        map.credit = i;
        continue;
      }
    }

    // Amount column (check after debit/credit so those take priority)
    if (map.amount === null && headerMatches(header, AMOUNT_HEADER_KEYWORDS)) {
      const numHits = sampleValues.filter((v) => looksLikeNumber(v)).length;
      if (numHits > 0 || sampleValues.length === 0) {
        map.amount = i;
        continue;
      }
    }

    // Name / description column
    if (map.name === null && headerMatches(header, NAME_HEADER_KEYWORDS)) {
      map.name = i;
      continue;
    }

    // Category column
    if (map.category === null && headerMatches(header, CATEGORY_HEADER_KEYWORDS)) {
      map.category = i;
      continue;
    }

    // Account column
    if (map.account === null && headerMatches(header, ACCOUNT_HEADER_KEYWORDS)) {
      map.account = i;
      continue;
    }

    // Notes column
    if (map.notes === null && headerMatches(header, NOTES_HEADER_KEYWORDS)) {
      map.notes = i;
      continue;
    }
  }

  // Second pass: if we didn't find date or amount by header keyword, try value heuristics
  if (map.date === null) {
    for (let i = 0; i < headers.length; i++) {
      if (Object.values(map).includes(i)) continue;
      const sampleValues = sampleRows.map((row) => row[headers[i]] ?? '');
      const dateHits = sampleValues.filter((v) => looksLikeDate(v)).length;
      if (dateHits >= sampleValues.length * 0.5 && dateHits > 0) {
        map.date = i;
        break;
      }
    }
  }

  if (map.amount === null && map.debit === null && map.credit === null) {
    for (let i = 0; i < headers.length; i++) {
      if (Object.values(map).includes(i)) continue;
      const sampleValues = sampleRows.map((row) => row[headers[i]] ?? '');
      const numHits = sampleValues.filter((v) => looksLikeNumber(v)).length;
      if (numHits >= sampleValues.length * 0.5 && numHits > 0) {
        map.amount = i;
        break;
      }
    }
  }

  // If we still don't have a name column, pick the longest-text non-assigned column
  if (map.name === null) {
    let bestIdx = -1;
    let bestAvgLen = 0;
    for (let i = 0; i < headers.length; i++) {
      if (Object.values(map).includes(i)) continue;
      const sampleValues = sampleRows.map((row) => row[headers[i]] ?? '');
      const avgLen = sampleValues.reduce((sum, v) => sum + v.length, 0) / Math.max(sampleValues.length, 1);
      if (avgLen > bestAvgLen) {
        bestAvgLen = avgLen;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      map.name = bestIdx;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapRowToTransaction(
  fields: string[],
  headers: string[],
  columnMap: ColumnMap
): Omit<ParsedRow, 'rawData'> {
  // Date
  const rawDate = columnMap.date !== null ? (fields[columnMap.date] ?? '') : '';
  if (!rawDate.trim()) {
    throw new Error('Missing date value');
  }
  const date = normalizeDate(rawDate);

  // Name / description
  const name = columnMap.name !== null ? (fields[columnMap.name] ?? '').trim() : '';
  if (!name) {
    throw new Error('Missing description/name value');
  }

  // Amount: use single amount column, or combine debit/credit
  let amount: number;
  if (columnMap.amount !== null) {
    const rawAmount = fields[columnMap.amount] ?? '';
    if (!rawAmount.trim()) {
      throw new Error('Missing amount value');
    }
    amount = normalizeAmount(rawAmount);
  } else if (columnMap.debit !== null || columnMap.credit !== null) {
    const rawDebit = columnMap.debit !== null ? (fields[columnMap.debit] ?? '').trim() : '';
    const rawCredit = columnMap.credit !== null ? (fields[columnMap.credit] ?? '').trim() : '';

    const debitVal = rawDebit ? normalizeAmount(rawDebit, true) : 0;
    const creditVal = rawCredit ? normalizeAmount(rawCredit, false) : 0;

    // Net: credits are positive, debits are negative
    amount = creditVal + debitVal;

    if (debitVal === 0 && creditVal === 0) {
      throw new Error('Both debit and credit are empty or zero');
    }
  } else {
    throw new Error('No amount, debit, or credit column detected');
  }

  // Optional fields
  const category = columnMap.category !== null ? (fields[columnMap.category] ?? '').trim() || undefined : undefined;
  const account = columnMap.account !== null ? (fields[columnMap.account] ?? '').trim() || undefined : undefined;
  const notes = columnMap.notes !== null ? (fields[columnMap.notes] ?? '').trim() || undefined : undefined;

  return { date, name, amount, category, account, notes };
}

// ---------------------------------------------------------------------------
// Date Normalization
// ---------------------------------------------------------------------------

export function normalizeDate(raw: string): string {
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

  // MM.DD.YYYY (European-style with dots)
  const dotFull = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotFull) {
    const [, m, d, y] = dotFull;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Mon DD, YYYY  (e.g., Jan 15, 2024)
  const monthNameMatch = trimmed.match(/^(\w{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthNameMatch) {
    const [, monthStr, dayStr, yearStr] = monthNameMatch;
    const monthNum = parseMonthName(monthStr);
    if (monthNum !== null) {
      return `${yearStr}-${String(monthNum).padStart(2, '0')}-${dayStr.padStart(2, '0')}`;
    }
  }

  // DD Mon YYYY  (e.g., 15 Jan 2024)
  const dayMonthMatch = trimmed.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (dayMonthMatch) {
    const [, dayStr, monthStr, yearStr] = dayMonthMatch;
    const monthNum = parseMonthName(monthStr);
    if (monthNum !== null) {
      return `${yearStr}-${String(monthNum).padStart(2, '0')}-${dayStr.padStart(2, '0')}`;
    }
  }

  // Fallback: try Date constructor
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  throw new Error(`Unable to parse date: "${raw}"`);
}

// ---------------------------------------------------------------------------
// Amount Normalization
// ---------------------------------------------------------------------------

export function normalizeAmount(raw: string, isDebit?: boolean): number {
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

  // If this column is marked as a debit column, ensure the value is negative
  if (isDebit === true && result > 0) {
    result = -result;
  }

  // Round to 2 decimal places
  return Math.round(result * 100) / 100;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectDelimiter(content: string): string {
  const firstLines = content.split(/\r?\n/).slice(0, 5).join('\n');

  const commaCount = (firstLines.match(/,/g) || []).length;
  const semicolonCount = (firstLines.match(/;/g) || []).length;
  const tabCount = (firstLines.match(/\t/g) || []).length;

  if (tabCount >= commaCount && tabCount >= semicolonCount && tabCount > 0) {
    return '\t';
  }
  if (semicolonCount > commaCount && semicolonCount > 0) {
    return ';';
  }
  return ',';
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }

  // Push last field
  fields.push(current);

  return fields;
}

function parseMonthName(name: string): number | null {
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  return months[name.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// PDF Text Account Detection (for generic PDFs that don't match specific parsers)
// ---------------------------------------------------------------------------

interface PDFDetectedAccount {
  institution: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'unknown';
  accountNickname: string;
}

function detectAccountFromPDFText(text: string): PDFDetectedAccount | null {
  const institutions: { pattern: RegExp; name: string }[] = [
    { pattern: /American Express|Amex/i, name: 'American Express' },
    { pattern: /Chase|JPMorgan/i, name: 'Chase' },
    { pattern: /Bank of America|BofA/i, name: 'Bank of America' },
    { pattern: /Wells?\s*Fargo/i, name: 'Wells Fargo' },
    { pattern: /Capital\s*One/i, name: 'Capital One' },
    { pattern: /Citi(?:bank|group)?/i, name: 'Citi' },
    { pattern: /Discover/i, name: 'Discover' },
    { pattern: /US\s*Bank/i, name: 'US Bank' },
    { pattern: /TD\s*Bank/i, name: 'TD Bank' },
    { pattern: /PNC/i, name: 'PNC' },
    { pattern: /USAA/i, name: 'USAA' },
    { pattern: /Navy\s*Federal/i, name: 'Navy Federal' },
    { pattern: /Ally/i, name: 'Ally Bank' },
    { pattern: /Marcus/i, name: 'Marcus' },
    { pattern: /Fidelity/i, name: 'Fidelity' },
    { pattern: /Schwab/i, name: 'Charles Schwab' },
    { pattern: /Barclays/i, name: 'Barclays' },
    { pattern: /Synchrony/i, name: 'Synchrony' },
  ];

  let detectedInstitution = '';
  for (const inst of institutions) {
    if (inst.pattern.test(text)) {
      detectedInstitution = inst.name;
      break;
    }
  }

  if (!detectedInstitution) return null;

  // Determine account type from content
  let accountType: PDFDetectedAccount['accountType'] = 'unknown';

  // Credit card indicators (strongest signal)
  const ccIndicators = [
    /credit\s*card/i, /credit\s*limit/i, /available\s*credit/i,
    /minimum\s*payment/i, /payment\s*due\s*date/i,
    /new\s*balance/i, /previous\s*balance/i,
    /interest\s*charged/i, /finance\s*charge/i,
    /annual\s*(?:percentage|fee)/i, /apr/i,
    /purchases?\s*(?:and|&)\s*adjustments/i,
    /payments?\s*(?:and|&)\s*credits/i,
    /membership\s*rewards/i, /cash\s*back/i,
    /card\s*member/i, /cardholder/i,
  ];
  const ccScore = ccIndicators.filter(p => p.test(text)).length;

  // Checking/savings indicators
  const checkingIndicators = [
    /checking\s*(?:account|statement)/i, /savings\s*(?:account|statement)/i,
    /beginning\s*balance/i, /ending\s*balance/i,
    /deposits?\s*(?:and|&)/i, /withdrawals?\s*(?:and|&)/i,
    /direct\s*deposit/i, /payroll/i,
    /atm\s*withdrawal/i, /overdraft/i,
  ];
  const checkingScore = checkingIndicators.filter(p => p.test(text)).length;

  if (ccScore >= 2) {
    accountType = 'credit_card';
  } else if (checkingScore >= 2) {
    accountType = /savings/i.test(text) ? 'savings' : 'checking';
  } else if (ccScore > checkingScore) {
    accountType = 'credit_card';
  } else if (checkingScore > ccScore) {
    accountType = 'checking';
  }

  // Some institutions are almost always credit cards
  if (accountType === 'unknown') {
    const ccOnlyInstitutions = ['American Express', 'Discover', 'Synchrony', 'Barclays'];
    if (ccOnlyInstitutions.includes(detectedInstitution)) {
      accountType = 'credit_card';
    } else {
      accountType = 'checking'; // default
    }
  }

  const typeLabel = accountType === 'credit_card' ? 'CC' : accountType === 'savings' ? 'SAV' : 'CHK';

  // Try to find account number
  let last4 = '';
  const acctMatch = text.match(/account\s*(?:ending|number|#)[:\s]*([\d\s*X-]+)/i);
  if (acctMatch) {
    const l4 = acctMatch[1].match(/(\d{4})\s*$/);
    if (l4) last4 = l4[1];
  }

  return {
    institution: detectedInstitution,
    accountType,
    accountNickname: last4
      ? `${detectedInstitution} ${typeLabel} ${last4}`
      : `${detectedInstitution} ${accountType === 'credit_card' ? 'Credit Card' : accountType === 'savings' ? 'Savings' : 'Checking'}`,
  };
}
