# Proof 06: Client-Facing Stack Leakage

**Proves that no client-visible HTTP response leaks internal implementation details: stack traces, file paths, hostnames, connection strings, module names, ORM errors, or schema field names.**

---

## Objective

Hit every known failure path against a production-mode API instance. Capture raw HTTP responses. Scan for leak patterns. Zero leakage across all paths.

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | Staging readiness green |
| 2 | API running in production mode | `NODE_ENV=production` in API env |
| 3 | Authenticated test session available | Login cookie + CSRF token |
| 4 | A workspace owned by test user exists | For cross-tenant test |
| 5 | A workspace owned by a DIFFERENT user exists | For cross-tenant isolation test |
| 6 | Gateway controllable (can be stopped) | For terminate-failure path |

---

## Leak Patterns to Scan

```
# Stack traces
"at "
"node_modules"
"Error:"
".ts:"
".js:"

# Internal infrastructure
"prisma"
"Prisma"
"proxmox"
"Proxmox"
"10\.[0-9]+\."
"192\.168\."
"172\.(1[6-9]|2[0-9]|3[01])\."
"/Users/"
"/home/"
"postgresql://"
"file:/"

# Schema/ORM internals
"findUnique"
"findFirst"
"PrismaClient"
"P2002"
"P2025"
"UNIQUE constraint"
"foreign key"

# Fastify internals
"statusCode.*5[0-9][0-9].*stack"
```

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/06-stack-leakage"
mkdir -p "$DIR"

# === LOGIN ===
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"integration-test@aldaro.ai","password":"TEST_PASSWORD"}' \
  -c cookies.txt -v 2>&1 | tee "$DIR/login.txt"

CSRF_TOKEN=$(grep -i 'x-csrf-token' "$DIR/login.txt" | awk '{print $NF}' | tr -d '\r')

# === TEST 1: Terminate failure (gateway down) ===
kill $(lsof -ti :5001) 2>/dev/null
sleep 1
curl -s -X POST http://localhost:4000/workspaces/RUNNING_WORKSPACE_ID/terminate \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -v 2>&1 | tee "$DIR/test1-terminate-failure.txt"
# Restart gateway after
cd apps/gateway && GATEWAY_PORT=5001 npx tsx src/index.ts &
sleep 3

# === TEST 2: CORS rejection ===
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.example.com" \
  -d '{"email":"test@test.com","password":"test"}' \
  -v 2>&1 | tee "$DIR/test2-cors-rejection.txt"

# === TEST 3: Rate limit ===
echo "Hammering forgot-password endpoint..."
for i in $(seq 1 110); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:4000/auth/forgot-password \
    -H "Content-Type: application/json" \
    -H "Origin: https://staging.aldaro.ai" \
    -d '{"email":"test@test.com"}'
done | tee "$DIR/test3-rate-limit-codes.txt"
# Capture a 429 response body
curl -s -X POST http://localhost:4000/auth/forgot-password \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"test@test.com"}' \
  -v 2>&1 | tee "$DIR/test3-rate-limit-body.txt"

# === TEST 4: CSRF failure (missing token) ===
curl -s -X POST http://localhost:4000/workspaces/launch \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -d '{"gpu_type":"RTX_5090"}' \
  -v 2>&1 | tee "$DIR/test4-csrf-failure.txt"
# (deliberately no x-csrf-token header)

# === TEST 5: Cross-tenant workspace access ===
curl -s http://localhost:4000/workspaces/OTHER_USERS_WORKSPACE_ID \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -v 2>&1 | tee "$DIR/test5-cross-tenant.txt"

# === TEST 6: Bad JSON body ===
curl -s -X POST http://localhost:4000/workspaces/launch \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -d '{bad json garbage' \
  -v 2>&1 | tee "$DIR/test6-bad-json.txt"

# === TEST 7: Unknown route ===
curl -s http://localhost:4000/api/nonexistent/route \
  -v 2>&1 | tee "$DIR/test7-unknown-route.txt"

# === TEST 8: Validation failure (bad field values) ===
curl -s -X POST http://localhost:4000/api/public/check-email-status \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"not-an-email"}' \
  -v 2>&1 | tee "$DIR/test8-validation-failure.txt"

# === TEST 9: Nonexistent workspace ID ===
curl -s http://localhost:4000/workspaces/00000000-0000-0000-0000-000000000000 \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -v 2>&1 | tee "$DIR/test9-nonexistent-workspace.txt"

# === TEST 10: Unauthenticated protected route ===
curl -s http://localhost:4000/api/customer/workspaces \
  -H "Origin: https://staging.aldaro.ai" \
  -v 2>&1 | tee "$DIR/test10-unauthenticated.txt"

