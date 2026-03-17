# Approval Flow Audit

**Proof level**: L0 (code review only). Not locally exercised in production mode.

---

## Customer Access Status Flow

```
PENDING_REVIEW → APPROVED  (via author approve)
PENDING_REVIEW → REJECTED  (via author reject)
APPROVED       → SUSPENDED (via author suspend)
```

Source: `apps/api/src/routes/author/customers.ts`

### Status Resolution Logic

`resolveCustomerAccessStatus()` at `apps/api/src/lib/customerAccess.ts:6` resolves the effective status. This is used at login, profile fetch, and gating middleware.

---

## Route Matrix: Author vs Customer vs Guest

### Author-Only Routes (require `authenticate` + `requireAuthor`)

| Route | Method | File | CSRF? |
|---|---|---|---|
| `/api/author/customers/pending-count` | GET | author/customers.ts:16 | N/A (GET) |
| `/api/author/customers/queue` | GET | author/customers.ts:24 | N/A (GET) |
| `/api/author/customers/applications/:id` | GET | author/customers.ts:83 | N/A (GET) |
| `/api/author/customers/applications/:id/approve` | POST | author/customers.ts:116 | Yes (cookie-auth mutation) |
| `/api/author/customers/applications/:id/reject` | POST | author/customers.ts:190 | Yes (cookie-auth mutation) |
| `/api/author/customers/:userId/suspend` | POST | author/customers.ts:263 | Yes (cookie-auth mutation) |
| `/api/author/audit/*` | GET | author/audit.ts:8 | N/A (GET) |
| `/api/author/banner/*` | * | author/banner.ts:19 | Yes (mutations) |
| `/api/author/posts/*` | * | author/posts.ts:66 | Yes (mutations) |
| `/api/author/usage/*` | GET | author/usage.ts:43 | N/A (GET) |
| `/api/ops/fleet/*` | * | ops/fleet.ts:26 | Yes (mutations) |
| `/api/admin/alpha/allow` | POST | index.ts:488 | Yes (cookie-auth mutation) |

All author routes use `fastify.addHook('preHandler', fastify.requireAuthor)` or `preHandler: [fastify.authenticate, fastify.requireAuthor]`.

### Customer-Approved Routes (require `authenticate` + `requireCustomerApproved`)

| Route | Method | File |
|---|---|---|
| `/workspaces/*` | * | workspaces.ts:22 |
| `/billing/*` | * | billing.ts:13, 40 |
| `/v1/projects/*` | * | v1/projects.ts:16, 34, 52 |

### Customer-Any Routes (require `authenticate` only)

| Route | Method | File |
|---|---|---|
| `/api/customer/access/status` | GET | customer/access.ts |
| `/api/customer/application-update` | POST | customer/access.ts:54 |
| `/api/customer/resend-review-email` | POST | customer/access.ts:118 |

### Guest Routes (no auth required)

| Route | Method | File |
|---|---|---|
| `/health` | GET | index.ts |
| `/api/public/gpu-skus` | GET | public.ts |
| `/api/public/check-email-status` | POST | public.ts |
| `/auth/login` | POST | auth.ts |
| `/auth/register` | POST | auth.ts |
| `/auth/forgot-password` | POST | auth.ts |
| `/auth/reset-password` | POST | auth.ts |

---

## CSRF Protection Assessment

CSRF middleware is registered globally at `apps/api/src/index.ts:191`. It enforces on all cookie-authenticated mutations.

**Exempt paths** (from code review):
- Routes using Bearer token auth (not cookie-based)
- Webhook endpoints (Stripe)
- Internal/agent endpoints
- GET requests

**Approve/reject/suspend are POST routes** registered under the author route group which uses cookie-based auth. They should be CSRF-protected by the global middleware.

**Assessment**: CSRF appears to cover approve/reject/suspend based on code structure. This is L0 — not tested in production mode to confirm the middleware actually fires on these specific routes.

---

## Transaction Safety

Both approve and reject use `prisma.$transaction([...])` which is a sequential transaction:

**Approve** (`customers.ts:131-180`):
1. Update user: `customerAccessStatus` → `APPROVED`, `isAlphaTester` → true
2. Update application: `decision` → `APPROVED`, `reviewedAt` set
3. Upsert email outbox: `APPLICATION_ACCEPTED` with dedupeKey
4. Create audit record: `CUSTOMER_APPROVE`

