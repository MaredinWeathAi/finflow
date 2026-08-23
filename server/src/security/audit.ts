/**
 * Append-only security audit log.
 *
 * Every authentication event, privilege change, data export and destructive
 * action lands here. For an advisor holding client data this is both an
 * incident-response tool and a books-and-records artifact.
 */
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { db } from '../db/database.js';

export type AuditAction =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.login.locked'
  | 'auth.register'
  | 'auth.logout'
  | 'auth.password.change'
  | 'auth.password.reset.request'
  | 'auth.password.reset.complete'
  | 'auth.profile.update'
  | 'auth.default_credential_blocked'
  | 'admin.client.view'
  | 'data.export'
  | 'data.delete'
  | 'upload.commit'
  | 'provider.link'
  | 'provider.unlink'
  | 'provider.sync';

export interface AuditContext {
  userId?: string | null;
  actorEmail?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  detail?: Record<string, unknown>;
}

/** Extract a trustworthy-ish client IP. `trust proxy` is set for Railway's edge. */
export function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

const SENSITIVE_KEYS = /pass|secret|token|authorization|cookie|ssn|account_number|routing/i;

function redact(detail: Record<string, unknown> | undefined): string | null {
  if (!detail) return null;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    safe[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : v;
  }
  try { return JSON.stringify(safe).slice(0, 4000); } catch { return null; }
}

export async function audit(action: AuditAction, req: Request | null, ctx: AuditContext = {}): void {
  try {
    await db.run(`INSERT INTO audit_log (id, user_id, actor_email, action, target_id, outcome, ip, user_agent, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), ctx.userId ?? req?.user?.id ?? null, ctx.actorEmail ?? req?.user?.email ?? null, action, ctx.targetId ?? null, ctx.outcome ?? 'success', req ? clientIp(req) : null, req?.get('user-agent')?.slice(0, 300) ?? null, redact(ctx.detail), new Date().toISOString());
  } catch (err) {
    // Never let audit failure break a request, but make it visible.
    console.error('[audit] write failed:', (err as Error).message);
  }
}

/** Retention trim — keeps the log from growing without bound on a small volume. */
export async function trimAuditLog(keepDays = 400): void {
  try {
    const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
    await db.run('DELETE FROM audit_log WHERE created_at < ?', cutoff);
  } catch { /* table may not exist yet */ }
}
