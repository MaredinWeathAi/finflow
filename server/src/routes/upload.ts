import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { db } from '../db/database.js';
import { parseFile } from '../engine/parser.js';
import { categorizeItem, learnRule as learnRuleFromCategorizer } from '../engine/categorizer.js';
import { findDuplicates, findCrossFileOverlaps } from '../engine/duplicates.js';
import type { PendingItemData } from '../engine/duplicates.js';
import {
  recordStatementPeriod,
  getStatementPeriodForFile,
  listStatementPeriods,
  deleteStatementPeriodsForSession,
  describeReconciliation,
} from '../db/statement-metadata.js';
import type { StatementPeriodRow } from '../db/statement-metadata.js';
import { DEFAULT_CATEGORIES } from '../engine/default-categories.js';

const router = Router();

// Configure multer for file uploads
// SECURITY (audit finding M1): the previous limits allowed 50 x 20 MB = 1 GB of
// attacker-controlled data to be buffered in memory per request, on a single
// Node process that then parses it synchronously. Tightened to a realistic
// statement-import workload with a hard aggregate cap.
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_FILES = 15;                       // per request
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;   // 40 MB aggregate per request

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
    fields: 20,
    parts: MAX_FILES + 20,
    headerPairs: 100,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
    if (!allowed.includes(ext)) {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: CSV, Excel, PDF`));
      return;
    }
    // Reject path separators and control characters in the client-supplied name.
    if (/[\/\\\0]/.test(file.originalname) || file.originalname.length > 255) {
      cb(new Error('Invalid file name'));
      return;
    }
    cb(null, true);
  },
});

/** Enforce the aggregate byte cap that multer's per-file limit cannot express. */
function enforceTotalSize(req: Request, res: Response, next: NextFunction): void {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    res.status(413).json({
      error: `Upload too large: ${(total / 1048576).toFixed(1)} MB across ${files.length} files. Limit is ${MAX_TOTAL_BYTES / 1048576} MB per request.`,
    });
    return;
  }
  next();
}

// A transfer moves money between accounts the household owns. Deciding that
// from the descriptor needs EVIDENCE of an account on the other side — not a
// keyword that happens to appear in the text.
//
// The previous implementation matched bare substrings, which produced:
//   'ach'      inside "PUBLIX ... MIAMI BEACH FL", "COACH OUTLET", "PEACH COBBLER"
//   'bill pay' inside "FLORIDA POWER & LIGHT (FPL) Bill Payment"  (a utility bill)
//   'zelle'    on the owner's monthly pay from his own company
// — roughly 39% of an imported bank export ended up filed as "Transfer".
//
// Zelle, Venmo, PayPal and Cash App are deliberately NOT transfer signals.
// They are payment rails: this household receives most of its income and pays
// its contractors over Zelle. The rail says nothing about what the money is.
const INTERNAL_TRANSFER_RE = new RegExp(
  [
    // BofA / most US banks name the counterpart account explicitly
    '\\btransfer (?:to|from) (?:chk|sav|checking|savings)\\b',
    '\\bonline (?:banking |scheduled )?transfer\\b',
    '\\bautomatic transfer\\b',
    '\\boverdraft protection (?:to|from)\\b',
    '\\bkeep the change\\b',
    '\\binternal transfer\\b',
    '\\bbetween accounts\\b',
    '\\b(?:to|from) (?:my )?(?:checking|savings)\\b',
  ].join('|'),
  'i',
);

// Paying down a card or loan. Requires an issuer or an explicit card/loan
// reference — never a bare "payment", because "Rent Payment" and "MTG PMT"
// are ordinary expenses.
const CARD_OR_LOAN_PAYMENT_RE = new RegExp(
  [
    '\\bpayment to (?:crd|card)\\b',
    '\\bcredit card (?:bill )?payment\\b',
    '\\b(?:cc|crd) (?:pmt|payment)\\b',
    '(?:american express|amex|citibank|citi card|discover|barclay|synchrony|capital one|chase)\\b[^\\n]*\\b(?:bill payment|payment|pmt|pymt|ach pmt|autopay|e-?pay)\\b',
  ].join('|'),
  'i',
);

function detectTransferType(name: string, _amount: number): { isTransfer: boolean; transferType?: string } {
  // Card/loan payments are checked first: "Online Banking payment to CRD 7533"
  // is a debt payment, not an internal shuffle, even though both are non-spending.
  if (CARD_OR_LOAN_PAYMENT_RE.test(name)) {
    return { isTransfer: true, transferType: 'credit_card_payment' };
  }
  if (INTERNAL_TRANSFER_RE.test(name)) {
    return { isTransfer: true, transferType: 'internal' };
  }
  return { isTransfer: false };
}

// Helper: classify income type
function classifyIncomeType(name: string, amount: number): string {
  if (amount <= 0) return 'expense';

  const lowerName = name.toLowerCase();

  // Recurring income patterns
  const recurringIncomeKeywords = ['payroll', 'salary', 'direct deposit', 'wage', 'paycheck', 'pension', 'social security', 'disability', 'unemployment'];
  if (recurringIncomeKeywords.some(kw => lowerName.includes(kw))) return 'recurring_income';

  // Investment/interest income
  const investmentKeywords = ['dividend', 'interest', 'capital gain', 'distribution'];
  if (investmentKeywords.some(kw => lowerName.includes(kw))) return 'investment_income';

  // Refunds/reimbursements
  const refundKeywords = ['refund', 'reimburse', 'return', 'cashback', 'credit', 'reversal'];
  if (refundKeywords.some(kw => lowerName.includes(kw))) return 'refund';

  // One-time/misc income
  return 'other_income';
}

// Helper: auto-create account from statement metadata
async function autoCreateAccount(userId: string, statementMeta: any): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Map statement account type to our account types
  let accountType = 'checking';
  const stmtType = (statementMeta.accountType || '').toLowerCase();
  if (stmtType.includes('saving')) accountType = 'savings';
  else if (stmtType.includes('credit') || stmtType.includes('card')) accountType = 'credit';
  else if (stmtType.includes('loan') || stmtType.includes('mortgage')) accountType = 'loan';
  else if (stmtType.includes('invest') || stmtType.includes('brokerage')) accountType = 'investment';

  const institution = statementMeta.institution || 'Unknown';
  const accountNickname = statementMeta.accountNickname || '';
  const accountName = accountNickname || `${institution} ${accountType.charAt(0).toUpperCase() + accountType.slice(1)}`;
  // Seed the account at the statement's OPENING balance, not its closing one.
  //
  // Importing the statement's rows then walks the balance forward to the real
  // closing figure. Seeding at the closing balance applied the period's net a
  // second time: a statement opening $6,673.23 and closing $5,824.43 left the
  // account at $4,975.63, and every later statement compounded the error.
  // Falls back to the closing balance only when no opening balance was found,
  // which is still wrong by one period but is the best available anchor.
  const balance = statementMeta.beginningBalance ?? statementMeta.startingBalance ?? statementMeta.endingBalance ?? 0;

  // Extract last 4 digits from accountNumber or accountNickname
  let lastFour = '';
  const acctNum = statementMeta.accountNumber || '';
  const last4Match = acctNum.match(/(\d{4})\s*$/);
  if (last4Match) {
    lastFour = last4Match[1];
  } else {
    const nickMatch = accountNickname.match(/(\d{4})\s*$/);
    if (nickMatch) lastFour = nickMatch[1];
  }

  // Check if similar account already exists (multiple strategies)
  let existing: any = null;

  // Most specific: same institution + same last 4
  if (institution && institution !== 'Unknown' && lastFour) {
    existing = await db.get(`SELECT id, type FROM accounts WHERE user_id = ? AND institution LIKE ? AND last_four = ?`, userId, `%${institution}%`, lastFour) as any;
  }

  // Same institution + same type
  if (!existing && institution && institution !== 'Unknown') {
    existing = await db.get(`SELECT id, type FROM accounts WHERE user_id = ? AND institution LIKE ? AND type = ?`, userId, `%${institution}%`, accountType) as any;
  }

  // Exact name match
  if (!existing) {
    existing = await db.get(`SELECT id, type FROM accounts WHERE user_id = ? AND name = ?`, userId, accountName) as any;
  }

  if (existing) {
    // If existing account has wrong type (e.g., was defaulted to 'checking' but should be 'credit'),
    // update it to the correct type if we have higher confidence now
    if (existing.type !== accountType && accountType !== 'checking') {
      const icon = accountType === 'credit' ? '💳' : accountType === 'savings' ? '💰' : accountType === 'investment' ? '📊' : '🏦';
      await db.run(`UPDATE accounts SET type = ?, icon = ?, institution = COALESCE(NULLIF(?, 'Unknown'), institution), last_four = COALESCE(NULLIF(?, ''), last_four), updated_at = ? WHERE id = ?`, accountType, icon, institution, lastFour, now, existing.id);
      console.log(`Updated account ${existing.id} type from ${existing.type} to ${accountType}`);
    }
    return existing.id;
  }

  // Create new account (marked as 'upload' source so it's protected from re-seeding)
  const icon = accountType === 'credit' ? '💳' : accountType === 'savings' ? '💰' : accountType === 'investment' ? '📊' : '🏦';
  await db.run(`INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'upload', ?, ?)`, id, userId, accountName, accountType, institution, balance, lastFour || null, icon, now, now);

  console.log(`Auto-created account: ${accountName} (${accountType}) at ${institution} for user ${userId}`);
  return id;
}

// Ensure user has default categories
/**
 * Make sure every default category exists for this user.
 *
 * This used to bail out the moment the user had ANY category, which meant new
 * defaults only ever reached brand-new accounts. Anyone who had already
 * imported a statement silently never got them — and a categorisation rule
 * pointing at a category that does not exist resolves to nothing, so the rule
 * looks broken when it is the seeding that is.
 *
 * Now it fills in what is missing and leaves everything else, including the
 * user's own categories, untouched.
 */
async function ensureDefaultCategories(userId: string): Promise<void> {
  const defaults = DEFAULT_CATEGORIES;

  const existing = await db.all(
    'SELECT LOWER(name) as "lowerName" FROM categories WHERE user_id = ?',
    userId,
  ) as Array<{ lowerName: string }>;
  const have = new Set(existing.map((c) => c.lowerName));

  const missing = defaults.filter((c) => !have.has(c.name.toLowerCase()));
  if (missing.length === 0) return;

  const INSERT_CATEGORY_SQL =
    `INSERT INTO categories (id, user_id, name, icon, color, is_income, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`;

  let sortOrder = have.size;
  for (const cat of missing) {
    await db.run(INSERT_CATEGORY_SQL, crypto.randomUUID(), userId, cat.name, cat.icon, cat.color, cat.isIncome ? 1 : 0, sortOrder);
    sortOrder += 1;
  }

  console.log(`Added ${missing.length} missing default categories for user ${userId}`);
}

// POST / - upload files, parse, detect duplicates, auto-create accounts
router.post('/', upload.array('files', MAX_FILES), enforceTotalSize, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Ensure user has default categories
    await ensureDefaultCategories(userId);

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    // Create upload session
    await db.run(`INSERT INTO upload_sessions (id, user_id, status, file_count, created_at)
       VALUES (?, ?, 'processing', ?, ?)`, sessionId, userId, files.length, now);

    let allPendingItems: PendingItemData[] = [];
    const fileResults: any[] = [];

    // Parse each file
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      const fileType = ext === 'xls' ? 'xlsx' : ext;

      // Insert file record
      await db.run(`INSERT INTO uploaded_files (id, session_id, user_id, filename, file_type, file_size, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'parsing', ?)`, fileId, sessionId, userId, file.originalname, fileType, file.size, now);

      try {
        // Parse the file
        const result = await parseFile(file.buffer, file.originalname);

        // Auto-create account from statement metadata if needed
        let autoAccountId: string | null = null;
        if (result.statementMeta) {
          autoAccountId = await autoCreateAccount(userId, result.statementMeta);
        }

        // If user has no accounts at all, create a default checking account
        if (!autoAccountId) {
          const accountCount = (await db.get('SELECT COUNT(*) as count FROM accounts WHERE user_id = ?', userId) as any).count;
          if (accountCount === 0) {
            const defaultAcctId = crypto.randomUUID();
            await db.run(`INSERT INTO accounts (id, user_id, name, type, institution, balance, icon, is_hidden, created_at, updated_at)
               VALUES (?, ?, 'Main Account', 'checking', 'My Bank', 0, '🏦', 0, ?, ?)`, defaultAcctId, userId, now, now);
            autoAccountId = defaultAcctId;
          }
        }

        // Update file record
        await db.run(`UPDATE uploaded_files SET row_count = ?, status = 'parsed' WHERE id = ?`, result.rowCount, fileId);

        // Create pending items from parsed rows
        const INSERT_PENDING_SQL =
          `INSERT INTO pending_items (id, session_id, file_id, user_id, item_type, raw_data, parsed_name, parsed_amount, parsed_date, parsed_category, matched_category_id, matched_account_id, status, confidence, created_at)
           VALUES (?, ?, ?, ?, 'transaction', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const filePendingItems: PendingItemData[] = [];
        let flaggedDateCount = 0;

        // Date guard: no imported transaction may post-date the statement
        // period it came from (or, when no period was extracted, the upload
        // date + a small grace). Violations are flagged for review instead of
        // being imported quietly.
        const periodEnd = result.statementMeta?.period?.end || '';
        const uploadCutoff = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

        for (const row of result.rows) {
          const itemId = crypto.randomUUID();

          const dateOutOfRange =
            (row.flags ?? []).includes('date_out_of_range') ||
            (/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ? row.date > periodEnd : row.date > uploadCutoff);

          // Auto-categorize
          const catResult = await categorizeItem(row.name, row.amount, userId, autoAccountId);

          // Detect transfer type
          const transferInfo = detectTransferType(row.name, row.amount);

          // Route to the right bucket. Card and loan payments go to CC PMT, not
          // to Transfer: the previous code computed the credit_card_payment
          // subtype and then threw it away, which is why CC PMT held a single
          // row against ~$189k of real card and loan principal.
          //
          // A merchant match that already identified the payee wins over a
          // transfer guess. "FLORIDA POWER & LIGHT (FPL) Bill Payment" is a
          // utility bill; the old override relabelled it Transfer and $9,554 of
          // electricity vanished from spending.
          let finalCategoryId = catResult.categoryId;
          let finalCategoryName = catResult.categoryName;

          const bucketFor = async (categoryName: string) => {
            const cat = await db.get(
              `SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) = ?`,
              userId, categoryName.toLowerCase(),
            ) as any;
            if (cat) {
              finalCategoryId = cat.id;
              finalCategoryName = cat.name;
            }
          };

          if (transferInfo.transferType === 'credit_card_payment') {
            await bucketFor('CC PMT');
          } else if (transferInfo.transferType === 'internal' || row.isTransfer) {
            if (!catResult.categoryId) await bucketFor('Transfer');
          }

          // A rule's category wins outright. It does NOT rewrite the amount:
          // forcing the sign to match an assign_type turned debits into credits
          // and was how petrol stations ended up recorded as money coming in.
          // The sign belongs to the bank, not to a categorisation rule.
          const finalAmount = row.amount;
          if (catResult.assignType && catResult.categoryId) {
            finalCategoryId = catResult.categoryId;
            finalCategoryName = catResult.categoryName;
          }

          // Classify income type
          const incomeType = classifyIncomeType(row.name, finalAmount);

          const itemStatus = dateOutOfRange ? 'flagged' : 'pending';
          if (dateOutOfRange) flaggedDateCount++;

          const dateWarning = dateOutOfRange
            ? (periodEnd
                ? `Parsed date ${row.date} is after the statement period end (${periodEnd}) — likely a year-inference problem. Review and correct before importing.`
                : `Parsed date ${row.date} is in the future — review and correct before importing.`)
            : undefined;

          await db.run(INSERT_PENDING_SQL,
            itemId, sessionId, fileId, userId,
            JSON.stringify({ ...row.rawData, incomeType, transferType: transferInfo.transferType || row.transferType || null, ...(dateWarning ? { dateWarning } : {}) }),
            row.name,
            finalAmount,
            row.date,
            row.category || finalCategoryName || null,
            finalCategoryId,
            autoAccountId,
            itemStatus,
            catResult.confidence,
            now
          );

          if (dateOutOfRange) {
            await db.run(`INSERT INTO clarifications (id, user_id, source, item_type, title, description, context, status, created_at)
               VALUES (?, ?, 'upload', 'date', ?, ?, ?, 'pending', ?)`,
              crypto.randomUUID(), userId,
              `Suspicious date: ${row.name}`,
              dateWarning,
              JSON.stringify({ itemId, name: row.name, amount: finalAmount, date: row.date, statementPeriodEnd: periodEnd || null }),
              now
            );
          }

          filePendingItems.push({
            id: itemId,
            parsed_name: row.name,
            parsed_amount: row.amount,
            parsed_date: row.date,
            parsed_category: row.category || finalCategoryName,
            matched_category_id: finalCategoryId || undefined,
            file_id: fileId,
          });
        }

        allPendingItems = [...allPendingItems, ...filePendingItems];

        // ── Persist statement metadata (audit item 19) ─────────────────
        // The parser extracts the statement period, opening/closing balances
        // and fee/interest totals; until now they were discarded after this
        // request. Persisting them (a) gives the date guard a durable anchor
        // — the real statement period, not the import timestamp — and (b)
        // enables the reconciliation check: do the parsed rows sum from the
        // opening balance to the closing balance? A discrepancy is the most
        // reliable signal that parsing missed rows.
        let statementPeriod: StatementPeriodRow | null = null;
        let reconciliation: string | null = null;
        try {
          let totalInterest = 0;
          let totalFees = 0;
          let parsedNet = 0;
          let derivedStart: string | null = null;
          let derivedEnd: string | null = null;
          for (const row of result.rows) {
            parsedNet += row.amount;
            if (/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
              if (!derivedStart || row.date < derivedStart) derivedStart = row.date;
              if (!derivedEnd || row.date > derivedEnd) derivedEnd = row.date;
            }
            if (row.amount < 0) {
              if (/\binterest\b/i.test(row.name)) {
                totalInterest += Math.abs(row.amount);
              } else if ((row.flags ?? []).includes('fee') || /\bfee\b|finance charge|overdraft|\bnsf\b/i.test(row.name)) {
                totalFees += Math.abs(row.amount);
              }
            }
          }
          statementPeriod = await recordStatementPeriod(db, {
            userId,
            accountId: autoAccountId,
            sessionId,
            fileId,
            sourceFile: file.originalname,
            institution: result.statementMeta?.institution || null,
            accountType: result.statementMeta?.accountType || null,
            periodStart: result.statementMeta?.period?.start || '',
            periodEnd: result.statementMeta?.period?.end || '',
            derivedStart,
            derivedEnd,
            openingBalance: result.statementMeta?.beginningBalance ?? 0,
            closingBalance: result.statementMeta?.endingBalance ?? 0,
            totalFees,
            totalInterest,
            transactionCount: result.rows.length,
            parsedNet,
          });
          reconciliation = describeReconciliation(statementPeriod);
          if (statementPeriod.reconciled === 0) {
            // Surface the strongest missing-rows signal we have as a
            // clarification the user will actually see.
            await db.run(`INSERT INTO clarifications (id, user_id, source, item_type, title, description, context, status, created_at)
               VALUES (?, ?, 'upload', 'reconciliation', ?, ?, ?, 'pending', ?)`,
              crypto.randomUUID(), userId,
              `Statement doesn't reconcile: ${file.originalname}`,
              reconciliation,
              JSON.stringify({
                fileId,
                sessionId,
                periodStart: statementPeriod.period_start,
                periodEnd: statementPeriod.period_end,
                openingBalance: statementPeriod.opening_balance,
                closingBalance: statementPeriod.closing_balance,
                parsedNet: statementPeriod.parsed_net,
                expectedNet: statementPeriod.expected_net,
                discrepancy: statementPeriod.discrepancy,
              }),
              now
            );
          }
        } catch (metaErr: any) {
          console.error(`Failed to persist statement metadata for ${file.originalname}:`, metaErr);
        }

        // Count transaction types
        const depositCount = filePendingItems.filter((item) => item.parsed_amount > 0).length;
        const withdrawalCount = filePendingItems.filter((item) => item.parsed_amount < 0).length;
        const transferCount = result.rows.filter((row) => row.isTransfer).length;

        fileResults.push({
          id: fileId,
          filename: file.originalname,
          fileType,
          rowCount: result.rowCount,
          status: 'parsed',
          errors: result.errors,
          depositCount,
          withdrawalCount,
          transferCount,
          flaggedDateCount,
          statementMeta: result.statementMeta,
          statementPeriod,
          reconciliation,
          autoAccountId,
        });
      } catch (parseError: any) {
        await db.run(`UPDATE uploaded_files SET status = 'error', error_message = ? WHERE id = ?`, parseError.message, fileId);

        fileResults.push({
          id: fileId,
          filename: file.originalname,
          fileType,
          rowCount: 0,
          status: 'error',
          error: parseError.message,
          depositCount: 0,
          withdrawalCount: 0,
          transferCount: 0,
          statementMeta: undefined,
        });
      }
    }

    // Detect duplicates against existing transactions
    const dbDuplicates = await findDuplicates(allPendingItems, userId);

    // Detect cross-file overlaps
    const crossDuplicates = findCrossFileOverlaps(allPendingItems);

    // Mark duplicate items in DB
    const allDuplicateMatches = [...dbDuplicates, ...crossDuplicates];
    let duplicateCount = 0;

    for (const dup of allDuplicateMatches) {
      if (dup.score >= 70) {
        await db.run(`UPDATE pending_items SET status = 'duplicate', duplicate_of = ?, confidence = ? WHERE id = ?`, dup.matchedTransactionId, dup.score / 100, dup.itemId);
        duplicateCount++;
      }
    }

    // Generate clarifications for uncategorized items
    const uncategorized = allPendingItems.filter(item => !item.matched_category_id);
    for (const item of uncategorized.slice(0, 20)) {
      await db.run(`INSERT INTO clarifications (id, user_id, source, item_type, title, description, context, status, created_at)
         VALUES (?, ?, 'upload', 'category', ?, ?, ?, 'pending', ?)`, crypto.randomUUID(), userId, `Categorize: ${item.parsed_name}`, `We couldn't auto-categorize "${item.parsed_name}" ($${Math.abs(item.parsed_amount).toFixed(2)}). Please select a category.`, JSON.stringify({ itemId: item.id, name: item.parsed_name, amount: item.parsed_amount, date: item.parsed_date }), now);
    }

    // Update session totals
    const totalItems = allPendingItems.length;
    await db.run(`UPDATE upload_sessions SET status = 'review', total_items = ?, duplicate_items = ? WHERE id = ?`, totalItems, duplicateCount, sessionId);

    // Return session summary
    res.json({
      id: sessionId,
      sessionId,
      status: 'review',
      file_count: files.length,
      total_items: totalItems,
      imported_items: 0,
      duplicate_items: duplicateCount,
      created_at: now,
      completed_at: null,
      files: fileResults,
      totalItems,
      duplicateItems: duplicateCount,
      flaggedDateItems: fileResults.reduce((sum, f) => sum + (f.flaggedDateCount || 0), 0),
      uncategorizedItems: uncategorized.length,
      duplicates: allDuplicateMatches.filter(d => d.score >= 50),
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// GET /sessions - list upload sessions
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessions = await db.all(`SELECT * FROM upload_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, userId) as any[];

    const GET_FILES_SQL = 'SELECT * FROM uploaded_files WHERE session_id = ?';
    const enriched = await Promise.all(sessions.map(async s => ({
      ...s,
      files: await db.all(GET_FILES_SQL, s.id),
    })));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /statements - persisted statement metadata + reconciliation report.
// One row per uploaded statement file: period, opening/closing balances,
// fee/interest totals, and whether the parsed transactions sum from the
// opening balance to the closing balance (the missing-rows detector).
router.get('/statements', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const periods = await listStatementPeriods(db, userId);
    const withVerdicts = periods.map((p) => ({
      ...p,
      reconciliation: describeReconciliation(p),
    }));
    const unreconciled = withVerdicts.filter((p) => p.reconciled === 0).length;
    res.json({
      statements: withVerdicts,
      count: withVerdicts.length,
      unreconciledCount: unreconciled,
    });
  } catch (error) {
    console.error('List statements error:', error);
    res.status(500).json({ error: 'Failed to list statement periods' });
  }
});

// GET /sessions/:id - get session with pending items
router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const session = await db.get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', id, userId) as any;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const files = await db.all('SELECT * FROM uploaded_files WHERE session_id = ?', id);

    const items = (await db.all(`SELECT pi.*, c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM pending_items pi
         LEFT JOIN categories c ON pi.matched_category_id = c.id
         WHERE pi.session_id = ?
         ORDER BY pi.parsed_date DESC, pi.parsed_name ASC`, id))
      .map((item: any) => ({
        ...item,
        raw_data: JSON.parse(item.raw_data || '{}'),
      }));

    res.json({ ...session, files, items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Helper: extract a "core name" from a transaction description for similarity matching.
// Strips numbers, trailing reference IDs, and normalises whitespace so
// "AMEX AUTOPAY 230415" and "AMEX AUTOPAY 230502" both become "amex autopay".
function extractCoreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#\-_:\/\\*]+/g, ' ')      // replace common separators with space
    .replace(/\b\d+\b/g, '')             // drop ALL standalone numbers (refs, dates, indices)
    .replace(/\d+\.\d+/g, '')            // drop decimal numbers (amounts)
    .replace(/\s+/g, ' ')                // collapse whitespace
    .trim();
}

// PUT /items/bulk-update - update multiple items at once
// IMPORTANT: This route must be defined BEFORE /items/:id to avoid being caught by the param route
router.put('/items/bulk-update', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { itemIds, updates } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required' });
    }

    // Build dynamic SET clause — same fix as PUT /items/:id to avoid COALESCE bug
    const fields: string[] = [];
    const vals: any[] = [];
    const bulkAllowed = ['status', 'matched_category_id', 'matched_account_id'];
    for (const field of bulkAllowed) {
      if (field in updates) {
        fields.push(`${field} = ?`);
        vals.push(updates[field]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = await db.tx(async (t) => {
      let updated = 0;
      for (const id of itemIds) {
        const result = await t.run(`UPDATE pending_items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, ...vals, id, userId);
        updated += result.changes;
      }
      return updated;
    });
    res.json({ message: `${updated} items updated`, updated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to bulk update items' });
  }
});

