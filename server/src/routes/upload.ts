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
  limits: { fileSize: 20 * 1024 * 1024, files: 10 }, // 20MB per file, max 10
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

// POST / - upload files, parse, detect duplicates
router.post('/', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

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

        // Update file record
        db.prepare(
          `UPDATE uploaded_files SET row_count = ?, status = 'parsed' WHERE id = ?`
        ).run(result.rowCount, fileId);

        // Create pending items from parsed rows
        const insertPending = db.prepare(
          `INSERT INTO pending_items (id, session_id, file_id, user_id, item_type, raw_data, parsed_name, parsed_amount, parsed_date, parsed_category, matched_category_id, status, confidence, created_at)
           VALUES (?, ?, ?, ?, 'transaction', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        );

        const filePendingItems: PendingItemData[] = [];

        for (const row of result.rows) {
          const itemId = crypto.randomUUID();

          // Auto-categorize
          const catResult = categorizeItem(row.name, row.amount, userId);

          insertPending.run(
            itemId, sessionId, fileId, userId,
            JSON.stringify(row.rawData),
            row.name,
            row.amount,
            row.date,
            row.category || catResult.categoryName || null,
            catResult.categoryId,
            catResult.confidence,
            now
          );

          filePendingItems.push({
            id: itemId,
            parsed_name: row.name,
            parsed_amount: row.amount,
            parsed_date: row.date,
            parsed_category: row.category || catResult.categoryName,
            matched_category_id: catResult.categoryId || undefined,
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
    for (const item of uncategorized.slice(0, 20)) { // Limit to 20 clarifications
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
      sessionId,
      status: 'review',
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
      .all(userId);

    res.json(sessions);
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
      } catch (e) { /* ignore if categorizer not available */ }
    }

    res.json({ message: 'Item updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// POST /sessions/:id/import - import all approved/pending items as transactions
router.post('/sessions/:id/import', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { importAll } = req.body; // if true, import all pending items too

    const session = db
      .prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as any;

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const statusFilter = importAll ? "('pending', 'approved')" : "('approved')";
    const items = db
      .prepare(
        `SELECT * FROM pending_items WHERE session_id = ? AND user_id = ? AND status IN ${statusFilter}`
      )
      .all(id, userId) as any[];

    if (items.length === 0) {
      return res.json({ message: 'No items to import', imported: 0 });
    }

    // Get default account (first checking account, or any account)
    const defaultAccount = db
      .prepare("SELECT id FROM accounts WHERE user_id = ? ORDER BY CASE WHEN type = 'checking' THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
      .get(userId) as any;

    if (!defaultAccount) {
      return res.status(400).json({ error: 'No accounts found. Please create an account first.' });
    }

    const now = new Date().toISOString();
    let importedCount = 0;

    const importTransaction = db.transaction(() => {
      const insertTx = db.prepare(
        `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', ?, ?)`
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
