/**
 * Provider adapter contract for the bank-aggregation subsystem.
 *
 * Every data source — Teller, Plaid, SimpleFIN, and plain file import — is a
 * `ProviderAdapter`. Capabilities are DECLARED, not assumed: the sync engine
 * and the UI branch on `capabilities`, never on the provider's name.
 *
 * Hard constraint (inherited from the security review and non-negotiable):
 * FinFlow NEVER stores a replayable bank credential — no bank usernames,
 * passwords or MFA seeds, ever. Connectivity is via tokenized aggregator APIs
 * (the tokens live in the vault, see ./vault.ts), user-side OAuth, or
 * user-supplied files.
 *
 * Sign convention, everywhere in this module: **negative = outflow** (money
 * leaving the account), matching the rest of FinFlow (`engine/parser.ts`).
 */

export type ProviderName = 'teller' | 'plaid' | 'simplefin' | 'ofx' | 'file';

export interface ProviderCapabilities {
  link: 'widget' | 'oauth_widget' | 'paste_token' | 'file' | 'manual_pull';
  webhooks: boolean;
  /** true = provider supplies a real server-side cursor (Plaid /transactions/sync).
   *  false = the adapter fabricates a cursor from a date watermark + recent-id list. */
  cursorSync: boolean;
  liabilities: boolean;
  investments: boolean;
  pendingTransactions: boolean;
  /** How far back the first sync can reach, in days. */
  maxHistoryDays: number;
}

export type ConnectionStatus =
  | 'pending_link' | 'active' | 'syncing' | 'reauth_required'
  | 'consent_expiring' | 'institution_down' | 'rate_limited'
  | 'error' | 'disconnected';

export interface LinkInitParams {
  userId: string;
  redirectUri?: string;              // OAuth return (Plaid)
  existingConnectionId?: string;     // update-mode / re-auth against an existing row
  products?: ('transactions' | 'liabilities' | 'investments')[];
  historyDays?: number;              // e.g. 730 for Plaid
}

export interface LinkInitResult {
  mode: 'widget' | 'redirect' | 'paste_token' | 'none';
  linkToken?: string;                       // Plaid link_token
  widgetConfig?: Record<string, unknown>;   // provider-specific client config (never secret)
  expiresAt?: string;
}

export interface ExchangeParams {
  userId: string;
  // exactly one of these is set, depending on the provider's link mode:
  publicToken?: string;              // Plaid onSuccess public_token
  accessToken?: string;              // Teller onSuccess accessToken (already final)
  setupToken?: string;               // SimpleFIN pasted setup token
  enrollmentId?: string;             // Teller enrollment id from onSuccess
  institutionHint?: { id?: string; name?: string };
  existingConnectionId?: string;     // re-auth completes against an existing row
}

export interface ExchangeResult {
  /** Plaid item_id / Teller enrollment_id / simplefin claim hash / `file:<userId>`. */
  providerItemId: string;
  /**
   * The provider access token, in plaintext, exactly once.
   * The caller MUST vault it immediately (vault.sealToken) and MUST NOT log it
   * or include it in any response. See vault.ts for the enforcement rules.
   */
  accessToken: string;
  institution: { id?: string; name: string };
}

export interface ProviderAccountData {
  providerAccountId: string;
  name: string;
  officialName?: string;
  mask?: string;                     // last 4 only — full numbers are never stored
  type: 'checking' | 'savings' | 'credit' | 'loan' | 'investment' | 'other';
  subtype?: string;                  // 'credit_card' | 'heloc' | 'auto' | 'lease' | ...
  currency: string;
  /** Normalized: liabilities are reported POSITIVE = amount owed. */
  currentBalance?: number;
  availableBalance?: number;
  creditLimit?: number;
  raw: unknown;                      // provider payload for audit (stored as JSON text)
}

export interface NormalizedTxn {
  providerTxnId: string;
  providerAccountId: string;
  date: string;                      // YYYY-MM-DD (authorized date preferred)
  postedDate?: string;
  name: string;
  merchantName?: string;
  /** FinFlow convention: negative = outflow. */
  amount: number;
  pending: boolean;
  /** Provider id of the pending txn this posted txn replaces (Plaid only). */
  pendingTxnId?: string | null;
  category?: string;
  raw: unknown;
}

