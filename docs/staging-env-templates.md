# Staging Environment Templates

## Secret Matrix

Every secret below must be staging-grade (random, >= 32 chars, no defaults).
Generate with: `openssl rand -hex 32` (64 hex chars) or `openssl rand -base64 48` (64 base64 chars).

| Variable | Services | Required | Format | Breaks if missing |
|---|---|---|---|---|
| `DATABASE_URL` | API, Worker, DB | Yes | `postgresql://user:pass@host:5432/aldaro_staging` | All DB operations fail |
| `PROXMOX_API_URL` | Worker, preflight | Yes | `https://host:8006` | No VM provisioning |
| `PROXMOX_API_TOKEN_ID` | Worker, preflight | Yes | `user@realm!tokenname` | No Proxmox auth |
| `PROXMOX_API_TOKEN_SECRET` | Worker, preflight | Yes | UUID from Proxmox | No Proxmox auth |
| `JWT_ACCESS_SECRET` | API, Web (server) | Yes | >= 32 chars, random | Auth broken |
| `JWT_REFRESH_SECRET` | API | Yes | >= 32 chars, random | Cookie signing broken |
| `ALDARO_AGENT_SHARED_SECRET` | API, Worker, Agent | Yes | >= 32 chars, random | Agent handshake fails |
| `GATEWAY_SERVICE_SECRET` | API, Worker, Gateway | Yes | >= 32 chars, random | Port allocation unsigned |
| `STRIPE_SECRET_KEY` | API, Worker (metering) | Yes for billing | `sk_test_...` | Billing emission fails |
| `STRIPE_WEBHOOK_SECRET` | API | Yes for billing | `whsec_...` | Webhook verification fails |
| `APP_BASE_URL` | API | Yes | `https://staging.aldaro.ai` | CORS rejects frontend |
| `API_BASE_URL` | Worker, Web | Yes | `https://api-staging.aldaro.ai` | Inter-service calls fail |
| `GATEWAY_INTERNAL_URL` | API, Worker | Yes | `http://gateway-host:5001` | Port alloc/release fails |
| `GATEWAY_HOST` | Gateway | Yes | `gw1.aldaro.ai` | Wrong host in alloc response |
| `COOKIE_DOMAIN` | API | Yes in prod | `.aldaro.ai` | Cookies not sent cross-subdomain |

---

## API Staging .env

```bash
NODE_ENV=production
API_PORT=4000

# Public URLs
APP_BASE_URL=https://staging.aldaro.ai
API_BASE_URL=https://api-staging.aldaro.ai

# Database (Postgres required for staging)
DATABASE_URL=postgresql://aldaro:PASSWORD@db-host:5432/aldaro_staging

# JWT (generate: openssl rand -base64 48)
JWT_ACCESS_SECRET=REPLACE_WITH_64_CHAR_RANDOM
JWT_REFRESH_SECRET=REPLACE_WITH_64_CHAR_RANDOM

# Cookie
COOKIE_DOMAIN=.aldaro.ai

# Agent auth (generate: openssl rand -hex 32)
ALDARO_AGENT_SHARED_SECRET=REPLACE_WITH_64_HEX_CHAR_RANDOM

# Stripe (test mode)
STRIPE_SECRET_KEY=sk_test_REPLACE
STRIPE_WEBHOOK_SECRET=whsec_REPLACE
STRIPE_PUBLISHABLE_KEY=pk_test_REPLACE

# Proxmox (read-only from API is acceptable; Worker does mutations)
PROXMOX_API_URL=https://proxmox-host:8006
PROXMOX_API_TOKEN_ID=aldaro@pve!staging
PROXMOX_API_TOKEN_SECRET=REPLACE_WITH_PROXMOX_TOKEN

# Gateway
GATEWAY_INTERNAL_URL=http://gateway-host:5001
GATEWAY_SERVICE_SECRET=REPLACE_WITH_64_HEX_CHAR_RANDOM

# Logging
LOG_LEVEL=info
```

---

## Worker Staging .env

```bash
NODE_ENV=production

# Database (must match API)
DATABASE_URL=postgresql://aldaro:PASSWORD@db-host:5432/aldaro_staging

# Agent auth (must match API)
ALDARO_AGENT_SHARED_SECRET=REPLACE_WITH_64_HEX_CHAR_RANDOM

# Proxmox (required — worker does all provisioning)
PROXMOX_API_URL=https://proxmox-host:8006
PROXMOX_API_TOKEN_ID=aldaro@pve!staging
PROXMOX_API_TOKEN_SECRET=REPLACE_WITH_PROXMOX_TOKEN

# Gateway (must match API)
GATEWAY_INTERNAL_URL=http://gateway-host:5001
GATEWAY_SERVICE_SECRET=REPLACE_WITH_64_HEX_CHAR_RANDOM

# API callback
API_BASE_URL=http://api-host:4000

# Stripe (for metering emission)
STRIPE_SECRET_KEY=sk_test_REPLACE

# Worker settings
WARM_POOL_TICK_SECONDS=30
AUTO_TERMINATE_IDLE_MINUTES=20

# Logging
LOG_LEVEL=info
```

---

## Gateway Staging .env

```bash
NODE_ENV=production
GATEWAY_PORT=5001

# Public hostname returned in allocation responses
GATEWAY_HOST=gw1.aldaro.ai

# HMAC secret (must match API and Worker)
GATEWAY_SERVICE_SECRET=REPLACE_WITH_64_HEX_CHAR_RANDOM
```

---

## Web Staging .env.local

```bash
NEXT_PUBLIC_API_BASE_URL=https://api-staging.aldaro.ai

# JWT secret (must match API — used for server-side session verification)
JWT_ACCESS_SECRET=REPLACE_WITH_64_CHAR_RANDOM
```

---

## Validation Checklist

After filling in all env files, verify:

1. `GATEWAY_SERVICE_SECRET` is identical across API, Worker, Gateway
2. `ALDARO_AGENT_SHARED_SECRET` is identical across API, Worker
3. `DATABASE_URL` is identical across API, Worker (and points to Postgres, not SQLite)
4. `JWT_ACCESS_SECRET` is identical across API, Web
5. No env value contains `changeme`, `secret`, `password`, `default`, `test123`, `placeholder`
6. All secrets are >= 32 characters
7. Stripe keys are test-mode (`sk_test_`, `pk_test_`, `whsec_`)
