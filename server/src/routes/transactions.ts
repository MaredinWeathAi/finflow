import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { merchantStem, recategorizeAll } from '../engine/categorizer.js';

import {
  ensureFlowClassification,
  reclassifyTransactionFlow,
  reclassifyTransactionsFlow,
  handleTransactionFlowDeleted,
  classifyUserFlows,
  sqlIncome,
  sqlExpenses,
  sqlRefunds,
  sqlTransfers,
} from '../engine/flow.js';

const router = Router();


// GET / - list transactions with filtering, sorting, pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const {
      category,
      account,
      startDate,
      endDate,
      search,
      minAmount,
      maxAmount,
      type,
      isPending,
      sort,
    } = req.query;

    // Build WHERE clause
    const conditions: string[] = ['t.user_id = ?'];
    const params: any[] = [userId];

    if (category) {
      conditions.push('t.category_id = ?');
      params.push(category);
    }

    if (account) {
      conditions.push('t.account_id = ?');
      params.push(account);
    }

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }

    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    if (search) {
      conditions.push('t.name LIKE ?');
      params.push(`%${search}%`);
    }

    if (minAmount !== undefined && minAmount !== '') {
      conditions.push('ABS(t.amount) >= ?');
      params.push(parseFloat(minAmount as string));
    }

    if (maxAmount !== undefined && maxAmount !== '') {
      conditions.push('ABS(t.amount) <= ?');
      params.push(parseFloat(maxAmount as string));
    }

    if (type === 'income') {
      conditions.push(`t.flow_type = 'income'`);
    } else if (type === 'expense') {
      // Refunds belong to the spending view: they net against it, and leaving
      // them out here would make the filtered total gross while the unfiltered
      // one is net.
      conditions.push(`t.flow_type IN ('expense', 'interest_fee', 'refund')`);
    }

    if (isPending !== undefined && isPending !== '') {
      conditions.push('t.is_pending = ?');
      params.push(isPending === 'true' ? 1 : 0);
    }

    const whereClause = conditions.join(' AND ');

    // Build ORDER BY clause
    let orderBy = 't.date DESC, t.created_at DESC';
    switch (sort) {
      case 'date_asc':
        orderBy = 't.date ASC, t.created_at ASC';
        break;
      case 'amount_desc':
        orderBy = 'ABS(t.amount) DESC';
        break;
      case 'amount_asc':
        orderBy = 'ABS(t.amount) ASC';
        break;
      case 'name_asc':
        orderBy = 't.name ASC';
        break;
      case 'date_desc':
      default:
        orderBy = 't.date DESC, t.created_at DESC';
        break;
    }

    // Header totals, over ALL matching rows (not just the current page).
    //
    // The three cards have to reconcile against the list underneath them, so
    // this also returns the two buckets that are deliberately in neither
    // column: refunds (already netted out of totalExpenses) and internal
    // transfers / card + loan payments (money moving between Marcelo's own
    // accounts, which is not earning and not spending). Without those the
    // header looks like it has simply lost ~500 rows.
    const countResult = await db.get(`SELECT COUNT(*) as total,
                ${sqlIncome('t')} as "totalIncome",
                ${sqlExpenses('t')} as "totalExpenses",
                ${sqlRefunds('t')} as "totalRefunds",
                ${sqlTransfers('t')} as "totalTransfers",
                COUNT(CASE WHEN t.flow_type = 'income' THEN 1 END) as "incomeCount",
                COUNT(CASE WHEN t.flow_type IN ('expense', 'interest_fee') THEN 1 END) as "expenseCount",
                COUNT(CASE WHEN t.flow_type = 'refund' THEN 1 END) as "refundCount",
                COUNT(CASE WHEN t.flow_type IN ('transfer', 'debt_payment') THEN 1 END) as "transferCount"
         FROM transactions t WHERE ${whereClause}`, ...params) as any;
    // Postgres returns numeric/bigint aggregates as strings; SQLite returns numbers.
    const num = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
    const int = (v: any) => Number(v) || 0;
    const total = int(countResult.total);
    const totalIncome = num(countResult.totalIncome);
    const totalExpenses = num(countResult.totalExpenses);
    const totalRefunds = num(countResult.totalRefunds);
    const totalTransfers = num(countResult.totalTransfers);
    const incomeCount = int(countResult.incomeCount);
    const expenseCount = int(countResult.expenseCount);
    const refundCount = int(countResult.refundCount);
    const transferCount = int(countResult.transferCount);
    const totalPages = Math.ceil(total / limit);

    // Get paginated results with joined names
    const transactions = (await db.all(`SELECT t.*,
                c.name as category_name, c.icon as category_icon, c.color as category_color,
                a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE ${whereClause}
         -- t.id is appended as a final tiebreaker. Without it the sort is not a
         -- total order: many rows share a date/created_at, and with LIMIT/OFFSET
         -- pagination an engine-defined tie order lets a row appear on two pages
         -- or on none. SQLite and Postgres break ties differently, so this also
         -- makes the two engines agree.
         ORDER BY ${orderBy}, t.id DESC
         LIMIT ? OFFSET ?`, ...params, limit, offset))
      .map((t: any) => ({
        ...t,
        tags: JSON.parse(t.tags || '[]'),
      }));

    res.json({
      transactions, total, page, totalPages,
      totalIncome, totalExpenses,
      totalNet: Math.round((totalIncome - totalExpenses) * 100) / 100,
      totalRefunds, totalTransfers,
      incomeCount, expenseCount, refundCount, transferCount,
    });
  } catch (error) {
    console.error('List transactions error:', error);
    res.status(500).json({ error: 'Failed to list transactions' });
  }
});

