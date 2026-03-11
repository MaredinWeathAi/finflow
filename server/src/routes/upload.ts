import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { db } from '../db/database.js';
import { parseFile } from '../engine/parser.js';
import { categorizeItem, learnRule as learnRuleFromCategorizer } from '../engine/categorizer.js';
import { findDuplicates, findCrossFileOverlaps } from '../engine/duplicates.js';
import type { PendingItemData } from '../engine/duplicates.js';

const router = Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: CSV, Excel, PDF`));
    }
  },
});

// Helper: detect if a transaction looks like a transfer
function detectTransferType(name: string, amount: number): { isTransfer: boolean; transferType?: string } {
  const lowerName = name.toLowerCase();
  const transferKeywords = [
    'transfer', 'xfer', 'tfr', 'payment to', 'payment from',
    'zelle', 'venmo', 'paypal', 'wire', 'ach',
    'credit card payment', 'cc payment', 'card payment',
    'online payment', 'autopay', 'bill pay',
    'from checking', 'from savings', 'to checking', 'to savings',
    'internal transfer', 'between accounts'
  ];
  const isTransfer = transferKeywords.some(kw => lowerName.includes(kw));

  if (!isTransfer) return { isTransfer: false };

  // Determine transfer type
  if (lowerName.includes('credit card') || lowerName.includes('cc payment') || lowerName.includes('card payment')) {
    return { isTransfer: true, transferType: 'credit_card_payment' };
  }
  if (lowerName.includes('zelle') || lowerName.includes('venmo') || lowerName.includes('paypal')) {
    return { isTransfer: true, transferType: 'p2p' };
  }
  return { isTransfer: true, transferType: 'internal' };
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
function autoCreateAccount(userId: string, statementMeta: any): string {
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
  const balance = statementMeta.endingBalance || 0;

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
    existing = db.prepare(
      `SELECT id, type FROM accounts WHERE user_id = ? AND institution LIKE ? AND last_four = ?`
    ).get(userId, `%${institution}%`, lastFour) as any;
  }

  // Same institution + same type
  if (!existing && institution && institution !== 'Unknown') {
    existing = db.prepare(
      `SELECT id, type FROM accounts WHERE user_id = ? AND institution LIKE ? AND type = ?`
    ).get(userId, `%${institution}%`, accountType) as any;
  }

  // Exact name match
  if (!existing) {
    existing = db.prepare(
      `SELECT id, type FROM accounts WHERE user_id = ? AND name = ?`
    ).get(userId, accountName) as any;
  }

  if (existing) {
    // If existing account has wrong type (e.g., was defaulted to 'checking' but should be 'credit'),
    // update it to the correct type if we have higher confidence now
    if (existing.type !== accountType && accountType !== 'checking') {
      const icon = accountType === 'credit' ? '💳' : accountType === 'savings' ? '💰' : accountType === 'investment' ? '📊' : '🏦';
      db.prepare(
        `UPDATE accounts SET type = ?, icon = ?, institution = COALESCE(NULLIF(?, 'Unknown'), institution), last_four = COALESCE(NULLIF(?, ''), last_four), updated_at = ? WHERE id = ?`
      ).run(accountType, icon, institution, lastFour, now, existing.id);
      console.log(`Updated account ${existing.id} type from ${existing.type} to ${accountType}`);
    }
    return existing.id;
  }

  // Create new account (marked as 'upload' source so it's protected from re-seeding)
  const icon = accountType === 'credit' ? '💳' : accountType === 'savings' ? '💰' : accountType === 'investment' ? '📊' : '🏦';
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'upload', ?, ?)`
  ).run(id, userId, accountName, accountType, institution, balance, lastFour || null, icon, now, now);

  console.log(`Auto-created account: ${accountName} (${accountType}) at ${institution} for user ${userId}`);
  return id;
}

