/**
 * Teller adapter — primary provider (free tier: 100 live connections, US).
 *
 * API surface verified against https://teller.io/docs on 2026-08-23:
 *   - Base URL https://api.teller.io; auth is dual-factor: (1) an mTLS client
 *     certificate issued per Teller application, and (2) the per-enrollment
 *     access token sent as the HTTP Basic username with an empty password.
 *     Teller's docs: "Access tokens are useless without a client certificate
 *     belonging to the application the user consented giving access to."
 *   - GET /accounts, GET /accounts/:id, GET /accounts/:id/balances
 *     (fields: account_id, ledger, available — nullable strings),
 *     GET /accounts/:id/transactions?count&from_id&start_date&end_date.
 *   - DELETE /accounts revokes the application's access to every account in
 *     the enrollment; DELETE /accounts/:id revokes one account. (The design
 *     doc claimed Teller had "no formal item-remove" — the live docs DO list
 *     these endpoints; unlink() uses DELETE /accounts.)
 *   - Transactions: id, account_id, amount (SIGNED STRING), date, description,
 *     status ('posted'|'pending'), type, running_balance (posted only),
 *     details.{processing_status, category, counterparty{name,type}}.
 *     Ids are stable, EXCEPT a pending txn that changes too much on posting is
 *     re-created under a NEW id — dedupe must tolerate this (trailing re-scan
 *     window below + scorePair matching in the sync engine).
 *   - Webhooks: enrollment.disconnected (payload.reason), transactions.processed,
 *     account.number_verification.processed, webhook.test. Header
 *     `Teller-Signature: t=<ts>,v1=<sig>[,v1=<sig2>...]` (multiple v1 during
 *     signing-secret rotation); HMAC-SHA256 over `${t}.${rawBody}` keyed by the
 *     app's signing secret; reject timestamps older than 3 minutes.
 *
 * ASSUMED (not explicit in the docs — flagged rather than invented):
 *   - Transactions are returned newest-first and `from_id` pages BACKWARD in
 *     time (strongly implied by "paginate backward from this transaction id");
 *     the paging loop below is written on that assumption.
 *   - `count`'s default and maximum are undocumented; we always pass count=500.
 *   - Amount sign convention: docs say only "signed". Observed/e sandbox
 *     behavior is negative = money out from the account's perspective, which
 *     matches FinFlow's convention, so amounts pass through unmodified. If a
 *     credit-card feed arrives inverted in practice, flip the sign in
 *     normalizeTellerTxn for type==='credit' accounts.
 *   - Balance sign for credit accounts (is `ledger` the positive amount owed?)
 *     is undocumented; we pass it through and note that ProviderAccountData
 *     expects liabilities positive-owed. Verify on the first real card link.
 *   - The webhook timestamp `t` is assumed to be unix epoch seconds.
 *   - Teller Connect widget config keys (applicationId, environment,
 *     selectAccount) follow Teller's public Connect docs but were not
 *     re-verified today; the widget is client-side and easy to adjust.
 *
 * NO Teller endpoint is called at import time; the mTLS agent and env reads
 * are all lazy. GET /accounts/:id/details (full account/routing numbers) is
 * deliberately NEVER called — FinFlow does not store full account numbers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import {
  type ExchangeParams, type ExchangeResult, type LinkInitParams, type LinkInitResult,
  type NormalizedTxn, type ProviderAccountData, type ProviderAdapter, type SyncPage,
  type WebhookVerdict,
  ProviderHttpError, RateLimitedError, ReauthRequiredError,
} from './types.js';

const TELLER_BASE = 'https://api.teller.io';
const PAGE_SIZE = 500;
const BACKFILL_DAYS = 365;
/** Re-scan trailing window each sweep: pending→posted date shifts and id churn. */
const RESCAN_DAYS = 14;
const WEBHOOK_MAX_AGE_SECONDS = 180;
const RECENT_ID_CAP = 800;

// --- raw Teller shapes (only the fields we consume) ------------------------

interface TellerInstitution { id?: string; name?: string }
interface TellerAccount {
  id: string; enrollment_id: string; name: string; type: string; subtype?: string;
  last_four?: string; currency?: string; status?: string; institution?: TellerInstitution;
}
interface TellerBalance { account_id: string; ledger: string | null; available: string | null }
interface TellerTxn {
  id: string; account_id: string; amount: string; date: string; description: string;
  status: 'posted' | 'pending'; type?: string; running_balance?: string | null;
  details?: { processing_status?: string; category?: string | null;
              counterparty?: { name?: string | null; type?: string | null } };
}

