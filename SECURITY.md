# Security

This document describes security measures in the Aldaro project and how to deploy safely.

## Authentication & Sessions

- **Passwords**: Bcrypt (cost 12). Minimum 15 characters; must include upper, lower, digit, and symbol. Never stored or logged in plain text.
- **Sessions**: JWT in httpOnly, SameSite=Strict cookies. No tokens in `localStorage` (XSS-safe). In production, cookies use `secure: true`.
- **CSRF**: Enabled in production via `@fastify/csrf-protection`. All state-changing requests require a valid CSRF token.
- **Login/signup**: Generic error messages (“Invalid credentials”) to prevent account enumeration. Rate limited (e.g. 5/min per IP).
- **Security events**: Login success/failure, logout, password reset, and role-gated access are logged to `security_logs` for audit.

## API Security

- **Helmet**: Security headers (CSP, X-Content-Type-Options, Referrer-Policy, HSTS in production, etc.).
- **CORS**: In production, only `APP_BASE_URL` is allowed. Credentials allowed for cookie-based auth.
- **Rate limiting**: Global limit (e.g. 100 req/min). Auth endpoints have stricter limits (e.g. 5/min).
- **Body size**: Request body limited (e.g. 512 KB) to reduce DoS risk.
- **Input validation**: Request bodies and params validated with Zod (or equivalent) before use. Prisma used with parameterized queries (no raw SQL with user input).
- **Author routes**: All `/api/author/*` and `/api/author/usage/*` require JWT + DB check that user has role `AUTHOR` and account is ACTIVE.

## Internal & Agent APIs

- **Internal agent** (`/internal/agent`): HMAC-SHA256 over raw body; timing-safe comparison; nonce + timestamp replay protection. Requires `ALDARO_AGENT_SHARED_SECRET` in production.
- **Secrets**: No secrets in code. Use environment variables; validate required secrets at startup in production.

## Frontend (Next.js)

- **Security headers**: X-Frame-Options (SAMEORIGIN), X-Content-Type-Options (nosniff), X-XSS-Protection, Referrer-Policy, Permissions-Policy applied via `next.config.mjs`.
- **Auth**: Session cookie only; middleware validates JWT for `/app` and `/author`. Author routes require `role === 'AUTHOR'` in the token and middleware re-checks as needed.
- **API client**: `withCredentials: true` for cookies; CSRF token sent on state-changing requests. No auth tokens in localStorage.

## Database

- **Access**: Use least-privilege DB user in production. `DATABASE_URL` from environment only.
- **SQL**: Prefer Prisma (parameterized). No string-concatenated user input in raw SQL.

## Production Checklist

1. **Environment**
   - Set `NODE_ENV=production`.
   - Set strong, unique values for: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ALDARO_AGENT_SHARED_SECRET` (64+ char random).
   - Use HTTPS only. Set `APP_BASE_URL` and `API_BASE_URL` to HTTPS.
   - Restrict `DATABASE_URL`, `REDIS_URL`, Stripe keys, and Proxmox/gateway secrets to the server.

2. **Cookies**
   - Session cookie is httpOnly, SameSite=Strict, and in production `secure: true` (HTTPS only).

3. **CORS**
   - Only allow `APP_BASE_URL` (and any trusted admin origins if added). No `*` for credentialed requests.

4. **Secrets**
   - Rotate JWT and agent secrets periodically. Rotate author bootstrap password after first login if used.
   - Never commit `.env` or real secrets to version control.

5. **Monitoring**
   - Monitor `security_logs` for failures and role-gated access. Alert on spikes in login failures or 401/403.

6. **Dependencies**
   - Run `npm audit` and fix high/critical issues. Keep dependencies updated.

## Reporting Vulnerabilities

If you find a security issue, please report it privately (e.g. to the maintainers or via a private security contact) rather than in a public issue.