# === LEAK SCAN (all tests) ===
echo "=== LEAK SCAN ===" | tee "$DIR/leak-scan.txt"
for f in "$DIR"/test*.txt; do
  echo "--- $(basename $f) ---" >> "$DIR/leak-scan.txt"
  grep -nEi "at |node_modules|\.ts:|\.js:|prisma|proxmox|10\.[0-9]+\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|/Users/|/home/|postgresql://|file:/|findUnique|findFirst|PrismaClient|P2002|P2025|UNIQUE constraint|foreign key" "$f" >> "$DIR/leak-scan.txt" 2>/dev/null || echo "CLEAN" >> "$DIR/leak-scan.txt"
done
cat "$DIR/leak-scan.txt"

# === SUMMARY TABLE ===
echo "" | tee "$DIR/summary.txt"
echo "| # | Test | HTTP Status | Leak? |" >> "$DIR/summary.txt"
echo "|---|---|---|---|" >> "$DIR/summary.txt"
for i in $(seq 1 10); do
  FILE=$(ls "$DIR"/test${i}-*.txt 2>/dev/null | head -1)
  if [ -z "$FILE" ]; then continue; fi
  NAME=$(basename "$FILE" .txt | sed 's/test[0-9]*-//')
  STATUS=$(grep -oP 'HTTP/[12]\.?[01]? \K[0-9]+' "$FILE" | tail -1)
  LEAK=$(grep -cEi "at |node_modules|\.ts:|\.js:|prisma|proxmox|postgresql://" "$FILE" 2>/dev/null)
  if [ "$LEAK" = "0" ]; then RESULT="CLEAN"; else RESULT="**LEAK**"; fi
  echo "| $i | $NAME | $STATUS | $RESULT |" >> "$DIR/summary.txt"
done
cat "$DIR/summary.txt"
```

---

## Expected Responses (Post-Remediation)

| # | Test | Expected Status | Expected Body Pattern | Remediation Applied |
|---|---|---|---|---|
| 1 | Terminate (gw down) | 202 | `{"ok":true,"status":"TERMINATING","queued":true}` | terminate is async, gw failure is cleanup-job's problem |
| 2 | CORS rejection | Blocked/empty | No CORS headers for evil origin | — |
| 3 | Rate limit | 429 | `{"error":"RATE_LIMITED",...}` | — |
| 4 | CSRF failure | 403 | `{"errorCode":"CSRF_TOKEN_INVALID",...}` | — |
| 5 | Cross-tenant | 404 | `{"error":"Not Found"}` or `{"error":"WORKSPACE_NOT_FOUND"}` | — |
| 6 | Bad JSON | 400 | `{"errorCode":"BAD_REQUEST","message":"Bad request",...}` | Global handler sanitizes parse error |
| 7 | Unknown route | 404 | Fastify default `{"message":"Route not found",...}` | — |
| 8 | Validation failure | 400 | `{"error":"Invalid request."}` | `.flatten()` removed from client, server-log only |
| 9 | Nonexistent workspace | 404 | Generic not found | `findUniqueOrThrow` → `findUnique` + 404 |
| 10 | Unauthenticated | 401/404 | `{"error":"Unauthorized"}` or route not found | — |

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | Leak scan | Every test file shows CLEAN | Any match on leak patterns |
| 2 | No stack traces | Zero occurrences of `"at "` + file path pattern | Any occurrence |
| 3 | No schema field names | Validation errors say `"Invalid request."` not field names | Field names like `"fullName"`, `"email"` in response body |
| 4 | No DB error codes | No P2002, P2025, or Prisma error codes in responses | Any Prisma code in response |
| 5 | No internal IPs | No 10.x.x.x, 192.168.x.x, 172.16-31.x.x in responses | Any private IP |
| 6 | CORS enforced | Evil origin gets no CORS headers | `Access-Control-Allow-Origin: evil.example.com` |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| API not in production mode | `NODE_ENV=development` may use a more verbose error handler — verify `NODE_ENV=production` |
| Only testing known routes | Routes you don't test may have different error handling — this is a sample, not exhaustive |
| Rate limiting not actually enforced | If rate limiter is disabled in staging, test 3 never reaches 429 — verify rate limiter config |
| CSRF not enforced for this route | Some routes are CSRF-exempt (webhooks, internal) — verify the tested route requires CSRF |
| Response body is empty | An empty 500 is safe (no leak) but indicates broken error handling — check both body AND status |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/06-stack-leakage/`:

| File | Contents |
|---|---|
| `test{1-10}-*.txt` | Raw HTTP response for each test case |
| `leak-scan.txt` | Full leak pattern scan results |
| `summary.txt` | Pass/fail summary table |
| `login.txt` | Auth response used to obtain session |

---

## Rollback/Cleanup

No destructive actions. Restart gateway if stopped for test 1. Rate limit may need time to expire before other tests can proceed.

---

## Launch Impact if Failed

**High.** Stack traces expose attack surface (file structure, module versions, DB schema). This is an OWASP top-10 information disclosure risk.