export interface SyncPage {
  added: NormalizedTxn[];
  modified: NormalizedTxn[];
  removed: { providerTxnId: string }[];
  /** Opaque. Plaid: next_cursor pass-through. Pollers: JSON watermark state. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface LiabilitySnapshot {
  providerAccountId: string;
  kind: 'credit_card' | 'heloc' | 'auto_loan' | 'lease' | 'mortgage' | 'student' | 'other';
  aprs?: { type: string; percentage: number; balanceSubject?: number }[];
  interestRatePct?: number;          // installment loans
  minimumPayment?: number;
  nextDueDate?: string;
  lastStatementBalance?: number;
  lastStatementDate?: string;
  lastPaymentAmount?: number;
  lastPaymentDate?: string;
  isOverdue?: boolean;
  originationDate?: string;
  originationPrincipal?: number;
  maturityDate?: string;
  payoffBalance?: number;
  escrowBalance?: number;
  raw: unknown;
}

export interface InvestmentSnapshot {
  holdings: {
    providerAccountId: string; symbol?: string; name: string; securityType: string;
    quantity: number; costBasis?: number; price: number; value: number;
    asOf: string; raw: unknown;
  }[];
  investmentTxns: NormalizedTxn[];   // buys/sells/dividends, normalized
}

export interface WebhookVerdict {
  verified: boolean;
  eventId?: string;                  // provider event id, for the webhook_events idempotency table
  connectionRef?: { providerItemId: string };
  action: 'sync_transactions' | 'sync_liabilities' | 'sync_investments'
        | 'mark_reauth' | 'mark_disconnected' | 'consent_expiring' | 'ignore';
  detail?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  linkInit(p: LinkInitParams): Promise<LinkInitResult>;
  exchangePublicToken(p: ExchangeParams): Promise<ExchangeResult>;

  listAccounts(token: string): Promise<ProviderAccountData[]>;

  /**
   * One page per call; the caller loops while `hasMore`, committing each page
   * (rows + cursor) atomically before requesting the next.
   * Pollers (Teller/SimpleFIN/file) emulate cursors with a date watermark +
   * recent-id diff; pass `providerAccountId = null` for whole-connection scope
   * where the provider supports it.
   */
  syncTransactions(token: string, providerAccountId: string | null,
                   cursor: string | null): Promise<SyncPage>;

  getLiabilities?(token: string): Promise<LiabilitySnapshot[]>;
  getInvestments?(token: string): Promise<InvestmentSnapshot>;

  /** Pure + fast: verify signature, classify, return a verdict. NO DB writes here. */
  handleWebhook?(headers: Record<string, string>, rawBody: Buffer): Promise<WebhookVerdict>;

  /** Force a provider-side refresh where supported (Plaid /transactions/refresh); else omit. */
  refresh?(token: string): Promise<void>;

  /** Revoke provider-side access (Plaid /item/remove; Teller DELETE /accounts). */
  unlink(token: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error taxonomy — the sync engine classifies retries/backoff on these.
// Messages must never contain token material; use vault.redact() if a token
// needs to be referenced at all.
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(public readonly provider: ProviderName, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 401 / ITEM_LOGIN_REQUIRED / enrollment.disconnected — user must re-auth. */
export class ReauthRequiredError extends ProviderError {
  constructor(provider: ProviderName, detail = '') {
    super(provider, `re-authentication required${detail ? `: ${detail}` : ''}`);
  }
}

/** HTTP 429 — back off and retry later. */
export class RateLimitedError extends ProviderError {
  constructor(provider: ProviderName, public readonly retryAfterSeconds?: number) {
    super(provider, 'rate limited');
  }
}

/** Any other non-2xx from the provider. Body is truncated and sanitized by the thrower. */
export class ProviderHttpError extends ProviderError {
  constructor(provider: ProviderName, public readonly status: number, detail: string) {
    super(provider, `HTTP ${status}: ${detail.slice(0, 300)}`);
  }
}
