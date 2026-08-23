/**
 * Provider registry — selects the active ProviderAdapter from env.
 *
 *   PROVIDER=teller | plaid | simplefin | file      (default: teller)
 *
 * Adapters are constructed lazily on first request (no network, no env reads,
 * no key material at import time). `plaid` and `simplefin` are declared in the
 * type system and the schema CHECK constraint, but their adapters ship in a
 * later phase — selecting them today fails loudly instead of half-working.
 *
 * The `file` adapter wraps the EXISTING upload pipeline (upload_sessions /
 * pending_items, see routes/upload.ts) so that file import is a peer provider:
 * the connection UI, sync_runs bookkeeping and the idempotent apply funnel all
 * treat "statements the user uploads" exactly like a live feed. Nothing in the
 * upload route changes; this adapter only READS what that pipeline produced.
 *
 * AUDIT WIRING (required): link/unlink/sync must land in the audit log.
 * `exchangePublicToken` audits 'provider.link' here, where userId is in hand.
 * The routes/sync engine you wire up must call audit('provider.unlink', ...)
 * and audit('provider.sync', ...) — adapters do not know the user for those.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/sql.js';
import { audit } from '../security/audit.js';
import { createTellerAdapter } from './teller.js';
import type {
  ExchangeParams, ExchangeResult, LinkInitParams, LinkInitResult,
  NormalizedTxn, ProviderAccountData, ProviderAdapter, ProviderName, SyncPage,
} from './types.js';

const SELECTABLE = ['teller', 'plaid', 'simplefin', 'file'] as const;
export type SelectableProvider = (typeof SELECTABLE)[number];

export function parseProviderName(value: string | undefined): SelectableProvider {
  const name = (value ?? 'teller').trim().toLowerCase();
  if ((SELECTABLE as readonly string[]).includes(name)) return name as SelectableProvider;
  throw new Error(`Unknown PROVIDER "${name}" — expected one of: ${SELECTABLE.join(', ')}`);
}

const cache = new Map<SelectableProvider, ProviderAdapter>();

/**
 * Resolve the adapter for `name`, or for env PROVIDER when omitted.
 * `db` is the app's async data handle; only the file adapter uses it.
 */
export function getProviderAdapter(db: Sql, name?: string): ProviderAdapter {
  const provider = parseProviderName(name ?? process.env.PROVIDER);
  const cached = cache.get(provider);
  if (cached) return cached;

  let adapter: ProviderAdapter;
  switch (provider) {
    case 'teller':
      adapter = createTellerAdapter();
      break;
    case 'file':
      adapter = createFileAdapter(db);
      break;
    case 'plaid':
    case 'simplefin':
      throw new Error(
        `Provider "${provider}" is planned (see design doc 03-aggregation.md) but its adapter ` +
        `has not shipped yet. Set PROVIDER=teller or PROVIDER=file.`,
      );
  }
  cache.set(provider, adapter);
  return adapter;
}

// ---------------------------------------------------------------------------
// File adapter — the existing upload pipeline exposed as a provider.
// ---------------------------------------------------------------------------

/**
 * The file provider has no secret. Its "access token" is `file:<userId>` so
 * the rest of the machinery (vault a token per connection, pass it to every
 * adapter call) works uniformly; sealing it is harmless and keeps the code
 * path identical across providers.
 */
function fileToken(userId: string): string { return `file:${userId}`; }
function userIdFromFileToken(token: string): string {
  if (!token.startsWith('file:')) throw new Error('file adapter: malformed token');
  return token.slice('file:'.length);
}

/** Map the app's free-form accounts.type values onto the normalized union. */
function normalizeAccountType(t: string | null | undefined): ProviderAccountData['type'] {
  switch ((t ?? '').toLowerCase()) {
    case 'checking': return 'checking';
    case 'savings': return 'savings';
    case 'credit': case 'credit_card': return 'credit';
    case 'loan': case 'mortgage': case 'heloc': return 'loan';
    case 'investment': case 'brokerage': case 'retirement': return 'investment';
    default: return 'other';
  }
}

interface FileCursorState { watermark: string | null }

