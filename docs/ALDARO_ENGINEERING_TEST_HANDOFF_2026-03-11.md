# Aldaro Engineering Test Handoff
Date: 2026-03-11  
Environment: local (127.0.0.1)  
Reviewed by: Codex (runtime-first + static verification)

## Final Recommendation
**NO-GO**

Launch is blocked by confirmed P0/P1 issues and unproven P0 infrastructure controls.

## Confirmed Launch Blockers (P0)
1. **Provisioning idempotency failure**: duplicate workspaces created for same launch intent.
2. **Provisioning/termination reliability failure**: terminate path returns 500 when gateway is unavailable, with stack leakage.
3. **CSRF gap on sensitive author mutation in current runtime mode**: approve/reject can execute without CSRF token in local runtime.
4. **Billing correctness not proven**: Stripe usage emission remains TODO in code path used by termination.
5. **Data lifecycle/cleanup failure evidence**: 34 stuck workspaces (preflight + DB query).
6. **Backup/restore not proven**: no successful restore exercise evidence.

---

## Evidence Catalog
- **E-01** `POST /auth/login` author (`shivas@aldaro.ai`) returned `200` with role `AUTHOR`.
- **E-02** `POST /auth/login` customer (`test@aldaro.ai`) returned `200` with role `CUSTOMER`.
- **E-03** Cross-role API blocks: customer -> `/api/author/usage/overview` => `404`; author -> `/workspaces` => `404`.
- **E-04** Applicant gate: pending user `/workspaces` => `403 CUSTOMER_NOT_APPROVED`, `/app` => `307 /pending-review`.
- **E-05** Reject gate: rejected user `/workspaces` => `403`, `/app` => `307 /access-denied`.
- **E-06** Logout invalidation: login -> session `200`; logout `200`; next session `401 Unauthorized`.
- **E-07** CSRF check: `POST /api/author/customers/applications/:id/approve` **without CSRF token** => `200 APPROVED`.
- **E-08** CORS bad origin: `POST /auth/login` with `Origin: https://evil.example` => `500` body includes stack trace.
- **E-09** Forgot-password abuse: rate limit triggers `429`, response includes stack trace.
- **E-10** Build checks: `npm run build -w @aldaro/api` and `npm run build -w @aldaro/web` passed.
- **E-11** Recommender valid prompt: `POST /api/recommend/workload` => `200`, outputs only `RTX_5090` and `A100_80GB`.
- **E-12** Recommender repeatability: same prompt 3x produced same top pick/metrics tuple.
- **E-13** Unsupported/vague/injection prompts: no unsupported GPU output and no prompt/system leakage observed.
- **E-14** `POST /workspaces/launch` twice with same `intent` produced two different `workspace_id` values.
- **E-15** `POST /workspaces/:id/terminate` => `500 ECONNREFUSED ::1:5001` with stack trace.
- **E-16** Cross-tenant workspace fetch blocked logically but returns `500` with stack (`No Workspace found`) instead of safe `404`.
- **E-17** Outbox evidence: `APPLICATION_IN_REVIEW` and `APPLICATION_ACCEPTED` queued rows present.
- **E-18** Author audit evidence: `CUSTOMER_APPROVE` and `CUSTOMER_REJECT` entries present.
- **E-19** Abuse limits: recommender hammered 130x -> `100` success + `30` rate-limited (`429`).
- **E-20** Webhook authenticity: unsigned `/billing/webhook` rejected with `400`.
- **E-21** Preflight run failed: missing critical env vars, gateway down, 34 stuck workspaces, worker count anomaly.
- **E-22** DB status sample: large backlog of `CREATING` and `TERMINATING` workspaces.

---

## Findings By Severity

### P0
1. Duplicate workspace creation on repeated launch intent (idempotency gap).
2. Terminate path hard-fails when gateway unavailable; workspace lifecycle safety compromised.
3. Billing settlement path incomplete (`emitStripeUsage` TODO + log-only behavior).
4. Significant stuck workspace backlog indicates cleanup/recovery weakness.
5. Backup/restore drill not validated.

