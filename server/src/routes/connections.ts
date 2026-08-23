/**
 * /api/connections — bank-connection lifecycle (design doc 03-aggregation.md §4, §7).
 *
 * Two routers are exported:
 *
 *   default (connectionsRouter) — mount under /api/connections. It applies
 *     authMiddleware itself (defense in depth), and index.ts should ALSO mount
 *     it behind authMiddleware like every other route. Every query is scoped
 *     by req.user!.id, and every `:id` from a URL is proven to belong to the
 *     caller before any action — no cross-user access via guessed ids.
 *
 *   webhookRouter — mount at /api/connections/webhook BEFORE the global
 *     express.json(), because signature verification needs the RAW request
 *     body (the router wires express.raw for its own path). It is
 *     unauthenticated BY DESIGN, and therefore does signature-verify-first:
 *     an unverified payload gets a 401 and causes zero side effects.
 *
 * TOKEN RULES (vault.ts): no response ever contains token material. Reads of
 * provider_connections use explicit column lists; the vault columns are only
 * read where openToken/unlink needs them, and never serialized.
 */
import express, { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { audit } from '../security/audit.js';
import { getProviderAdapter, parseProviderName } from '../providers/registry.js';
import { openToken, sealToken, type SealedToken } from '../providers/vault.js';
import { reconcileProviderAccounts, syncConnection } from '../providers/sync.js';
import type { ProviderAdapter } from '../providers/types.js';

const router = Router();
router.use(authMiddleware);

// Explicit, token-free column list for any connection read that reaches a client.
const SAFE_CONNECTION_COLUMNS =
  'id, user_id, provider, provider_item_id, institution_id, institution_name, ' +
  'status, status_detail, consent_expires_at, last_synced_at, created_at, updated_at';

function resolveAdapter(res: Response, provider: unknown): ProviderAdapter | null {
  try {
    return getProviderAdapter(db, typeof provider === 'string' ? provider : undefined);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}

/** Prove the connection belongs to the caller before acting on it. */
async function ownConnection(req: Request, id: string): Promise<any | undefined> {
  return await db.get(
    `SELECT ${SAFE_CONNECTION_COLUMNS} FROM provider_connections
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id, req.user!.id,
  );
}

// ---------------------------------------------------------------------------
// POST /link-init — start a link flow. Returns widget/link config, never a token.
// ---------------------------------------------------------------------------
router.post('/link-init', async (req: Request, res: Response) => {
  try {
    const adapter = resolveAdapter(res, req.body?.provider);
    if (!adapter) return;

    const products = Array.isArray(req.body?.products)
      ? req.body.products.filter((p: unknown) => p === 'transactions' || p === 'liabilities' || p === 'investments')
      : undefined;

    const result = await adapter.linkInit({
      userId: req.user!.id,
      products,
      historyDays: typeof req.body?.historyDays === 'number' ? req.body.historyDays : undefined,
      redirectUri: typeof req.body?.redirectUri === 'string' ? req.body.redirectUri : undefined,
    });
    res.json({
      provider: adapter.name,
      mode: result.mode,
      linkToken: result.linkToken,
      widgetConfig: result.widgetConfig,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error('Link init error:', (error as Error).message);
    res.status(500).json({ error: 'Failed to initialize link' });
  }
});

// ---------------------------------------------------------------------------
// POST /exchange — finish the link: exchange, vault the token, create the
// connection + provider_accounts, kick the initial sync. Audits provider.link.
// ---------------------------------------------------------------------------
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const adapter = resolveAdapter(res, req.body?.provider);
    if (!adapter) return;

    const existingConnectionId =
      typeof req.body?.existingConnectionId === 'string' ? req.body.existingConnectionId : undefined;
    if (existingConnectionId) {
      const owned = await ownConnection(req, existingConnectionId);
      if (!owned) {
        res.status(404).json({ error: 'Connection not found' });
        return;
      }
    }

    const exchanged = await adapter.exchangePublicToken({
      userId,
      publicToken: typeof req.body?.publicToken === 'string' ? req.body.publicToken : undefined,
      accessToken: typeof req.body?.accessToken === 'string' ? req.body.accessToken : undefined,
      setupToken: typeof req.body?.setupToken === 'string' ? req.body.setupToken : undefined,
      enrollmentId: typeof req.body?.enrollmentId === 'string' ? req.body.enrollmentId : undefined,
      institutionHint: req.body?.institutionHint,
      existingConnectionId,
    });

    const now = new Date().toISOString();
    let connectionId: string;
    let created = false;

    if (existingConnectionId) {
      // Re-auth: complete against the existing (ownership-verified) row.
      connectionId = existingConnectionId;
      const sealed = sealToken(connectionId, exchanged.accessToken);
      await db.run(
        `UPDATE provider_connections
            SET provider_item_id = ?, institution_id = ?, institution_name = ?,
                status = 'active', status_detail = '{}',
                token_ciphertext = ?, token_iv = ?, token_tag = ?,
                dek_wrapped = ?, dek_iv = ?, dek_tag = ?, kek_version = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
        exchanged.providerItemId, exchanged.institution.id ?? null, exchanged.institution.name,
        ...sealedParams(sealed), now, connectionId, userId,
      );
    } else {
      const existing = await db.get<{ id: string }>(
        `SELECT id FROM provider_connections
          WHERE user_id = ? AND provider = ? AND provider_item_id = ?`,
        userId, adapter.name, exchanged.providerItemId,
      );
      if (existing) {
        // Re-link of the same provider item: refresh the token in place.
        connectionId = existing.id;
        const sealed = sealToken(connectionId, exchanged.accessToken);
        await db.run(
          `UPDATE provider_connections
              SET institution_id = ?, institution_name = ?, status = 'active', status_detail = '{}',
                  token_ciphertext = ?, token_iv = ?, token_tag = ?,
                  dek_wrapped = ?, dek_iv = ?, dek_tag = ?, kek_version = ?,
                  deleted_at = NULL, updated_at = ?
            WHERE id = ? AND user_id = ?`,
          exchanged.institution.id ?? null, exchanged.institution.name,
          ...sealedParams(sealed), now, connectionId, userId,
        );
      } else {
        connectionId = randomUUID();
        created = true;
        const sealed = sealToken(connectionId, exchanged.accessToken);
        await db.run(
          `INSERT INTO provider_connections
             (id, user_id, provider, provider_item_id, institution_id, institution_name,
              status, status_detail, token_ciphertext, token_iv, token_tag,
              dek_wrapped, dek_iv, dek_tag, kek_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          connectionId, userId, adapter.name, exchanged.providerItemId,
          exchanged.institution.id ?? null, exchanged.institution.name,
          ...sealedParams(sealed), now, now,
        );
      }
    }

    // Discover accounts now so the client can render them immediately.
    const providerAccounts = await adapter.listAccounts(exchanged.accessToken);
    await reconcileProviderAccounts(
      db,
      { id: connectionId, user_id: userId, provider: adapter.name, institution_name: exchanged.institution.name },
      providerAccounts,
    );

    await audit('provider.link', req, {
      targetId: connectionId,
      detail: { provider: adapter.name, institution: exchanged.institution.name, accounts: providerAccounts.length },
    });

    // Initial sync in the background; failures land in sync_runs, not here.
    syncConnection(connectionId, { trigger: 'link' }).catch(() => { /* recorded in sync_runs */ });

    res.status(created ? 201 : 200).json({
      connection: {
        id: connectionId,
        provider: adapter.name,
        institution_name: exchanged.institution.name,
        status: 'active',
      },
      accounts: providerAccounts.map((a) => ({
        providerAccountId: a.providerAccountId,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        currency: a.currency,
        currentBalance: a.currentBalance,
      })),
    });
  } catch (error) {
    console.error('Exchange error:', (error as Error).message);
    res.status(502).json({ error: 'Failed to complete the connection' });
  }
});

// ---------------------------------------------------------------------------
// GET / — the caller's connections: health, institution, last sync, account count.
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db.all(
      `SELECT c.id, c.provider, c.institution_id, c.institution_name, c.status, c.status_detail,
              c.consent_expires_at, c.last_synced_at, c.created_at,
              (SELECT COUNT(*) FROM provider_accounts pa WHERE pa.connection_id = c.id) AS account_count,
              ist.health AS institution_health
         FROM provider_connections c
         LEFT JOIN institution_status ist
           ON ist.provider = c.provider
          AND ist.institution_id = COALESCE(c.institution_id, c.institution_name)
        WHERE c.user_id = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC`,
      req.user!.id,
    );
    res.json({
      connections: rows.map((r: any) => ({
        ...r,
        status_detail: parseJsonSafe(r.status_detail),
        institution_health: r.institution_health ?? 'healthy',
      })),
    });
  } catch (error) {
    console.error('List connections error:', (error as Error).message);
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/sync — manual sync trigger.
// ---------------------------------------------------------------------------
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const conn = await ownConnection(req, String(req.params.id));
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const result = await syncConnection(conn.id, { trigger: 'manual' });
    res.status(result.status === 'failed' ? 502 : 200).json({
      runId: result.runId,
      status: result.status,
      connectionStatus: result.connectionStatus,
      added: result.added,
      modified: result.modified,
      removed: result.removed,
      error: result.error,   // sanitized by the engine; never token material
    });
  } catch (error) {
    console.error('Manual sync error:', (error as Error).message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/reauth — fresh link token for an existing connection (update mode).
// ---------------------------------------------------------------------------
router.post('/:id/reauth', async (req: Request, res: Response) => {
  try {
    const conn = await ownConnection(req, String(req.params.id));
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const adapter = resolveAdapter(res, conn.provider);
    if (!adapter) return;
    const result = await adapter.linkInit({ userId: req.user!.id, existingConnectionId: conn.id });
    res.json({
      provider: adapter.name,
      connectionId: conn.id,
      mode: result.mode,
      linkToken: result.linkToken,
      widgetConfig: result.widgetConfig,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error('Reauth init error:', (error as Error).message);
    res.status(500).json({ error: 'Failed to start re-authentication' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — revoke provider-side, null the vault fields, mark disconnected.
// The user's transactions are NOT deleted; history retention is their choice.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const conn = await db.get<any>(
      `SELECT id, user_id, provider, institution_name,
              token_ciphertext, token_iv, token_tag, dek_wrapped, dek_iv, dek_tag, kek_version
         FROM provider_connections
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      String(req.params.id), userId,
    );
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    // Best-effort provider-side revoke; the local disconnect happens regardless.
    let revoked = false;
    if (conn.token_ciphertext) {
      try {
        const adapter = getProviderAdapter(db, conn.provider);
        const token = openToken(conn.id, sealedFromDeleteRow(conn));
        await adapter.unlink(token);
        revoked = true;
      } catch (err) {
        console.error('Provider unlink failed (continuing local disconnect):', (err as Error).name);
      }
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE provider_connections
          SET status = 'disconnected',
              status_detail = ?,
              token_ciphertext = NULL, token_iv = NULL, token_tag = NULL,
              dek_wrapped = NULL, dek_iv = NULL, dek_tag = NULL,
              updated_at = ?
        WHERE id = ? AND user_id = ?`,
      JSON.stringify({ reason: 'user_disconnected', provider_revoked: revoked, since: now }),
      now, conn.id, userId,
    );

    await audit('provider.unlink', req, {
      targetId: conn.id,
      detail: { provider: conn.provider, institution: conn.institution_name, provider_revoked: revoked },
    });

    res.json({ message: 'Connection disconnected. Your transaction history was kept.' });
  } catch (error) {
    console.error('Disconnect error:', (error as Error).message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ---------------------------------------------------------------------------
// Webhook router — POST /api/connections/webhook/:provider
// Unauthenticated BY DESIGN; signature-verify-first via adapter.handleWebhook,
// then idempotent on webhook_events.body_sha256. Needs the RAW body: mount
// this router BEFORE the global express.json().
// ---------------------------------------------------------------------------
export const webhookRouter = Router();

webhookRouter.post(
  '/:provider',
  express.raw({ type: () => true, limit: '1mb' }),
  async (req: Request, res: Response) => {
    try {
      let adapter: ProviderAdapter;
      try {
        adapter = getProviderAdapter(db, parseProviderName(String(req.params.provider)));
      } catch {
        res.status(404).json({ error: 'Unknown provider' });
        return;
      }
      if (!adapter.handleWebhook) {
        res.status(404).json({ error: 'Provider does not support webhooks' });
        return;
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '', 'utf8');

      // 1. Verify FIRST. Unverified -> 401, zero side effects.
      const verdict = await adapter.handleWebhook(
        req.headers as Record<string, string>, rawBody,
      );
      if (!verdict.verified) {
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }

      // 2. Resolve the connection from the signature-verified item reference.
      let connection: { id: string } | undefined;
      if (verdict.connectionRef?.providerItemId) {
        connection = await db.get<{ id: string }>(
          `SELECT id FROM provider_connections
            WHERE provider = ? AND provider_item_id = ? AND deleted_at IS NULL`,
          adapter.name, verdict.connectionRef.providerItemId,
        );
      }

      // 3. Idempotency: one row per (provider, body hash). A replay is a no-op.
      const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
      const inserted = await db.run(
        `INSERT OR IGNORE INTO webhook_events
           (id, provider, event_id, body_sha256, action, connection_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), adapter.name, verdict.eventId ?? null, bodySha256,
        verdict.action, connection?.id ?? null, new Date().toISOString(),
      );
      if (inserted.changes === 0) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }

      // 4. Act. Sync work runs off-request; the provider gets its 200 fast.
      const now = new Date().toISOString();
      switch (verdict.action) {
        case 'sync_transactions':
        case 'sync_liabilities':
        case 'sync_investments':
          if (connection) syncConnection(connection.id, { trigger: 'webhook' }).catch(() => { /* recorded in sync_runs */ });
          break;
        case 'mark_reauth':
          if (connection) {
            await db.run(
              `UPDATE provider_connections SET status = 'reauth_required', status_detail = ?, updated_at = ? WHERE id = ?`,
              JSON.stringify({ reason: 'webhook', since: now }), now, connection.id,
            );
          }
          break;
        case 'mark_disconnected':
          if (connection) {
            await db.run(
              `UPDATE provider_connections
                  SET status = 'disconnected', status_detail = ?,
                      token_ciphertext = NULL, token_iv = NULL, token_tag = NULL,
                      dek_wrapped = NULL, dek_iv = NULL, dek_tag = NULL, updated_at = ?
                WHERE id = ?`,
              JSON.stringify({ reason: 'provider_disconnected', since: now }), now, connection.id,
            );
          }
          break;
        case 'consent_expiring':
          if (connection) {
            await db.run(
              `UPDATE provider_connections SET status = 'consent_expiring', status_detail = ?, updated_at = ? WHERE id = ?`,
              JSON.stringify({ reason: 'webhook', since: now, ...verdict.detail }), now, connection.id,
            );
          }
          break;
        case 'ignore':
          break;
      }

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Webhook error:', (error as Error).message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ordered params for the 7 sealed-token placeholders in the queries above. */
function sealedParams(s: SealedToken): [string, string, string, string, string, string, number] {
  return [s.tokenCiphertext, s.tokenIv, s.tokenTag, s.dekWrapped, s.dekIv, s.dekTag, s.kekVersion];
}

function sealedFromDeleteRow(conn: any): SealedToken {
  return {
    tokenCiphertext: conn.token_ciphertext,
    tokenIv: conn.token_iv,
    tokenTag: conn.token_tag,
    dekWrapped: conn.dek_wrapped,
    dekIv: conn.dek_iv,
    dekTag: conn.dek_tag,
    kekVersion: conn.kek_version,
  };
}

function parseJsonSafe(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return {};
  try { return JSON.parse(v); } catch { return {}; }
}

export default router;