export function createFileAdapter(db: Sql): ProviderAdapter {
  return {
    name: 'file',
    capabilities: {
      link: 'file',
      webhooks: false,
      cursorSync: false,
      liabilities: false,       // lease/HELOC details enter via the manual-augmentation UI
      investments: false,
      pendingTransactions: false,
      maxHistoryDays: 3650,     // statements can go back as far as the user has files
    },

    async linkInit(_p: LinkInitParams): Promise<LinkInitResult> {
      // Nothing to hand the client: the existing upload UI (POST /api/upload)
      // IS the link flow for this provider.
      return { mode: 'none', widgetConfig: { uploadEndpoint: '/api/upload' } };
    },

    async exchangePublicToken(p: ExchangeParams): Promise<ExchangeResult> {
      const result: ExchangeResult = {
        providerItemId: fileToken(p.userId),
        accessToken: fileToken(p.userId),   // not a secret; see fileToken()
        institution: { name: 'File import' },
      };
      await audit('provider.link', null, {
        userId: p.userId,
        detail: { provider: 'file', institution: result.institution.name },
      });
      return result;
    },

    async listAccounts(token: string): Promise<ProviderAccountData[]> {
      const userId = userIdFromFileToken(token);
      // Accounts the upload pipeline created or fed. `last_four`/`institution`
      // come from engine/accountDetector.ts via routes/upload.ts.
      const rows = await db.all(
        `SELECT id, name, type, institution, balance, last_four
           FROM accounts
          WHERE user_id = ? AND is_hidden = 0`,
        userId,
      ) as Array<{ id: string; name: string; type: string; institution: string | null;
                   balance: number; last_four: string | null }>;
      return rows.map((a) => ({
        providerAccountId: a.id,
        name: a.name,
        mask: a.last_four ?? undefined,
        type: normalizeAccountType(a.type),
        currency: 'USD',
        currentBalance: a.balance,
        raw: { institution: a.institution },
      }));
    },

    /**
     * "Sync" = surface pending_items the user has APPROVED in the review UI
     * (status='approved' or already 'imported') since the watermark, as
     * normalized transactions keyed by the pending_item id. The idempotency
     * index UNIQUE(account_id, provider, provider_txn_id) makes replays
     * harmless, and rows the legacy /import route already inserted (which
     * carry no provider_txn_id) are caught by the existing findDuplicates()
     * pass in the apply funnel — same as any provider/file overlap.
     */
    async syncTransactions(token: string, providerAccountId: string | null,
                           cursor: string | null): Promise<SyncPage> {
      const userId = userIdFromFileToken(token);
      const state: FileCursorState = cursor ? JSON.parse(cursor) : { watermark: null };

      const params: unknown[] = [userId];
      let where = `pi.user_id = ? AND pi.status IN ('approved', 'imported')
                   AND pi.item_type = 'transaction'
                   AND pi.parsed_date IS NOT NULL AND pi.parsed_amount IS NOT NULL`;
      if (state.watermark) { where += ' AND pi.created_at > ?'; params.push(state.watermark); }
      if (providerAccountId) { where += ' AND pi.matched_account_id = ?'; params.push(providerAccountId); }

      const items = await db.all(
        `SELECT pi.id, pi.parsed_name, pi.parsed_amount, pi.parsed_date,
                pi.parsed_category, pi.matched_account_id, pi.created_at
           FROM pending_items pi
          WHERE ${where}
          ORDER BY pi.created_at ASC
          LIMIT 500`,
        ...params,
      ) as Array<{ id: string; parsed_name: string | null; parsed_amount: number;
                   parsed_date: string; parsed_category: string | null;
                   matched_account_id: string | null; created_at: string }>;

      const added: NormalizedTxn[] = items.map((it) => ({
        providerTxnId: it.id,                       // pending_item id is the stable id
        providerAccountId: it.matched_account_id ?? providerAccountId ?? '',
        date: it.parsed_date,
        name: it.parsed_name ?? 'Imported transaction',
        amount: it.parsed_amount,                   // parser already uses negative = outflow
        pending: false,
        category: it.parsed_category ?? undefined,
        raw: { pendingItemId: it.id },
      }));

      const hasMore = items.length === 500;
      const nextWatermark = items.length > 0 ? items[items.length - 1].created_at : state.watermark;
      return {
        added,
        modified: [],
        removed: [],
        nextCursor: JSON.stringify({ watermark: nextWatermark } satisfies FileCursorState),
        hasMore,
      };
    },

    async unlink(_token: string): Promise<void> {
      // Nothing provider-side to revoke; the caller nulls the (non-secret)
      // envelope and audits 'provider.unlink'.
    },
  };
}