### P1
1. Stack traces leak in error payloads (`CORS`, rate-limit, not-found paths in dev runtime).
2. CSRF protection behavior depends on runtime mode; sensitive mutation succeeded without CSRF token in tested environment.
3. Cross-tenant blocked reads return `500` instead of clean `404/403`, exposing internals.

### P2
1. Recommender warning text for vague prompts is noisy/repetitive.
2. API integration suite reliability is low under current local process orchestration.

---

## Full Pass/Fail Sheet

### Section 1: Authentication and Access Control
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| AUTH-01 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-01, E-02, E-03, E-04 | Protected UI/API routes blocked when unauthorized or wrong role. |
| AUTH-02 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-01, E-02, E-03, E-04, E-05 | Guest/applicant/customer/author gating works in tested paths. |
| AUTH-03 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-03 | Normal customer blocked from author APIs server-side. |
| AUTH-04 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-04 | Applicant cannot access approved customer routes. |
| AUTH-05 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-06 | Session invalidated after logout. |
| AUTH-06 | P1 | Backend Engineer | Needs Work | 2026-03-11 | local | Static config review | Cookie flags appear correct in code, but prod runtime proof missing. |
| AUTH-07 | P1 | Backend Engineer | Needs Work | 2026-03-11 | local | E-09, E-19 | Rate limits trigger, but error payloads leak stack in this runtime mode. |

### Section 2: Manual Approval Flow
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| APPROVAL-01 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-04, E-17 | New account enters `PENDING_REVIEW`. |
| APPROVAL-02 | P0 | Frontend Engineer | Pass | 2026-03-11 | local | E-04 | Review state enforced on direct route access. |
| APPROVAL-03 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-17 | Outbox enqueue verified; external delivery not proven. |
| APPROVAL-04 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-07, E-17, E-18 | Approval state updates and unlock verified; delivery proof for approval email still missing. |
| APPROVAL-05 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-05, E-18 | Rejected users stay blocked. |
| APPROVAL-06 | P1 | Backend Engineer | Pass | 2026-03-11 | local | Re-approve returned `400` | Duplicate review attempts blocked; no duplicate state transition seen. |
| APPROVAL-07 | P1 | Backend Engineer | Pass | 2026-03-11 | local | E-18 | Approve/reject actions recorded in author audit. |

### Section 3: Admin Dashboard Safety
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| ADMIN-01 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-03 | Non-admin access rejected on author routes/APIs. |
| ADMIN-02 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-07 | Validation exists for approve/reject payloads, but CSRF and broader dangerous-action coverage incomplete. |
| ADMIN-03 | P1 | Frontend Engineer | Needs Work | 2026-03-11 | local | Not executed | Double-click/refresh destructive action protection not proven end-to-end. |
| ADMIN-04 | P1 | Backend Engineer | Fail | 2026-03-11 | local | E-08, E-09, E-15, E-16 | Stack traces leak internals in API error responses. |

### Section 4: Customer Portal Functionality
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| PORTAL-01 | P0 | Frontend Engineer | Needs Work | 2026-03-11 | local | E-16 | Cross-account read was blocked, but returned 500+stack; must return safe 404/403. |
| PORTAL-02 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-14 | Duplicate launch created two workspaces for same intent. |
| PORTAL-03 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-15 | Terminate failed with 500 when gateway unavailable; clean stop path not reliable. |
| PORTAL-04 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-21, E-22 | Failure cleanup not reliable; stuck workspace backlog persists. |
| PORTAL-05 | P1 | Frontend Engineer | Needs Work | 2026-03-11 | local | Not executed | Reload/state synchronization during provisioning not fully validated. |

### Section 5: GPU Inventory and Provisioning
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| PROVISION-01 | P0 | Infra Engineer | **Fail** | 2026-03-11 | local | Service code + E-14 | Launch path creates records before proven reservation in tested flow. |
| PROVISION-02 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Last-GPU race test not completed with real fleet contention. |
| PROVISION-03 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Static inspection | Full reserve->provision->network->running proof absent in this environment. |
| PROVISION-04 | P0 | Infra Engineer | **Fail** | 2026-03-11 | local | E-21, E-22 | Midway failure cleanup insufficient; many stuck records remain. |
| PROVISION-05 | P0 | Infra Engineer | Pass | 2026-03-11 | local | Static review | No external GPU provider path observed in active code paths. |
| PROVISION-06 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-11, `/api/public/gpu-skus` | Supported flows expose only RTX 5090 and A100N/A100_80GB. |
| PROVISION-07 | P1 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Warm pool isolation reuse safety not validated. |