// Ensure user has default categories
function ensureDefaultCategories(userId: string): void {
  const existingCount = (db.prepare('SELECT COUNT(*) as count FROM categories WHERE user_id = ?').get(userId) as any).count;
  if (existingCount > 0) return;

  const defaults = [
    { name: 'Housing', icon: '🏠', color: '#6366F1', isIncome: false },
    { name: 'Groceries', icon: '🛒', color: '#22C55E', isIncome: false },
    { name: 'Food & Dining', icon: '🍔', color: '#F59E0B', isIncome: false },
    { name: 'Transportation', icon: '🚗', color: '#3B82F6', isIncome: false },
    { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', isIncome: false },
    { name: 'Utilities', icon: '💡', color: '#14B8A6', isIncome: false },
    { name: 'Healthcare', icon: '🏥', color: '#EF4444', isIncome: false },
    { name: 'Entertainment', icon: '🎬', color: '#EC4899', isIncome: false },
    { name: 'Subscriptions', icon: '📱', color: '#F97316', isIncome: false },
    { name: 'Insurance', icon: '🛡️', color: '#06B6D4', isIncome: false },
    { name: 'Health & Fitness', icon: '💪', color: '#10B981', isIncome: false },
    { name: 'Personal Care', icon: '💇', color: '#D946EF', isIncome: false },
    { name: 'Education', icon: '📚', color: '#0EA5E9', isIncome: false },
    { name: 'Travel', icon: '✈️', color: '#F472B6', isIncome: false },
    { name: 'Pets', icon: '🐾', color: '#A78BFA', isIncome: false },
    { name: 'Gifts & Donations', icon: '🎁', color: '#FB923C', isIncome: false },
    { name: 'Investments', icon: '📊', color: '#818CF8', isIncome: false },
    { name: 'Salary', icon: '💵', color: '#10B981', isIncome: true },
    { name: 'Freelance', icon: '💼', color: '#22D3EE', isIncome: true },
    { name: 'Other Income', icon: '💰', color: '#34D399', isIncome: true },
    { name: 'Transfer', icon: '🔄', color: '#94A3B8', isIncome: false },
    { name: 'Uncategorized', icon: '❓', color: '#64748B', isIncome: false },
  ];

  const insert = db.prepare(
    `INSERT INTO categories (id, user_id, name, icon, color, is_income, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  defaults.forEach((cat, idx) => {
    insert.run(crypto.randomUUID(), userId, cat.name, cat.icon, cat.color, cat.isIncome ? 1 : 0, idx);
  });

  console.log(`Created ${defaults.length} default categories for user ${userId}`);
}

// POST / - upload files, parse, detect duplicates, auto-create accounts
router.post('/', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Ensure user has default categories
    ensureDefaultCategories(userId);

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    // Create upload session
    db.prepare(
      `INSERT INTO upload_sessions (id, user_id, status, file_count, created_at)
       VALUES (?, ?, 'processing', ?, ?)`
    ).run(sessionId, userId, files.length, now);

    let allPendingItems: PendingItemData[] = [];
    const fileResults: any[] = [];

    // Parse each file
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      const fileType = ext === 'xls' ? 'xlsx' : ext;

      // Insert file record
      db.prepare(
        `INSERT INTO uploaded_files (id, session_id, user_id, filename, file_type, file_size, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'parsing', ?)`
      ).run(fileId, sessionId, userId, file.originalname, fileType, file.size, now);

      try {
        // Parse the file
        const result = await parseFile(file.buffer, file.originalname);

        // Auto-create account from statement metadata if needed
        let autoAccountId: string | null = null;
        if (result.statementMeta) {
          autoAccountId = autoCreateAccount(userId, result.statementMeta);
        }

        // If user has no accounts at all, create a default checking account
        if (!autoAccountId) {
          const accountCount = (db.prepare('SELECT COUNT(*) as count FROM accounts WHERE user_id = ?').get(userId) as any).count;
          if (accountCount === 0) {
            const defaultAcctId = crypto.randomUUID();
            db.prepare(
              `INSERT INTO accounts (id, user_id, name, type, institution, balance, icon, is_hidden, created_at, updated_at)
               VALUES (?, ?, 'Main Account', 'checking', 'My Bank', 0, '🏦', 0, ?, ?)`
            ).run(defaultAcctId, userId, now, now);
            autoAccountId = defaultAcctId;
          }
        }

        // Update file record
        db.prepare(
          `UPDATE uploaded_files SET row_count = ?, status = 'parsed' WHERE id = ?`
        ).run(result.rowCount, fileId);

        // Create pending items from parsed rows
        const insertPending = db.prepare(
          `INSERT INTO pending_items (id, session_id, file_id, user_id, item_type, raw_data, parsed_name, parsed_amount, parsed_date, parsed_category, matched_category_id, matched_account_id, status, confidence, created_at)
           VALUES (?, ?, ?, ?, 'transaction', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        );

        const filePendingItems: PendingItemData[] = [];

        for (const row of result.rows) {
          const itemId = crypto.randomUUID();

          // Auto-categorize
          const catResult = categorizeItem(row.name, row.amount, userId);

          // Detect transfer type
          const transferInfo = detectTransferType(row.name, row.amount);

          // If it's a transfer, try to assign the Transfer category
          let finalCategoryId = catResult.categoryId;
          let finalCategoryName = catResult.categoryName;
          if (transferInfo.isTransfer || row.isTransfer) {
            const transferCat = db.prepare(
              `SELECT id, name FROM categories WHERE user_id = ? AND LOWER(name) = 'transfer'`
            ).get(userId) as any;
            if (transferCat) {
              finalCategoryId = transferCat.id;
              finalCategoryName = transferCat.name;
            }
          }

          // Classify income type
          const incomeType = classifyIncomeType(row.name, row.amount);

          insertPending.run(
            itemId, sessionId, fileId, userId,
            JSON.stringify({ ...row.rawData, incomeType, transferType: transferInfo.transferType || row.transferType || null }),
            row.name,
            row.amount,
            row.date,
            row.category || finalCategoryName || null,
            finalCategoryId,
            autoAccountId,
            catResult.confidence,
            now
          );

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
          statementMeta: result.statementMeta,
          autoAccountId,
        });
      } catch (parseError: any) {
        db.prepare(
          `UPDATE uploaded_files SET status = 'error', error_message = ? WHERE id = ?`
        ).run(parseError.message, fileId);

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
    const dbDuplicates = findDuplicates(allPendingItems, userId);

    // Detect cross-file overlaps
    const crossDuplicates = findCrossFileOverlaps(allPendingItems);

    // Mark duplicate items in DB
    const allDuplicateMatches = [...dbDuplicates, ...crossDuplicates];
    let duplicateCount = 0;

    for (const dup of allDuplicateMatches) {
      if (dup.score >= 70) {
        db.prepare(
          `UPDATE pending_items SET status = 'duplicate', duplicate_of = ?, confidence = ? WHERE id = ?`
        ).run(dup.matchedTransactionId, dup.score / 100, dup.itemId);
        duplicateCount++;
      }
    }

    // Generate clarifications for uncategorized items
    const uncategorized = allPendingItems.filter(item => !item.matched_category_id);
    for (const item of uncategorized.slice(0, 20)) {
      db.prepare(
        `INSERT INTO clarifications (id, user_id, source, item_type, title, description, context, status, created_at)
         VALUES (?, ?, 'upload', 'category', ?, ?, ?, 'pending', ?)`
      ).run(
        crypto.randomUUID(),
        userId,
        `Categorize: ${item.parsed_name}`,
        `We couldn't auto-categorize "${item.parsed_name}" ($${Math.abs(item.parsed_amount).toFixed(2)}). Please select a category.`,
        JSON.stringify({ itemId: item.id, name: item.parsed_name, amount: item.parsed_amount, date: item.parsed_date }),
        now
      );
    }

    // Update session totals
    const totalItems = allPendingItems.length;
    db.prepare(
      `UPDATE upload_sessions SET status = 'review', total_items = ?, duplicate_items = ? WHERE id = ?`
    ).run(totalItems, duplicateCount, sessionId);

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
      uncategorizedItems: uncategorized.length,
      duplicates: allDuplicateMatches.filter(d => d.score >= 50),
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// GET /sessions - list upload sessions
router.get('/sessions', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessions = db
      .prepare(
        `SELECT * FROM upload_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
      )
      .all(userId) as any[];

    const getFiles = db.prepare('SELECT * FROM uploaded_files WHERE session_id = ?');
    const enriched = sessions.map(s => ({
      ...s,
      files: getFiles.all(s.id),
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /sessions/:id - get session with pending items
router.get('/sessions/:id', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const session = db
      .prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as any;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const files = db
      .prepare('SELECT * FROM uploaded_files WHERE session_id = ?')
      .all(id);

    const items = db
      .prepare(
        `SELECT pi.*, c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM pending_items pi
         LEFT JOIN categories c ON pi.matched_category_id = c.id
         WHERE pi.session_id = ?
         ORDER BY pi.parsed_date DESC, pi.parsed_name ASC`
      )
      .all(id)
      .map((item: any) => ({
        ...item,
        raw_data: JSON.parse(item.raw_data || '{}'),
      }));

    res.json({ ...session, files, items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// PUT /items/:id - approve/skip/edit a pending item
router.put('/items/:id', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { status, parsed_name, parsed_amount, parsed_date, matched_category_id, matched_account_id } = req.body;

    const existing = db
      .prepare('SELECT * FROM pending_items WHERE id = ? AND user_id = ?')
      .get(id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Item not found' });
    }

    db.prepare(
      `UPDATE pending_items SET
        status = COALESCE(?, status),
        parsed_name = COALESCE(?, parsed_name),
        parsed_amount = COALESCE(?, parsed_amount),
        parsed_date = COALESCE(?, parsed_date),
        matched_category_id = COALESCE(?, matched_category_id),
        matched_account_id = COALESCE(?, matched_account_id)
       WHERE id = ?`
    ).run(status, parsed_name, parsed_amount, parsed_date, matched_category_id, matched_account_id, id);

    // If user categorized an item, learn the rule
    if (matched_category_id && existing.parsed_name) {
      try {
        learnRuleFromCategorizer(userId, existing.parsed_name.toLowerCase(), matched_category_id, 'contains');
      } catch (e) { /* ignore */ }
    }

    res.json({ message: 'Item updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// PUT /items/bulk-update - update multiple items at once
router.put('/items/bulk-update', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { itemIds, updates } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required' });
    }

    const updateStmt = db.prepare(
      `UPDATE pending_items SET
        status = COALESCE(?, status),
        matched_category_id = COALESCE(?, matched_category_id),
        matched_account_id = COALESCE(?, matched_account_id)
       WHERE id = ? AND user_id = ?`
    );

    const bulkUpdate = db.transaction((ids: string[]) => {
      let updated = 0;
      for (const id of ids) {
        const result = updateStmt.run(
          updates.status || null,
          updates.matched_category_id || null,
          updates.matched_account_id || null,
          id, userId
        );
        updated += result.changes;
      }
      return updated;
    });

    const updated = bulkUpdate(itemIds);
    res.json({ message: `${updated} items updated`, updated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to bulk update items' });
  }
});

// POST /sessions/:id/import - import approved/pending items as transactions
router.post('/sessions/:id/import', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { importAll } = req.body;

    const session = db
      .prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as any;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Import items based on mode:
    // - importAll: import all non-skipped, non-imported items (pending, approved, duplicate)
    // - default (Import Approved): import approved items AND pending items that have a category assigned
    let items: any[];
    if (importAll) {
      items = db
        .prepare(
          `SELECT * FROM pending_items WHERE session_id = ? AND user_id = ? AND status NOT IN ('skipped', 'imported')`
        )
        .all(id, userId) as any[];
    } else {
      items = db
        .prepare(
          `SELECT * FROM pending_items WHERE session_id = ? AND user_id = ? AND (status = 'approved' OR (status = 'pending' AND matched_category_id IS NOT NULL AND matched_category_id != ''))`
        )
        .all(id, userId) as any[];
    }

    if (items.length === 0) {
      return res.json({ message: 'No items to import', imported: 0 });
    }

    // Get or create default account
    let defaultAccount = db
      .prepare("SELECT id FROM accounts WHERE user_id = ? ORDER BY CASE WHEN type = 'checking' THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
      .get(userId) as any;

    if (!defaultAccount) {
      // Auto-create a default account
      const accId = crypto.randomUUID();
      const now2 = new Date().toISOString();
      db.prepare(
        `INSERT INTO accounts (id, user_id, name, type, institution, balance, icon, is_hidden, source, created_at, updated_at)
         VALUES (?, ?, 'Main Account', 'checking', 'My Bank', 0, '🏦', 0, 'upload', ?, ?)`
      ).run(accId, userId, now2, now2);
      defaultAccount = { id: accId };
    }

    const now = new Date().toISOString();
    let importedCount = 0;

    const importTransaction = db.transaction(() => {
      const insertTx = db.prepare(
        `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, tags, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', 'upload', ?, ?)`
      );

      const updateItem = db.prepare(
        `UPDATE pending_items SET status = 'imported' WHERE id = ?`
      );

      for (const item of items) {
        const accountId = item.matched_account_id || defaultAccount.id;
        const txId = crypto.randomUUID();

        insertTx.run(
          txId, userId, accountId,
          item.parsed_name,
          item.parsed_amount,
          item.matched_category_id || null,
          item.parsed_date,
          `Imported from upload session`,
          now, now
        );

        updateItem.run(item.id);

        // Update account balance
        db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?')
          .run(item.parsed_amount, now, accountId);

        importedCount++;
      }
    });

    importTransaction();

    // Update session
    db.prepare(
      `UPDATE upload_sessions SET status = 'completed', imported_items = ?, completed_at = ? WHERE id = ?`
    ).run(importedCount, now, id);

    res.json({
      message: `Successfully imported ${importedCount} transactions`,
      imported: importedCount,
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import transactions' });
  }
});

// DELETE /sessions/:id - delete an upload session
router.delete('/sessions/:id', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    db.prepare('DELETE FROM pending_items WHERE session_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM uploaded_files WHERE session_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM upload_sessions WHERE id = ? AND user_id = ?').run(id, userId);

    res.json({ message: 'Session deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

export default router;