// PUT /items/:id - approve/skip/edit a pending item (with smart learn-and-apply)
router.put('/items/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const body = req.body;

    const existing = await db.get('SELECT * FROM pending_items WHERE id = ? AND user_id = ?', id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Build dynamic UPDATE — only set fields that were explicitly sent in the request.
    // This fixes the COALESCE bug where sending null for matched_category_id or
    // matched_account_id was silently ignored (COALESCE treats null as "keep old value").
    const fields: string[] = [];
    const values: any[] = [];

    const allowedFields = ['status', 'parsed_name', 'parsed_amount', 'parsed_date', 'matched_category_id', 'matched_account_id'];
    for (const field of allowedFields) {
      if (field in body) {
        fields.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (fields.length > 0) {
      values.push(id, userId);
      await db.run(`UPDATE pending_items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, ...values);
    }

    // Re-read for smart learn-and-apply below
    const { matched_category_id, matched_account_id, status } = {
      ...existing,
      ...Object.fromEntries(allowedFields.filter(f => f in body).map(f => [f, body[f]])),
    };

    // ── Smart learn-and-apply ──────────────────────────────────────────
    // When a user assigns a category, learn the rule AND auto-apply it
    // to all similar pending items in the same session.
    const autoUpdated: Array<{ id: string; matched_category_id: string; status: string }> = [];

    if (matched_category_id && existing.parsed_name) {
      // 1. Learn the rule so future uploads auto-categorize
      try {
        await learnRuleFromCategorizer(userId, existing.parsed_name.toLowerCase(), matched_category_id, 'contains');
      } catch (e) { /* ignore duplicate rules */ }

      // 2. Find similar pending items in the same session
      const coreName = extractCoreName(existing.parsed_name);
      if (coreName.length >= 3) {
        const siblings = await db.all(`SELECT id, parsed_name FROM pending_items
             WHERE session_id = ? AND user_id = ? AND id != ?
               AND status IN ('pending', 'duplicate')
               AND (matched_category_id IS NULL OR matched_category_id = '')`, existing.session_id, userId, id) as Array<{ id: string; parsed_name: string }>;

        const toUpdate: string[] = [];
        for (const sib of siblings) {
          const sibCore = extractCoreName(sib.parsed_name);
          // Match if core names are identical, or one contains the other (min 3 chars)
          if (
            sibCore === coreName ||
            (sibCore.length >= 3 && coreName.includes(sibCore)) ||
            (sibCore.length >= 3 && sibCore.includes(coreName))
          ) {
            toUpdate.push(sib.id);
          }
        }

        if (toUpdate.length > 0) {
          const UPDATE_SIBLING_SQL =
            `UPDATE pending_items SET matched_category_id = ?, status = 'approved' WHERE id = ?`;
          await db.tx(async (t) => {
            for (const sibId of toUpdate) {
              await t.run(UPDATE_SIBLING_SQL, matched_category_id, sibId);
              autoUpdated.push({ id: sibId, matched_category_id, status: 'approved' });
            }
          });
        }
      }
    }

    res.json({
      message: 'Item updated',
      autoUpdated,  // frontend uses this to update its local state
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// POST /sessions/:id/import - import approved/pending items as transactions
router.post('/sessions/:id/import', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { importAll } = req.body;

    const session = await db.get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', id, userId) as any;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Import items based on mode:
    // - importAll: import all non-skipped, non-imported items (pending, approved, duplicate)
    // - default (Import Approved): import approved items AND pending items that have a category assigned
    let items: any[];
    if (importAll) {
      // 'flagged' items (date guard violations) are never imported implicitly:
      // the user must review them and explicitly approve (which changes the
      // status) after correcting the date.
      items = await db.all(`SELECT * FROM pending_items WHERE session_id = ? AND user_id = ? AND status NOT IN ('skipped', 'imported', 'flagged')`, id, userId) as any[];
    } else {
      items = await db.all(`SELECT * FROM pending_items WHERE session_id = ? AND user_id = ? AND (status = 'approved' OR (status = 'pending' AND matched_category_id IS NOT NULL AND matched_category_id != ''))`, id, userId) as any[];
    }

    if (items.length === 0) {
      return res.json({ message: 'No items to import', imported: 0 });
    }

    // ── Date guard, anchored on the persisted statement period ────────────
    // A statement cannot contain activity that post-dates its own closing
    // date, so an item whose date lands after its file's REAL statement
    // period (period_source = 'statement'; 'derived' ranges came from the
    // rows themselves and prove nothing) is never imported — regardless of
    // status, because review edits (PUT /items/:id) can change parsed_date
    // without re-running the upload-time guard. Violations flip back to
    // 'flagged' with a clarification instead of quietly entering history.
    const guardNow = new Date().toISOString();
    const periodByFile = new Map<string, StatementPeriodRow | undefined>();
    const importable: any[] = [];
    let skippedDateGuard = 0;
    for (const item of items) {
      if (!periodByFile.has(item.file_id)) {
        periodByFile.set(item.file_id, await getStatementPeriodForFile(db, userId, item.file_id));
      }
      const period = periodByFile.get(item.file_id);
      const hardEnd =
        period && period.period_source === 'statement' && period.period_end ? period.period_end : null;
      if (hardEnd && item.parsed_date && item.parsed_date > hardEnd) {
        skippedDateGuard++;
        await db.run(`UPDATE pending_items SET status = 'flagged' WHERE id = ? AND user_id = ?`, item.id, userId);
        await db.run(`INSERT INTO clarifications (id, user_id, source, item_type, title, description, context, status, created_at)
           VALUES (?, ?, 'upload', 'date', ?, ?, ?, 'pending', ?)`,
          crypto.randomUUID(), userId,
          `Blocked at import: ${item.parsed_name}`,
          `Date ${item.parsed_date} is after the statement period end (${hardEnd}) recorded for its source file — a statement cannot contain activity after its closing date. Correct the date, then approve.`,
          JSON.stringify({ itemId: item.id, name: item.parsed_name, amount: item.parsed_amount, date: item.parsed_date, statementPeriodEnd: hardEnd }),
          guardNow
        );
      } else {
        importable.push(item);
      }
    }
    items = importable;
    if (items.length === 0) {
      return res.json({
        message: 'No items imported: all candidates violate their statement period (see clarifications)',
        imported: 0,
        skippedDateGuard,
      });
    }

    // Get or create default account
    let defaultAccount = await db.get("SELECT id FROM accounts WHERE user_id = ? ORDER BY CASE WHEN type = 'checking' THEN 0 ELSE 1 END, created_at ASC LIMIT 1", userId) as any;

    if (!defaultAccount) {
      // Auto-create a default account
      const accId = crypto.randomUUID();
      const now2 = new Date().toISOString();
      await db.run(`INSERT INTO accounts (id, user_id, name, type, institution, balance, icon, is_hidden, source, created_at, updated_at)
         VALUES (?, ?, 'Main Account', 'checking', 'My Bank', 0, '🏦', 0, 'upload', ?, ?)`, accId, userId, now2, now2);
      defaultAccount = { id: accId };
    }

    const now = new Date().toISOString();
    let importedCount = 0;

    const INSERT_TX_SQL =
      `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, tags, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', 'upload', ?, ?)`;

    const UPDATE_ITEM_SQL =
      `UPDATE pending_items SET status = 'imported' WHERE id = ?`;

    await db.tx(async (t) => {
      for (const item of items) {
        const accountId = item.matched_account_id || defaultAccount.id;
        const txId = crypto.randomUUID();

        await t.run(INSERT_TX_SQL,
          txId, userId, accountId,
          item.parsed_name,
          item.parsed_amount,
          item.matched_category_id || null,
          item.parsed_date,
          `Imported from upload session`,
          now, now
        );

        await t.run(UPDATE_ITEM_SQL, item.id);

        // Update account balance
        await t.run('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?', item.parsed_amount, now, accountId);

        importedCount++;
      }
    });

    // Update session
    await db.run(`UPDATE upload_sessions SET status = 'completed', imported_items = ?, completed_at = ? WHERE id = ?`, importedCount, now, id);

    res.json({
      message: `Successfully imported ${importedCount} transactions${skippedDateGuard > 0 ? ` (${skippedDateGuard} blocked by the statement-period date guard)` : ''}`,
      imported: importedCount,
      skippedDateGuard,
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import transactions' });
  }
});

// DELETE /sessions/:id - delete an upload session
router.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    await db.run('DELETE FROM pending_items WHERE session_id = ? AND user_id = ?', id, userId);
    await db.run('DELETE FROM uploaded_files WHERE session_id = ? AND user_id = ?', id, userId);
    await db.run('DELETE FROM upload_sessions WHERE id = ? AND user_id = ?', id, userId);
    await deleteStatementPeriodsForSession(db, userId, String(id));

    res.json({ message: 'Session deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

export default router;