### Section 6: Billing and Usage Metering
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| BILLING-01 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | Static inspection | Start trigger policy not proven against real lifecycle events. |
| BILLING-02 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-15 | Stop rule cannot be trusted while terminate flow fails in gateway outage. |
| BILLING-03 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | `emitStripeUsage` TODO | Invoice-to-meter exactness cannot be proven with log-only stripe path. |
| BILLING-04 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | Not executed | Provision-fail no-charge path not proven end-to-end. |
| BILLING-05 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-14 + static | Duplicate launch/idempotency gap increases duplicate usage/billing risk. |
| BILLING-06 | P1 | Backend Engineer | Needs Work | 2026-03-11 | local | Not executed | Active-session pricing change behavior unproven. |

### Section 7: Recommender Safety and Accuracy
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| REC-01 | P0 | QA / Founding | Pass | 2026-03-11 | local | E-11 | Supported prompts produce supported hardware only. |
| REC-02 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-11, E-12 | Output consistency and internal math appear stable in sampled runs. |
| REC-03 | P0 | QA / Founding | Pass | 2026-03-11 | local | E-13 | Vague/unsupported prompts returned safe non-committal output (no fake GPU plans). |
| REC-04 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-13 | Injection attempts did not leak hidden/system data in tested prompts. |
| REC-05 | P1 | QA / Founding | Pass | 2026-03-11 | local | E-12 | Repeated prompt stable across three runs. |

### Section 8: Tenant Isolation and Network Security
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| ISOLATION-01 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | E-16 | Access blocked but response leaks internals via 500; must return safe denial. |
| ISOLATION-02 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Pod-to-pod network isolation not proven without live tenant VMs. |
| ISOLATION-03 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | E-21 | Port exposure/management interface hardening not validated in prod-like net. |
| ISOLATION-04 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Storage wipe/reinit after termination not proven. |
| ISOLATION-05 | P1 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Temporary credential rotation/destruction not proven. |

### Section 9: Secrets, API Security, and Input Validation
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| API-01 | P0 | Backend Engineer | Pass | 2026-03-11 | local | Secret-pattern scan | No obvious hardcoded production secrets found in scanned source paths. |
| API-02 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-08, E-09, E-16 | Invalid/malicious paths can return stack traces instead of sanitized errors. |
| API-03 | P0 | Frontend Engineer | Needs Work | 2026-03-11 | local | E-13 + limited checks | No immediate execution seen in sampled prompts, but broad UI XSS sweep incomplete. |
| API-04 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-07 | Sensitive author mutation executed without CSRF token in tested runtime mode. |
| API-05 | P1 | Backend Engineer | Needs Work | 2026-03-11 | local | E-09, E-19 | Rate limits present but hardening required for consistent safe responses. |

### Section 10: Database Integrity and Backup Recovery
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| DATA-01 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-16 | Ownership check blocks access, but improper 500 handling leaks internals. |
| DATA-02 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | Static review | Approval flow transactional; provisioning/billing transactional safety still incomplete in failure paths. |
| DATA-03 | P0 | Infra Engineer | **Fail** | 2026-03-11 | local | No restore evidence | Backup restore drill not executed/proven. |
| DATA-04 | P1 | Backend Engineer | **Fail** | 2026-03-11 | local | E-21, E-22 | Orphan/stuck records present; lifecycle cleanup incomplete. |

### Section 11: Logging, Monitoring, and Alerts
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| OBS-01 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-18 + securityLog query | Some critical events logged; full required event matrix not fully proven. |
| OBS-02 | P0 | Backend Engineer | **Fail** | 2026-03-11 | local | E-08, E-09, E-15, E-16 | Sensitive internals/stack traces exposed in responses. |
| OBS-03 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | Alerting on auth/provisioning/billing failures not demonstrated. |
| OBS-04 | P1 | Infra Engineer | Needs Work | 2026-03-11 | local | Partial DB/log checks | End-to-end traceability to user+GPU+billing not fully proven. |

