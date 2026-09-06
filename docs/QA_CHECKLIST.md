# QA Checklist — Cumulative Post-Merge Status

**Branch:** `main`
**Release:** `v7.6.0` — P0 Item 2 Durable-State Remediation & Operational Safety Invariants
**Scope:** Strict durable-state gate enforcement, fail-closed 503 response contracts, durable Slack interactivity handoff, production rate-limiter fail-closed rules, and test suite expansion.

---

## 🏗 Build & Local Verification

- [x] `npm install` — completes without errors
- [x] `npm run lint` (`tsc --noEmit`) — zero type errors
- [x] `npm run build` — Vite frontend + esbuild backend compile successfully
- [x] `npm test` — all suites pass
- [x] `npm run test:coverage` — review coverage report for gaps
- [x] `npm start` (or `node dist/server.cjs`) — server starts on port 3000
- [x] No new `npm audit` vulnerabilities introduced (`npm audit --omit=dev --audit-level=moderate`)

---

## 🧪 Test Suite Verification

40 test files / 483 tests total. Key suites (full matrix in the [README](../README.md#-test-suite)):

| Suite | File | Cases | Status |
|-------|------|:-----:|:------:|
| Durable State Outage Remediation | `tests/durable-state-outage.test.ts` | 6 | [x] |
| Schema Readiness | `tests/readiness.test.ts` | 3 | [x] |
| Rate Limit Store | `tests/rateLimitStore.test.ts` | 13 | [x] |
| AI Response | `tests/ai.test.ts` | 5 | [x] |
| Intent Classification | `tests/intent.test.ts` | 16 | [x] |
| Policy Gate | `tests/policy.test.ts` | 7 | [x] |
| Secret Sanitization | `tests/sanitize.test.ts` | 11 | [x] |
| Structured Logger | `tests/log.test.ts` | 4 | [x] |
| Interactivity Authorization | `tests/interactivity-authorization.test.ts` | 6 | [x] |
| Deferral Detection | `tests/deferral.test.ts` | 10 | [x] |
| Agent Loop (Closed) | `tests/loop.test.ts` | 6 | [x] |
| Agent Extras (plan mutation, semaphore leases) | `tests/agent-extra.test.ts` | 27 | [x] |
| Auth Lockout | `tests/auth.test.ts` | 13 | [x] |
| Redis Client | `tests/redis.test.ts` | 40 | [x] |
| SSRF Guard | `tests/ssrfGuard.test.ts` | 18 | [x] |
| Web Fetch Adapter SSRF | `tests/webFetch.test.ts` | 7 | [x] |
| Email Adapter | `tests/tools/adapters/email.test.ts` | 8 | [x] |
| GitHub Issue Adapter | `tests/tools/adapters/githubIssue.test.ts` | 8 | [x] |
| Database Storage Pools | `tests/server/storage/db.test.ts` | 21 | [x] |
| Vercel Integration (incl. permit & 429 policy) | `tests/vercel.test.ts` | 22 | [x] |

---

## 🔒 P0 Item 2 Remediation & Operational Invariants

### 1. Shared Durable-Dependency Readiness Gate
- [x] `requireDurableDependencies()` in `src/server/storage/readiness.ts`
- [x] Respects `REQUIRE_DURABLE_STATE` and `REQUIRE_REDIS` (both default to true in production)
- [x] Verifies database connection & schema readiness
- [x] Verifies Redis configuration and live `pingRedis()`
- [x] Throws typed `DurableStateError` with non-sensitive messages and status 503

### 2. Direct Production Entrypoints Protection
- [x] `api/workflows/agentRun.ts` — protected with `requireDurableDependencies()` at start
- [x] `api/cron/poll.ts` — protected with `requireDurableDependencies()` at start
- [x] `server.ts` — express middleware enforces `requireDurableDependencies()` across `/api/*` routes
- [x] `src/server/routes.ts` — `/slack/events`, `/slack/interactivity`, `/agent/*` protected

### 3. Slack Interactivity Durable Handoff
- [x] `POST /slack/interactivity` verifies signature and authorization first
- [x] Performs synchronous atomic approval resolution and audit event write in database
- [x] Returns HTTP 200 ONLY after durable database write succeeds
- [x] Returns HTTP 503 if database/Redis fails; never relies on `waitUntil` or process memory for acknowledgment

### 4. Rate-Limiter Fail-Closed Rules
- [x] `validateEnv()` fails startup if required Redis configuration is missing in production
- [x] `KvRateLimitStore` throws `DurableStateError` (503) on Redis outages in strict mode
- [x] Production never passes `undefined` store or uses Express `MemoryStore` as a fallback

### 5. Universal Orchestration Precondition
- [x] `runAgentPipeline()` in `src/server/agent/orchestrator.ts` verifies `requireDurableDependencies()`
- [x] Rejects with `DurableStateError` before dispatching any agent handlers when durable state is down
- [x] No side-effects (Slack replies, tool calls, DB writes) execute during outages

### 6. Operational Rollback Guidance
- [x] Preferred operational rollback is an **immutable deployment rollback** to a known-good release
- [x] Setting `REQUIRE_DURABLE_STATE=false` or `REQUIRE_REDIS=false` is documented as an **emergency-only break-glass procedure** requiring explicit leadership approval, time limits, monitoring, and incident ownership.

---

## ✅ Final Sign-Off

| Area | Reviewer | Date | Status |
|------|----------|------|--------|
| Build & Tests | Automated | 2026-08-23 | [x] |
| P0 Item 2 Remediation | Automated | 2026-08-23 | [x] |
| Security & Operational Invariants | Automated | 2026-08-23 | [x] |
| Documentation | Automated | 2026-08-23 | [x] |

**Merge Decision:** [x] Approved