// --- mTLS transport ---------------------------------------------------------

let cachedAgent: https.Agent | null = null;

/**
 * Certificate material: TELLER_CERT_PEM / TELLER_KEY_PEM (inline PEM) or
 * TELLER_CERT_PATH / TELLER_KEY_PATH (files — preferred in production, per the
 * threat model: keep the mTLS key OUT of plain env where possible so a DB+env
 * dump alone cannot use Teller tokens). In Teller's sandbox the cert is
 * optional, so a missing cert only warns there.
 */
function tellerAgent(): https.Agent {
  if (cachedAgent) return cachedAgent;
  const cert = process.env.TELLER_CERT_PEM
    ?? (process.env.TELLER_CERT_PATH ? fs.readFileSync(process.env.TELLER_CERT_PATH, 'utf8') : undefined);
  const key = process.env.TELLER_KEY_PEM
    ?? (process.env.TELLER_KEY_PATH ? fs.readFileSync(process.env.TELLER_KEY_PATH, 'utf8') : undefined);
  if (!cert || !key) {
    if ((process.env.TELLER_ENV ?? 'development') !== 'sandbox') {
      console.warn('[teller] no mTLS client certificate configured (TELLER_CERT_PEM/PATH, TELLER_KEY_PEM/PATH) — API calls will be rejected outside sandbox');
    }
    cachedAgent = new https.Agent({ keepAlive: true });
  } else {
    cachedAgent = new https.Agent({ cert, key, keepAlive: true });
  }
  return cachedAgent;
}

/**
 * Minimal HTTPS client on node:https (global fetch cannot attach a client
 * certificate without an undici dependency). The access token is placed in the
 * Authorization header and nowhere else — never in URLs, never logged.
 */