### Section 12: Failure and Recovery
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| FAIL-01 | P0 | Infra Engineer | **Fail** | 2026-03-11 | local | E-22 + stuck states | Recovery to safe state not demonstrated; stuck resources indicate gaps. |
| FAIL-02 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | DB restart chaos test not performed. |
| FAIL-03 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | Outbox only | Email failure surfacing path not fully simulated. |
| FAIL-04 | P0 | Infra Engineer | Needs Work | 2026-03-11 | local | Not executed | GPU host offline handling not tested with live fleet host. |
| FAIL-05 | P1 | Frontend Engineer | Needs Work | 2026-03-11 | local | Not executed | Sold-out inventory UX path not validated end-to-end. |

### Section 13: Abuse Prevention
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| ABUSE-01 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-09 | Signup/forgot limits trigger, but responses leak stack in this runtime mode. |
| ABUSE-02 | P0 | Backend Engineer | Needs Work | 2026-03-11 | local | E-19 | Recommender endpoint rate-limited; provisioning abuse controls not fully demonstrated. |
| ABUSE-03 | P0 | Backend Engineer | Pass | 2026-03-11 | local | E-20 | Unsigned webhook rejected. |

### End-to-End Required Flows
| Test ID | Priority | Owner | Status | Date Tested | Env | Evidence | Notes / Fix Needed |
|---|---|---|---|---|---|---|---|
| E2E-01 | P0 | QA / Founding | Pass | 2026-03-11 | local | E-04, E-17 | Signup enters review state and stays gated. |
| E2E-02 | P0 | QA / Founding | Needs Work | 2026-03-11 | local | E-07, E-17 | Approval unlock verified; external approval-email delivery not proven. |
| E2E-03 | P0 | QA / Founding | **Fail** | 2026-03-11 | local | E-05 + route review | Rejection gating works, but rejection email send path is not proven/implemented in tested flow. |
| E2E-04 | P0 | QA / Founding | **Fail** | 2026-03-11 | local | E-14, E-22 | Launch creates DB rows but clean running lifecycle/billing start proof missing. |
| E2E-05 | P0 | QA / Founding | **Fail** | 2026-03-11 | local | E-21, E-22 | Failed launch cleanup not reliable. |
| E2E-06 | P0 | QA / Founding | **Fail** | 2026-03-11 | local | E-15 | Stop/terminate flow failed with 500 in tested state. |
| E2E-07 | P0 | QA / Founding | Needs Work | 2026-03-11 | local | Not executed | Real last-GPU race test not completed with constrained live inventory. |
| E2E-08 | P0 | QA / Founding | Pass | 2026-03-11 | local | E-03, E-04, E-05 | Access-control attack paths blocked in tested cases. |
| E2E-09 | P0 | QA / Founding | **Fail** | 2026-03-11 | local | Billing TODO + no invoice proof | Billing exactness not proven against metering/invoice logs. |
| E2E-10 | P0 | QA / Founding | Pass | 2026-03-11 | local | E-11, E-13 | Recommender returned supported/safe outputs in tested scenarios. |

---

## Open Risks Still Not Fixed
1. Gateway dependency outage causes terminate failure and error leakage.
2. Provisioning lifecycle leaves stuck records under failure/retry pressure.
3. Billing path is not fully production-complete for charge reconciliation.
4. CSRF behavior in non-production mode can hide production-grade gaps if not tested in staging.
5. Infrastructure controls (fleet contention, network isolation, backup restore, host failure alerts) remain unproven in a prod-like environment.

## Required Before Re-Review
1. Fix launch idempotency (`intent` must dedupe).
2. Make terminate resilient to gateway failures and always fail-safe without stack leakage.
3. Complete Stripe metering path and prove invoice parity on timed sessions.
4. Sanitize all error responses (no stack traces to clients in any externally reachable environment).
5. Run full P0 infra tests in staging/prod-like environment (Proxmox + gateway + worker + alerts + restore drill).