// POST / - create transaction
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      account_id,
      name,
      amount,
      category_id,
      date,
      notes,
      is_pending,
      is_recurring,
      recurring_id,
      tags,
    } = req.body;

    if (!account_id || !name || amount === undefined || !date) {
      res.status(400).json({
        error: 'account_id, name, amount, and date are required',
      });
      return;
    }

    // Verify account belongs to user
    const account = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', account_id, req.user!.id);

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.run(`INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, recurring_id, tags, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`, id, req.user!.id, account_id, name, amount, category_id || null, date, notes || null, is_pending ? 1 : 0, is_recurring ? 1 : 0, recurring_id || null, JSON.stringify(tags || []), now, now);

    // Update account balance
    await db.run('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?', amount, now, account_id);

    // Classify the new row's flow (income/expense/transfer/…), matching
    // transfer pairs against existing history.
    await reclassifyTransactionFlow(db, req.user!.id, id);

    const transaction = await db.get(`SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ?`, id) as any;

    transaction.tags = JSON.parse(transaction.tags || '[]');

    res.status(201).json({ transaction });
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// PUT /:id - update transaction
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    const existing = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    const {
      account_id,
      name,
      amount,
      category_id,
      date,
      notes,
      is_pending,
      is_recurring,
      recurring_id,
      tags,
    } = req.body;
    const now = new Date().toISOString();

    // Rebalance the affected accounts.
    //
    // There is exactly one correct rule: back the OLD amount out of the OLD
    // account, then apply the NEW amount to the NEW account. Stating it that
    // way handles all four cases (nothing changed, amount changed, account
    // changed, both changed) with no special-casing.
    //
    // The previous version applied `diff` to the new account and then, when
    // both amount and account changed, subtracted the NEW amount from the NEW
    // account and added the OLD amount to the OLD one — the reverse of correct
    // on both sides. Editing a -$100 on account A to -$50 on account B left A
    // $200 out and B $150 out, permanently, with nothing to correct it later.
    const oldAccountId = existing.account_id;
    const newAccountId = account_id || existing.account_id;
    const oldAmount = existing.amount;
    const newAmount = amount !== undefined ? amount : existing.amount;

    if (oldAccountId === newAccountId) {
      const delta = newAmount - oldAmount;
      if (delta !== 0) {
        await db.run('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?', delta, now, newAccountId);
      }
    } else {
      await db.run('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?', oldAmount, now, oldAccountId);
      await db.run('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?', newAmount, now, newAccountId);
    }

    await db.run(`UPDATE transactions SET
        account_id = COALESCE(?, account_id),
        name = COALESCE(?, name),
        amount = COALESCE(?, amount),
        category_id = COALESCE(?, category_id),
        date = COALESCE(?, date),
        notes = COALESCE(?, notes),
        is_pending = COALESCE(?, is_pending),
        is_recurring = COALESCE(?, is_recurring),
        recurring_id = COALESCE(?, recurring_id),
        tags = COALESCE(?, tags),
        updated_at = ?
       WHERE id = ? AND user_id = ?`, account_id ?? null, name ?? null, amount !== undefined ? amount : null, category_id !== undefined ? category_id : null, date ?? null, notes !== undefined ? notes : null, is_pending !== undefined ? (is_pending ? 1 : 0) : null, is_recurring !== undefined ? (is_recurring ? 1 : 0) : null, recurring_id !== undefined ? recurring_id : null, tags !== undefined ? JSON.stringify(tags) : null, now, id, req.user!.id);

    // Amount/account/name/date/category edits can all change what this row IS.
    await reclassifyTransactionFlow(db, req.user!.id, id);

    // Propagation to matching merchants deliberately does NOT happen here.
    // The UI asks first and then calls POST /recategorize, so applying it on
    // every PUT as well would either double-apply or silently overrule the
    // answer the user just gave.
    const transaction = await db.get(`SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ?`, id) as any;

    transaction.tags = JSON.parse(transaction.tags || '[]');

    res.json({ transaction });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// DELETE /bulk - delete many transactions in one request.
