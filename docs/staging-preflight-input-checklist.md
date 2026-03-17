# Staging Preflight Input Checklist

Every value below must be collected before staging bootstrap can begin. Fill in the "Value" column when infra access arrives.

---

## Infrastructure Credentials

| # | Variable | Format | Where to get | Value |
|---|---|---|---|---|
| 1 | `PROXMOX_API_URL` | `https://host:8006` | Proxmox admin | |
| 2 | `PROXMOX_API_TOKEN_ID` | `user@realm!tokenname` | Proxmox: Datacenter > Permissions > API Tokens | |
| 3 | `PROXMOX_API_TOKEN_SECRET` | UUID | Same as above (shown once on creation) | |
| 4 | Proxmox node name(s) | String (e.g. `pve1`) | `pvesh get /nodes` or Proxmox UI | |
| 5 | GPU PCI addresses | `0000:XX:00.0` | `lspci -nn | grep -i nvidia` on Proxmox host | |
| 6 | GPU names from nvidia-smi | String | `nvidia-smi -L` on Proxmox host | |
| 7 | Template VMID(s) | Integer (e.g. 9000) | Proxmox UI after template preparation | |

## Billing Credentials

| # | Variable | Format | Where to get | Value |
|---|---|---|---|---|
| 8 | `STRIPE_SECRET_KEY` | `sk_test_...` | Stripe Dashboard > Developers > API keys | |
| 9 | `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | Same | |
| 10 | `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Stripe Dashboard > Developers > Webhooks | |
| 11 | Stripe test customer ID | `cus_test_...` | Stripe > Customers (create if needed) | |
| 12 | Stripe meter name | `gpu_seconds` | Stripe > Billing > Meters (create if needed) | |

## Generated Secrets (create fresh for staging)

| # | Variable | Generate with | Shared across | Value |
|---|---|---|---|---|
| 13 | `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | API, Web | |
| 14 | `JWT_REFRESH_SECRET` | `openssl rand -base64 48` | API | |
| 15 | `ALDARO_AGENT_SHARED_SECRET` | `openssl rand -hex 32` | API, Worker | |
| 16 | `GATEWAY_SERVICE_SECRET` | `openssl rand -hex 32` | API, Worker, Gateway | |

## Network / DNS

| # | Item | Example | Value |
|---|---|---|---|
| 17 | Staging API host | `api-staging.aldaro.ai` or IP:port | |
| 18 | Staging Web host | `staging.aldaro.ai` or IP:port | |
| 19 | Gateway host | `gw1.aldaro.ai` or IP:port | |
| 20 | Database host | `db-host:5432` | |
| 21 | Database name | `aldaro_staging` | |
| 22 | Database user | `aldaro` | |
| 23 | Database password | Generated | |

## Fleet Seed Data (fill after infra access)

| # | Item | Count | Values |
|---|---|---|---|
| 24 | Fleet nodes | 1+ | Names: |
| 25 | RTX 5090 GPUs | 2+ | PCI addresses: |
| 26 | A100 80GB GPUs | 0-1+ | PCI addresses: |
| 27 | VM templates | 1+ per GPU type | VMIDs: |

## Test Accounts

| # | Item | Value |
|---|---|---|
| 28 | Admin email | shivas@aldaro.ai |
| 29 | Admin password | (set during seed) |
| 30 | Test customer email | integration-test@aldaro.ai |
| 31 | Test customer password | (set during seed) |
| 32 | Test customer Stripe ID | (from item 11) |

---

## Validation Commands

After filling in all values:

```bash
# 1. Test Proxmox connectivity
curl -k -H "Authorization: PVEAPIToken=${PROXMOX_API_TOKEN_ID}=${PROXMOX_API_TOKEN_SECRET}" \
  "${PROXMOX_API_URL}/api2/json/nodes"

# 2. Test Stripe connectivity
curl https://api.stripe.com/v1/customers/${STRIPE_CUSTOMER_ID} \
  -u ${STRIPE_SECRET_KEY}:

# 3. Test database connectivity
psql -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -c "SELECT 1"

# 4. Verify secret lengths
echo "JWT_ACCESS_SECRET: $(echo -n "$JWT_ACCESS_SECRET" | wc -c) chars"
echo "JWT_REFRESH_SECRET: $(echo -n "$JWT_REFRESH_SECRET" | wc -c) chars"
echo "AGENT_SECRET: $(echo -n "$ALDARO_AGENT_SHARED_SECRET" | wc -c) chars"
echo "GATEWAY_SECRET: $(echo -n "$GATEWAY_SERVICE_SECRET" | wc -c) chars"

# 5. Run full preflight
node scripts/preflight-check.js
```

---

## Service Start Order (after all values populated)

1. **Database**: Verify Postgres accessible, schema applied, seed data loaded
2. **Gateway**: `cd apps/gateway && npm start` → verify `GET /health` returns OK
3. **API**: `cd apps/api && npm start` → verify `GET /health` returns OK
4. **Worker**: `cd worker && npm start` → verify leader lock acquired in logs
5. **Web** (optional): `cd apps/web && npm start` → verify page loads

## Health Check Commands

```bash
curl http://${API_HOST}:4000/health
curl http://${GATEWAY_HOST}:5001/health
curl http://${API_HOST}:4000/api/public/gpu-skus
```

## Rollback Steps if Bootstrap Fails

| Stage | Rollback |
|---|---|
| Schema push fails | Check Postgres version compatibility, check DATABASE_URL format |
| Seed fails | Drop and recreate database, re-push schema, re-seed |
| Gateway won't start | Check GATEWAY_SERVICE_SECRET is set, check port availability |
| API won't start | Check DATABASE_URL, JWT secrets, CORS origin |
| Worker won't start | Check DATABASE_URL points to Postgres (not SQLite), check Proxmox vars |
| Preflight fails | Address each failure individually (see staging-bootstrap-runbook.md troubleshooting) |

## First-Day Staging Run Plan

| Time | Action | Expected Duration |
|---|---|---|
| T+0 | Fill in all checklist values | 30 min |
| T+30 | Create database, apply schema, seed | 10 min |
| T+40 | Generate and distribute secrets | 10 min |
| T+50 | Start gateway, verify health | 5 min |
| T+55 | Start API, verify health | 5 min |
| T+60 | Start worker, verify leader lock | 5 min |
| T+65 | Run preflight check | 5 min |
| T+70 | Fix any preflight failures | 15-30 min |
| T+100 | Begin Proof 1 (staging readiness) | 10 min |
| T+110 | Begin Proof 2 (billing parity) | 30 min |
| T+140 | Begin Proof 3 (terminate outage) | 30 min |
| T+170 | Begin Proof 4 (last-GPU contention) | 20 min |
| T+190 | Begin Proof 5 (restore drill) | 20 min |
| T+210 | Begin Proof 6 (stack leakage) | 20 min |
| T+230 | Begin Proof 7 (cleanup durability) | 20 min |
| T+250 | Document results, update launch-readiness-index | 30 min |