function tellerRequest<T>(token: string, method: 'GET' | 'DELETE', path: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.request(`${TELLER_BASE}${path}`, {
      method,
      agent: tellerAgent(),
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${token}:`).toString('base64'),
        Accept: 'application/json',
        'User-Agent': 'finflow/1.0',
      },
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        if (status === 429) {
          const retryAfter = Number(res.headers['retry-after']);
          return reject(new RateLimitedError('teller', Number.isFinite(retryAfter) ? retryAfter : undefined));
        }
        if (status === 401) return reject(new ReauthRequiredError('teller'));
        if (status < 200 || status >= 300) {
          // body may echo request context; truncate and never include the token
          return reject(new ProviderHttpError('teller', status, body.replace(/[\r\n]+/g, ' ')));
        }
        if (!body) return resolve(undefined as T);
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new ProviderHttpError('teller', status, 'invalid JSON in response')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('teller request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// --- normalization ----------------------------------------------------------

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function mapAccountType(acct: TellerAccount): ProviderAccountData['type'] {
  const type = (acct.type ?? '').toLowerCase();
  const subtype = (acct.subtype ?? '').toLowerCase();
  if (type === 'credit') return 'credit';
  if (type === 'depository') {
    if (subtype === 'checking') return 'checking';
    if (['savings', 'money_market', 'certificate_of_deposit', 'cd'].includes(subtype)) return 'savings';
    return 'checking';
  }
  return 'other';
}

function normalizeTellerTxn(raw: TellerTxn): NormalizedTxn {
  return {
    providerTxnId: raw.id,
    providerAccountId: raw.account_id,
    date: raw.date,
    postedDate: raw.status === 'posted' ? raw.date : undefined,
    name: raw.description,
    merchantName: raw.details?.counterparty?.name ?? undefined,
    amount: Number(raw.amount),          // signed string; see sign-convention note above
    pending: raw.status === 'pending',
    pendingTxnId: null,                  // Teller has no pending->posted linkage field
    category: raw.details?.category ?? undefined,
    raw,
  };
}

/** Fabricated cursor for this poller (Teller has no server-side cursor). */
interface TellerCursorState {
  watermark: string | null;              // start_date for the next sweep
  recentIds: string[];                   // ids from prior sweeps -> classify as 'modified'
  sweep?: { fromId: string; ids: string[] };  // mid-sweep pagination state
}

// --- adapter ----------------------------------------------------------------

export function createTellerAdapter(): ProviderAdapter {
  return {
    name: 'teller',
    capabilities: {
      link: 'widget',
      webhooks: true,
      cursorSync: false,               // watermark poller; see TellerCursorState
      liabilities: false,              // Teller has no liabilities product (no APR/due date)
      investments: false,              // and no investment holdings product
      pendingTransactions: true,
      maxHistoryDays: BACKFILL_DAYS,
    },

    async linkInit(_p: LinkInitParams): Promise<LinkInitResult> {
      // Teller Connect is configured entirely client-side; there is no
      // server-minted link token. TELLER_APP_ID is public, not a secret.
      return {
        mode: 'widget',
        widgetConfig: {
          applicationId: process.env.TELLER_APP_ID ?? '',
          environment: process.env.TELLER_ENV ?? 'development',
          selectAccount: 'multiple',
        },
      };
    },

    async exchangePublicToken(p: ExchangeParams): Promise<ExchangeResult> {
      // Teller has NO server-side exchange step (unlike Plaid): Connect's
      // onSuccess hands the client the final access token, which the client
      // must POST here over TLS immediately and never persist. We validate it
      // actually works (and learn the institution) before the caller vaults it.
      if (!p.accessToken) throw new ReauthRequiredError('teller', 'exchange called without an accessToken');
      const accounts = await tellerRequest<TellerAccount[]>(p.accessToken, 'GET', '/accounts');
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new ProviderHttpError('teller', 200, 'enrollment has no accounts');
      }
      return {
        providerItemId: p.enrollmentId ?? accounts[0].enrollment_id,
        accessToken: p.accessToken,      // caller vaults immediately; never logged
        institution: {
          id: accounts[0].institution?.id,
          name: accounts[0].institution?.name ?? p.institutionHint?.name ?? 'Unknown',
        },
      };
    },

    async listAccounts(token: string): Promise<ProviderAccountData[]> {
      const accounts = await tellerRequest<TellerAccount[]>(token, 'GET', '/accounts');
      const out: ProviderAccountData[] = [];
      for (const acct of accounts) {
        // Per-account balances call. Free on the developer tier; $0.10/call on
        // paid Balance product — callers should not invoke listAccounts in a loop.
        let balance: TellerBalance | null = null;
        try {
          balance = await tellerRequest<TellerBalance>(token, 'GET', `/accounts/${acct.id}/balances`);
        } catch {
          balance = null;                // balance is optional; account row still useful
        }
        out.push({
          providerAccountId: acct.id,
          name: acct.name,
          mask: acct.last_four,
          type: mapAccountType(acct),
          subtype: acct.subtype,
          currency: acct.currency ?? 'USD',
          currentBalance: balance?.ledger != null ? Number(balance.ledger) : undefined,
          availableBalance: balance?.available != null ? Number(balance.available) : undefined,
          // Teller exposes no credit_limit field on accounts or balances.
          raw: { account: acct, balance },
        });
      }
      return out;
    },

    async syncTransactions(token: string, providerAccountId: string | null,
                           cursor: string | null): Promise<SyncPage> {
      if (!providerAccountId) {
        throw new ProviderHttpError('teller', 0, 'teller syncs per account — providerAccountId is required');
      }
      const state: TellerCursorState = cursor
        ? JSON.parse(cursor)
        : { watermark: null, recentIds: [] };

      const startDate = state.watermark ?? isoDaysAgo(BACKFILL_DAYS);
      const qs = new URLSearchParams({ start_date: startDate, count: String(PAGE_SIZE) });
      if (state.sweep) qs.set('from_id', state.sweep.fromId);

      const page = await tellerRequest<TellerTxn[]>(
        token, 'GET', `/accounts/${encodeURIComponent(providerAccountId)}/transactions?${qs.toString()}`,
      );

      const previouslySeen = new Set(state.recentIds);
      const added: NormalizedTxn[] = [];
      const modified: NormalizedTxn[] = [];
      for (const rawTxn of page) {
        const txn = normalizeTellerTxn(rawTxn);
        // Ids seen in a prior sweep are re-deliveries of the overlap window
        // (pending->posted, description enrichment): classify as modified so
        // the engine upserts. Either way the unique index makes this safe.
        (previouslySeen.has(txn.providerTxnId) ? modified : added).push(txn);
      }

      const sweepIds = [...(state.sweep?.ids ?? []), ...page.map((p) => p.id)];

      if (page.length === PAGE_SIZE) {
        // Assume more pages exist; continue backward from the oldest id returned.
        const next: TellerCursorState = {
          watermark: state.watermark,
          recentIds: state.recentIds,
          sweep: { fromId: page[page.length - 1].id, ids: sweepIds.slice(0, RECENT_ID_CAP * 4) },
        };
        return { added, modified, removed: [], nextCursor: JSON.stringify(next), hasMore: true };
      }

      // Sweep complete: advance the watermark, keep a recent-id set so the
      // trailing re-scan window classifies correctly next time. Teller never
      // reports deletions, so `removed` is always empty here; expired pending
      // rows are aged out by the sync engine (21-day rule), not the adapter.
      const next: TellerCursorState = {
        watermark: isoDaysAgo(RESCAN_DAYS),
        recentIds: [...new Set([...sweepIds, ...state.recentIds])].slice(0, RECENT_ID_CAP),
      };
      return { added, modified, removed: [], nextCursor: JSON.stringify(next), hasMore: false };
    },

    // getLiabilities / getInvestments intentionally absent: Teller has neither
    // product. The design doc routes HELOC/auto/brokerage through Plaid
    // (later phase) and leases through the manual-augmentation UI.

    async handleWebhook(headers: Record<string, string>, rawBody: Buffer): Promise<WebhookVerdict> {
      const unverified: WebhookVerdict = { verified: false, action: 'ignore' };

      const secret = process.env.TELLER_SIGNING_SECRET;
      if (!secret) return unverified;    // cannot verify -> treat as forged, no side effects

      const header = headers['teller-signature'] ?? headers['Teller-Signature'] ?? '';
      const parts = header.split(',').map((s) => s.trim());
      const timestamp = parts.find((s) => s.startsWith('t='))?.slice(2);
      const signatures = parts.filter((s) => s.startsWith('v1=')).map((s) => s.slice(3));
      if (!timestamp || signatures.length === 0) return unverified;

      // Replay window. `t` is assumed to be unix epoch seconds (see header note).
      const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_MAX_AGE_SECONDS) return unverified;

      const expected = crypto.createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody.toString('utf8')}`)
        .digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      // Multiple v1 signatures appear during signing-secret rotation; any match verifies.
      const match = signatures.some((sig) => {
        const sigBuf = Buffer.from(sig, 'utf8');
        return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
      });
      if (!match) return unverified;

      let event: { id?: string; type?: string; payload?: { enrollment_id?: string; reason?: string } };
      try { event = JSON.parse(rawBody.toString('utf8')); } catch { return unverified; }

      const base = {
        verified: true as const,
        eventId: event.id,
        connectionRef: event.payload?.enrollment_id
          ? { providerItemId: event.payload.enrollment_id }
          : undefined,
      };
      switch (event.type) {
        case 'transactions.processed':
          return { ...base, action: 'sync_transactions' };
        case 'enrollment.disconnected': {
          const reason = event.payload?.reason ?? '';
          // Recoverable reasons (locked account, MFA, bad credentials) -> re-auth;
          // anything terminal -> disconnected. Teller's reason taxonomy is not
          // exhaustively documented; default to the recoverable path.
          const terminal = /revoked|closed|deleted/i.test(reason);
          return { ...base, action: terminal ? 'mark_disconnected' : 'mark_reauth', detail: { reason } };
        }
        case 'webhook.test':
        case 'account.number_verification.processed':
        default:
          return { ...base, action: 'ignore', detail: { type: event.type } };
      }
    },

    // refresh() intentionally absent: Teller has no on-demand refresh endpoint;
    // it polls institutions itself and emits transactions.processed.

    async unlink(token: string): Promise<void> {
      // DELETE /accounts revokes this application's access to every account in
      // the enrollment (verified in the live docs). The caller then nulls the
      // vault envelope and audits 'provider.unlink'. 404 = already gone.
      try {
        await tellerRequest<void>(token, 'DELETE', '/accounts');
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 404) return;
        throw err;
      }
    },
  };
}