//
// Declared BEFORE `/:id` on purpose. Express matches routes in declaration
// order, so `/:id` would otherwise capture the literal path "bulk" and try to
// delete a transaction whose id is the string "bulk".
//
// Safety properties, in order of importance:
//   1. Always scoped to req.user.id. A caller cannot reach another user's rows
//      whatever they put in the filters.
//   2. Requires an explicit { confirm: true }. Without it an empty filter set
//      would silently mean "every transaction I own", which is exactly the
//      accident this endpoint must not enable.
//   3. Runs inside one transaction, so a failure part-way cannot leave
//      balances reversed for rows that still exist.
//
// Balance reversal is aggregated per account — one UPDATE per affected
// account rather than one per row — which is what makes deleting a few
// thousand rows a handful of writes instead of a few thousand.
router.delete('/bulk', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as {
      confirm?: boolean;
      accountId?: string;
      startDate?: string;
      endDate?: string;
      source?: string;
      ids?: string[];
    };

    if (body.confirm !== true) {
      res.status(400).json({
        error: 'Bulk delete requires an explicit { "confirm": true } in the request body.',
      });
      return;
    }

    const where: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];

    if (body.accountId) {
      where.push('account_id = ?');
      params.push(String(body.accountId));
    }
    if (body.startDate) {
      where.push('date >= ?');
      params.push(String(body.startDate));
    }
    if (body.endDate) {
      where.push('date <= ?');
      params.push(String(body.endDate));
    }
    if (body.source) {
      where.push('source = ?');
      params.push(String(body.source));
    }
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      if (body.ids.length > 5000) {
        res.status(400).json({ error: 'Too many ids in one request. Send at most 5000.' });
        return;
      }
      where.push(`id IN (${body.ids.map(() => '?').join(', ')})`);
      for (const id of body.ids) params.push(String(id));
    }

    const clause = where.join(' AND ');

    // Snapshot first: we need the amounts to reverse balances, and the pair
    // links to re-classify any transfer counterpart that survives the delete.
    const doomed = (await db.all(
      `SELECT id, account_id as "accountId", amount, transfer_pair_id as "transferPairId"
         FROM transactions
        WHERE ${clause}`,
      ...params,
    )) as Array<{ id: string; accountId: string; amount: number; transferPairId: string | null }>;

    if (doomed.length === 0) {
      res.json({ deleted: 0, accountsAdjusted: 0, counterpartsUnpaired: 0 });
      return;
    }

    const doomedIds = new Set(doomed.map((t) => t.id));
    const perAccount = new Map<string, number>();
    const counterparts = new Set<string>();

    for (const t of doomed) {
      const prev = perAccount.get(t.accountId) ?? 0;
      // Round on every step: float money drifts (0.1 + 0.2) and a few thousand
      // additions is more than enough to move the account balance by a cent.
      perAccount.set(t.accountId, Math.round((prev + Number(t.amount)) * 100) / 100);
      // A counterpart that is itself being deleted needs no fixing up.
      if (t.transferPairId && !doomedIds.has(t.transferPairId)) {
        counterparts.add(t.transferPairId);
      }
    }

    const now = new Date().toISOString();

    await db.tx(async (t) => {
      for (const [accountId, delta] of perAccount) {
        await t.run(
          'UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ? AND user_id = ?',
          delta, now, accountId, userId,
        );
      }

      await t.run(`DELETE FROM transactions WHERE ${clause}`, ...params);

      for (const id of counterparts) {
        await t.run(
          'UPDATE transactions SET flow_type = NULL, transfer_pair_id = NULL WHERE id = ? AND user_id = ?',
          id, userId,
        );
      }
    });

    // Re-pair and re-classify only when a surviving row actually lost its
    // partner. Skipping this when nothing was unpaired keeps a routine delete
    // from triggering a full-user reclassification pass.
    if (counterparts.size > 0) {
      await classifyUserFlows(db, userId);
    }

    res.json({
      deleted: doomed.length,
      accountsAdjusted: perAccount.size,
      counterpartsUnpaired: counterparts.size,
    });
  } catch (error) {
    console.error('Bulk delete transactions error:', error);
    res.status(500).json({ error: 'Failed to bulk delete transactions' });
  }
});

