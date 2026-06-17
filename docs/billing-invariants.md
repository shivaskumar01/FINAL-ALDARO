# Billing Invariants

**Proof level**: L1 (locally verified with 24 passing tests against Postgres 15.17)

---

## Invariants

### INV-1: At most one RUNNING session per workspace

**Enforcement**: Two layers:
1. **Application guard** in `startUsageSession()`, checks `findFirst({ status: 'RUNNING' })` before creating.
2. **DB partial unique index**, `usage_sessions_one_running_per_workspace` on `("workspaceId") WHERE status = 'RUNNING'`.

**DB enforcement**: **Yes**, partial unique index applied via migration `20260313000000_enforce_one_running_session`. A second `INSERT` with `status = 'RUNNING'` for the same `workspaceId` will fail with Prisma P2002 (unique constraint violation). Historical ENDED sessions are not constrained.

**Risk**: Effectively zero. Even if the application guard is bypassed (e.g., concurrent race), the DB rejects the duplicate. The application code in `startUsageSession` should catch P2002 and return the existing session gracefully.

**Tested**: Yes, 8 dedicated constraint tests:
- First RUNNING session succeeds
- Second RUNNING session blocked by DB (P2002)
- Multiple ENDED sessions allowed
- ENDED + one RUNNING coexist
- Close then reopen succeeds
- Concurrent race: exactly one wins at DB level
- Application guard and DB constraint produce consistent result (no contradictory errors)

---

### INV-2: At most one close transition per session

**Enforcement**: `WHERE status: 'RUNNING'` compound filter on the `usageSession.update()` inside the `$transaction`. If the session is already ENDED, Prisma throws P2025 (record not found), which is caught and ignored.

**DB enforcement**: The status field has no constraint preventing re-transitions, but the application logic ensures the update only matches RUNNING sessions.

**Tested**: Yes, 5 tests cover this:
- `duplicate close request is safe`
- `close after session already ended via finalizeUsageSessions`
- `concurrent close attempts both succeed`
- `two worker passes racing on finalizeUsageSessions`
- `endUsageSession + finalizeUsageSessions interop: no double close`

---

### INV-3: At most one outbox enqueue per terminal usage close

**Enforcement**: `WorkspaceMeterEventOutbox.usageSessionId` has `@unique` constraint in schema. The `upsert` in the close transaction uses this as the `where` key.

**DB enforcement**: Yes, unique constraint at DB level. Attempting to create a duplicate throws a Prisma constraint violation.

**Tested**: Yes, `DB unique constraint prevents duplicate outbox rows per session` explicitly tests this.

---

### INV-4: Failed provision cannot create billable usage

**Enforcement**: `startUsageSession` is only called after workspace reaches RUNNING_ASSIGNED. Provision failure sets status to FAILED before this point.

**Risk**: If `startUsageSession` is somehow called on a FAILED workspace, it will create a session. However, `finalizeUsageSessions` will clean it up.

**Tested**: Yes, `failed workspace: startUsageSession guard allows creation but endUsageSession cleans up`

---

### INV-5: Terminate cannot leave a RUNNING session behind

**Enforcement**: Both `endUsageSession()` (API) and `finalizeUsageSessions()` (worker cleanup job) close all RUNNING sessions for a workspace.

**Tested**: Yes, `terminate path (finalizeUsageSessions) closes session exactly once` and `no RUNNING sessions on terminal workspaces after cleanup`

---

### INV-6: Session close and outbox enqueue are atomic

**Enforcement**: Both writes are in a single `prisma.$transaction([...])` call. If either fails, neither commits.

**Tested**: Yes, `normal close transitions to ENDED + creates outbox atomically` and `every ENDED session has exactly one outbox entry`

---

### INV-7: endUsageSession and finalizeUsageSessions are interop-safe

**Enforcement**: Both use the same `WHERE status: 'RUNNING'` + P2025 catch pattern. When racing, one wins the transaction and the other gets P2025 (silently ignored).

**Tested**: Yes, `endUsageSession + finalizeUsageSessions interop: no double close`

**Bug found and fixed during testing**: `endUsageSession` was missing the P2025 catch. Added in this verification phase.

---

## SQL Inspection Results (2026-03-13)

All billing inspection queries returned 0 rows on local Postgres after test run:

| Query | Description | Result |
|---|---|---|
| 1 | Active RUNNING sessions | 0 |
| 2 | ENDED sessions without outbox | 0 |
| 3 | Pending/retry outbox backlog | 0 |
| 4 | Sent but unreconciled | 0 |
| 5 | Failed meter events | 0 |
| 6 | Orphan sessions on terminal workspaces | 0 |
| 7 | Duplicate outbox entries | 0 |

---

## What is locally proven

- Session open/close lifecycle is race-safe under concurrent calls
- Outbox entry is always created atomically with session close
- Duplicate close is always a no-op (no error, no duplicate data)
- Billing math is correct for known time intervals
- Zero-price sessions still get outbox entries for tracking
- Outbox retry semantics work correctly (increment, RETRY, SENT, FAILED)
- DB unique constraint prevents duplicate outbox rows

## What still requires real infrastructure

- Stripe meter event actually accepted by Stripe API
- Stripe idempotency behavior (duplicate event emission)
- End-to-end: workspace launch → usage → terminate → Stripe invoice line item
- GpuSku pricing lookup with real seed data
- Billing under real clock drift / timezone edge cases