**Reject** (`customers.ts:205-256`):
1. Update user: `customerAccessStatus` → `REJECTED`, `isAlphaTester` → false
2. Update application: `decision` → `REJECTED`, `decisionReason` set
3. Upsert email outbox: `APPLICATION_REJECTED` with dedupeKey
4. Create audit record: `CUSTOMER_REJECT`

**Suspend** (`customers.ts:274-298`):
1. Update user: `customerAccessStatus` → `SUSPENDED`, `isAlphaTester` → false
2. Create audit record: `CUSTOMER_SUSPEND`

All three use `$transaction` — if any step fails, all roll back. This is correct behavior.

---

## Audit Trail

| Action | Audit record created? | Audit action string | Includes diff? |
|---|---|---|---|
| Approve | Yes | `CUSTOMER_APPROVE` | Yes: targetUserId, fromStatus, toStatus, reason |
| Reject | Yes | `CUSTOMER_REJECT` | Yes: targetUserId, fromStatus, toStatus, reason, internalNotes |
| Suspend | Yes | `CUSTOMER_SUSPEND` | Yes: targetUserId, fromStatus, toStatus, reason |

Audit records are stored in `authorAudit` table via `prisma.authorAudit.create()`.

---

## Email Outbox

| Action | Email sent? | Type | Dedup key |
|---|---|---|---|
| Approve | Yes | `APPLICATION_ACCEPTED` | `APPLICATION_ACCEPTED:{applicationId}` |
| Reject | Yes | `APPLICATION_REJECTED` | `APPLICATION_REJECTED:{applicationId}` |
| Suspend | **No** | — | — |

**Finding**: Suspend does NOT create an email outbox record. The customer is not notified when their account is suspended. This may be intentional (admin contacts directly) or a gap.

**Finding**: Both approve and reject emails use `upsert` with dedupeKey, preventing duplicate emails on retry.

---

## Customer Gating After Each Status

Based on `requireCustomerApproved` middleware at `index.ts:388`:

| Status | Can access workspace routes? | Can access billing? | Can login? |
|---|---|---|---|
| PENDING_REVIEW | No | No | Yes (sees pending UI) |
| APPROVED | Yes | Yes | Yes |
| REJECTED | No | No | Yes (sees rejected UI) |
| SUSPENDED | No | No | Yes (sees suspended UI) |

**Note**: `requireCustomerApproved` checks `resolveCustomerAccessStatus(user) === 'APPROVED'`. All other statuses are blocked from workspace and billing routes.

---

## Guard Rail Analysis

### Already-Reviewed Guard
Both approve and reject check `if (app.decision) return reply.status(400).send({ error: 'Application already reviewed' })`. This prevents double-approve or approve-then-reject.

### Application-Not-Found Guard
All routes check for application existence and return 404 if not found.

### Required Fields
- Approve: `internalNotes` optional
- Reject: `decisionReason` required (validated by Zod schema)
- Suspend: `reason` required (validated by Zod schema)

---

## Risks and Open Questions

| Risk | Severity | Status |
|---|---|---|
| No suspend email notification | Low | Design decision — needs confirmation |
| No unsuspend path | Medium | SUSPENDED is terminal in current code — no route to restore |
| CSRF not verified in production mode | Medium | L0 only — needs local production-mode test |
| No rate limiting on approve/reject | Low | Author-only routes, low abuse risk |
| Zod validation error format may leak details | Low | `body.error.flatten()` is returned on reject/suspend — check if this exposes internal schema info |
| `resolveCustomerAccessStatus` edge cases | Low | Needs verification for null/undefined customerAccessStatus |

---

## What This Audit Proves (L0)

- Approve, reject, and suspend routes exist with correct transactional behavior
- Audit records are created for all three actions
- Email outbox records are created for approve and reject (not suspend)
- Dedup keys prevent duplicate emails
- Already-reviewed guard prevents double decisions
- Author role is required for all customer management routes
- `requireCustomerApproved` gates workspace/billing access

## What This Audit Does NOT Prove

- CSRF actually fires on these routes in production mode
- Error responses are clean (no stack traces)
- Concurrent approve/reject race is handled
- Email delivery actually works
- Suspend notification gap is intentional
- Unsuspend path is intentionally absent