// DELETE /:id - delete transaction
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    const existing = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    // Reverse account balance
    const now = new Date().toISOString();
    await db.run('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?', existing.amount, now, existing.account_id);

    await db.run('DELETE FROM transactions WHERE id = ? AND user_id = ?', id, req.user!.id);

    // If the deleted row was one leg of a transfer pair, re-classify the
    // surviving counterpart (it is no longer part of a matched transfer).
    await handleTransactionFlowDeleted(db, req.user!.id, existing.transfer_pair_id || null);

    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// POST /bulk-categorize
router.post('/bulk-categorize', async (req: Request, res: Response) => {
  try {
    const { transactionIds, categoryId } = req.body;

    if (!Array.isArray(transactionIds) || !categoryId) {
      res
        .status(400)
        .json({ error: 'transactionIds (array) and categoryId are required' });
      return;
    }

    // Verify category belongs to user
    const category = await db.get('SELECT id FROM categories WHERE id = ? AND user_id = ?', categoryId, req.user!.id);

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const now = new Date().toISOString();
    const updateSql =
      'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ? AND user_id = ?';

    const updated = await db.tx(async (t) => {
      let updated = 0;
      for (const txId of transactionIds as string[]) {
        const result = await t.run(updateSql, categoryId, now, txId, req.user!.id);
        updated += result.changes;
      }
      return updated;
    });

    // A category change (e.g. to/from Transfer or CC PMT) can change what a
    // transaction IS — re-run the flow classifier for the touched rows.
    await reclassifyTransactionsFlow(db, req.user!.id, transactionIds as string[]);

    res.json({ message: `${updated} transactions updated`, updated });
  } catch (error) {
    console.error('Bulk categorize error:', error);
    res.status(500).json({ error: 'Failed to bulk categorize transactions' });
  }
});

// POST /recategorize-all - re-run categorisation over everything, in place.
//
// The alternative was deleting every transaction and re-importing the
// statements, which is a lot of ceremony to pick up an improved rule — and it
// discards notes, edits and ids along the way. This keeps the rows and just
// re-decides what they are.
router.post('/recategorize-all', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const summary = await recategorizeAll(userId);

    // Categories feed the flow classifier (Transfer, CC PMT, Mortgage and Asset
    // Transfer all change what a row IS), so the whole user is re-classified
    // afterwards.
    //
    // classifyUserFlows only touches rows whose flow_type is NULL — that is what
    // makes it cheap and idempotent on every request. The consequence was that
    // shipping an improvement to the classifier changed nothing for data already
    // in the app: the card-payment ruling, the Interactive Brokers
    // reclassification and the tightened pairing rules would all have sat there
    // inert against 2,414 existing rows. Clearing flow_type first is what makes
    // "Re-categorise All" mean what its name says.
    //
    // transfer_pair_id goes too. A pair is a decision about two rows; leaving
    // the links behind would preserve pairings the new rules would refuse to
    // make, including the false ones that were eating real expenses.
    await db.run(
      `UPDATE transactions SET flow_type = NULL, transfer_pair_id = NULL WHERE user_id = ?`,
      userId,
    );
    const flow = await classifyUserFlows(db, userId);
    res.json({ ...summary, reclassified: flow.rowsClassified });
  } catch (error) {
    console.error('Recategorize-all error:', error);
    res.status(500).json({ error: 'Failed to re-categorize transactions' });
  }
});

