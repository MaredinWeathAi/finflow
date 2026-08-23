# FinFlow Security

## Reporting

Security issues: contact the repository owner directly. Do not open a public issue.

## Current posture

| Control | Status |
|---|---|
| Password hashing | bcrypt, cost 12, transparently upgraded on login |
| Session tokens | JWT HS256, algorithm pinned, 12h TTL, DB-backed revocation |
| Session revocation | `users.token_version` — bumped on logout, password change, and reset |
| Brute-force defence | IP rate limits (express-rate-limit) + per-account exponential lockout |
| Security headers | helmet: CSP, HSTS, nosniff, frame-ancestors none, referrer policy |
| CORS | Same-origin by default; explicit allowlist via `ALLOWED_ORIGINS` |
| Self-registration | Disabled in production unless `ALLOW_SELF_REGISTRATION=true` |
| Privilege assignment | `role` is server-assigned only; never read from a request body |
| Password reset | Codes are CSPRNG-generated, SHA-256 hashed at rest, single-use, 15-minute TTL, delivered out-of-band only |
| Audit logging | `audit_log` table; every auth event, with IP and user agent |
| Upload limits | 10 MB/file, 15 files, 40 MB/request, extension allowlist, filename validation |
| Spreadsheet parsing | Patched SheetJS build; rows rebuilt on null-prototype objects |
| Default credentials | Boot-time tripwire flags and neutralises any account on a known default |

## The default-credential tripwire

Earlier builds seeded `demo@finflow.com / demo123` (role `admin`) and demo clients
on `password123`, and auto-ran that seed against any empty database — including
production. Those credentials were live on the public deployment.

On every boot the server now tests each account against the list of known
default passwords. A match is flagged `must_change_password = 1` and its
`token_version` is bumped, which:

- revokes every live session for that account, and
- causes the auth middleware to reject **every** route except `/api/auth/me`,
  `/api/auth/change-password` and `/api/auth/logout`.

The account is deliberately *not* rotated to a random password: that would lock
the legitimate owner out of their own data. An attacker holding the default
password can still obtain a token, but that token can read nothing.

## Environment variables

See `.env.example`. In production the seed script refuses to run without
`ADMIN_EMAIL` and a `ADMIN_PASSWORD` of at least 16 characters, and will not
create demo accounts at all.

## Password reset delivery

Reset codes are never returned in an HTTP response. Delivery is, in order:

1. `RESET_WEBHOOK_URL` — a POST of `{email, code, expiresAt}` to a webhook you
   control (Zapier / Make / n8n / your own mailer), optionally authenticated
   with `RESET_WEBHOOK_SECRET`.
2. The server log — reachable only by whoever controls the deployment.

## Known gaps

Tracked, not yet implemented:

- No TOTP/2FA (schema columns reserved: `users.totp_secret`, `users.totp_enabled`)
- Database is not encrypted at rest; automatic backups are plaintext
- No automated tenant-isolation test suite
- No dependency-update automation
