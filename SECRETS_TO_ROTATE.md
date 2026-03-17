# Secrets That Must Be Rotated Before Production

**WARNING:** The following secrets were exposed in the previous codebase and MUST be rotated immediately before any production deployment.

## Critical Secrets (Rotate Immediately)

### 1. JWT Secrets
- `JWT_ACCESS_SECRET` - Was: `aldaro_access_secret_123`
- `JWT_REFRESH_SECRET` - Was: `aldaro_refresh_secret_123`
- **Action:** Generate new 64+ character random strings using `openssl rand -base64 48`

### 2. Agent Shared Secret
- `ALDARO_AGENT_SHARED_SECRET` - Was: `aldaro_shared_secret_456`
- **Action:** Generate new secret, update all VM agent configurations

### 3. Stripe Keys
- `STRIPE_SECRET_KEY` - Was exposed (sk_test_...)
- `STRIPE_WEBHOOK_SECRET` - Was exposed (whsec_...)
- **Action:** Rotate in Stripe Dashboard, update API config

### 4. Gateway Service Secret (New)
- `GATEWAY_SERVICE_SECRET` - Not previously configured
- **Action:** Generate and configure for service-to-service auth

## Removed Secrets (No Longer Needed)

### RunPod API Key
- `RUNPOD_API_KEY` - **DELETED** - Aldaro uses only owned infrastructure
- **Action:** None - external provider removed

## Security Issues Fixed

### Client-Side Secret Leak
- **Problem:** `JWT_ACCESS_SECRET` was in `apps/web/.env.local`
- **Fix:** Removed. Frontend uses httpOnly cookies only, no direct JWT access.

## Generating New Secrets

```bash
# Generate JWT secrets (64 chars)
openssl rand -base64 48

# Generate agent secret
openssl rand -hex 32

# Generate gateway service secret
openssl rand -hex 32
```

## Deployment Checklist

- [ ] Generate all new secrets
- [ ] Update production .env files (not in repo)
- [ ] Update Stripe Dashboard with new webhook endpoints
- [ ] Update all VM agent configurations with new shared secret
- [ ] Configure gateway service authentication
- [ ] Verify no secrets in any committed files
- [ ] Run `git log --all --full-history -S "secret_string"` to ensure no history exposure