// POST /recategorize - change category of a transaction and propagate to all similar ones
router.post('/recategorize', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { transactionId, categoryId, propagate } = req.body;

    if (!transactionId || !categoryId) {
      res.status(400).json({ error: 'transactionId and categoryId are required' });
      return;
    }

    // Get the transaction
    const transaction = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', transactionId, userId) as any;

    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    // Verify category belongs to user
    const category = await db.get('SELECT id, name FROM categories WHERE id = ? AND user_id = ?', categoryId, userId) as any;

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const now = new Date().toISOString();
    let updatedCount = 1;

    // Update the target transaction
    await db.run('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?', categoryId, now, transactionId);

    const touchedIds: string[] = [transactionId];
    let ruleCreated = false;

    // "All the others like this one" has to mean the same MERCHANT, not the
    // same string. This used to match on LOWER(TRIM(name)) = the full
    // descriptor — and two rows from the same shop are never byte-identical,
    // because the bank stamps a date and a reference on each one:
    //
    //   PUBLIX SUPER M 08/24 PURCHASE PALMETTO BAY FL
    //   PUBLIX SUPER M 07/11 PURCHASE PALMETTO BAY FL
    //
    // So the exact-match found nothing, updated the single row, and reported
    // "Updated 1 transaction". Matching on the merchant stem is what makes the
    // feature do what it says.
    const stem = merchantStem(transaction.name);

    if (propagate !== false && stem.length >= 6) {
      const candidates = await db.all(
        `SELECT id, name FROM transactions
          WHERE user_id = ? AND id != ? AND (category_id IS NULL OR category_id != ?)`,
        userId, transactionId, categoryId,
      ) as Array<{ id: string; name: string }>;

      const siblings = candidates.filter((c) => merchantStem(c.name) === stem);

      if (siblings.length > 0) {
        await db.tx(async (t) => {
          for (const s of siblings) {
            await t.run(
              'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
              categoryId, now, s.id, userId,
            );
          }
        });
        updatedCount += siblings.length;
        touchedIds.push(...siblings.map((s) => s.id));
      }

      // The rule is stored against the stem too, and as a literal 'substring'
      // match. Storing the full descriptor meant the rule required that exact
      // date and reference to recur, so it never fired on a future import
      // either — the edit was lost twice over.
      try {
        const existingRule = await db.get(
          `SELECT id, category_id FROM category_rules WHERE user_id = ? AND LOWER(pattern) = ?`,
          userId, stem,
        ) as any;

        if (existingRule) {
          if (existingRule.category_id !== categoryId) {
            await db.run(
              `UPDATE category_rules SET category_id = ?, match_type = 'substring', created_at = ? WHERE id = ?`,
              categoryId, now, existingRule.id,
            );
            ruleCreated = true;
          }
        } else {
          await db.run(
            `INSERT INTO category_rules (id, user_id, pattern, category_id, match_type, created_at)
             VALUES (?, ?, ?, ?, 'substring', ?)`,
            crypto.randomUUID(), userId, stem, categoryId, now,
          );
          ruleCreated = true;
        }
      } catch (e) {
        console.error('Rule creation error:', e);
      }
    }

    // Re-classify every row we touched: a category like Transfer, CC PMT or
    // Mortgage feeds straight into what the flow classifier decides this is.
    await reclassifyTransactionsFlow(db, userId, touchedIds);

    res.json({
      message: `Updated ${updatedCount} transaction${updatedCount !== 1 ? 's' : ''}`,
      updated: updatedCount,
      categoryName: category.name,
      ruleCreated,
      matchedOn: stem.length >= 6 ? stem : null,
    });
  } catch (error) {
    console.error('Recategorize error:', error);
    res.status(500).json({ error: 'Failed to recategorize transactions' });
  }
});

// POST /import-csv - placeholder that accepts CSV text and returns parsed preview
router.post('/import-csv', (req: Request, res: Response) => {
  try {
    const { csvText } = req.body;

    if (!csvText || typeof csvText !== 'string') {
      res.status(400).json({ error: 'csvText (string) is required' });
      return;
    }

    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      return;
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

    const preview = lines.slice(1, 11).map((line) => {
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = values[i] || '';
      });
      return row;
    });

    res.json({
      headers,
      preview,
      totalRows: lines.length - 1,
      message: 'CSV parsed successfully. Review the preview and confirm import.',
    });
  } catch (error) {
    console.error('Import CSV error:', error);
    res.status(500).json({ error: 'Failed to parse CSV' });
  }
});

export default router;
