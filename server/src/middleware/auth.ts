import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database.js';
import { getJwtSecret, JWT_ALGORITHM, JWT_TTL_SECONDS } from '../config/security.js';

// Module augmentation to extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        mustChangePassword?: boolean;
      };
    }
  }
}

interface FinFlowClaims {
  id: string;
  email: string;
  role: string;
  /** Session generation. Bumped on password change/reset to revoke old tokens. */
  tv: number;
}

export function generateToken(userId: string, email: string, role = 'client', tokenVersion = 0): string {
  const payload: FinFlowClaims = { id: userId, email, role, tv: tokenVersion };
  return jwt.sign(payload, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_TTL_SECONDS,
  });
}

/** Routes reachable while an account is flagged `must_change_password`. */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/health',
]);

export async function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.slice(7).trim();

  let decoded: FinFlowClaims;
  try {
    // Pin the algorithm: prevents `alg:none` and HS/RS confusion attacks.
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: [JWT_ALGORITHM] }) as FinFlowClaims;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Re-check the user against the database on every request. This is what makes
  // logout, password-reset session revocation, role demotion and account
  // deletion take effect immediately instead of up to a full token lifetime later.
  let row: { id: string; email: string; role: string | null; token_version: number | null; must_change_password: number | null } | undefined;
  try {
    row = await db.get('SELECT id, email, role, token_version, must_change_password FROM users WHERE id = ?', decoded.id) as typeof row;
  } catch {
    res.status(503).json({ error: 'Service temporarily unavailable' });
    return;
  }

  if (!row) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if ((row.token_version ?? 0) !== (decoded.tv ?? 0)) {
    res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'SESSION_REVOKED' });
    return;
  }

  req.user = {
    id: row.id,
    // Always trust the database for role, never the token body.
    email: row.email,
    role: row.role ?? 'client',
    mustChangePassword: !!row.must_change_password,
  };

  if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.baseUrl + req.path.replace(/\/$/, ''))
      && !PASSWORD_CHANGE_ALLOWLIST.has(req.originalUrl.split('?')[0])) {
    res.status(403).json({
      error: 'Your password must be changed before you can continue. It matched a known default or was administratively reset.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    return;
  }

  next();
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
