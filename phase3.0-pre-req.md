# Gap Closure Plan — Pre-Phase 3.0

## Sprint A — Quick Wins (hour-level fixes)

| Task | File | Effort |
|------|------|--------|
| **A1** Fix stale policy test | `tests/policy.test.ts:25` — change `toBe(false)` → `toBe(true)` | 1 min |
| **A2** Add `PORT` env var fallback | `server.ts:18` — `process.env.PORT || 3000` | 1 min |
| **A3** Make approval expiry configurable | `loop.ts:111`, `executor.ts:233` — extract `APPROVAL_EXPIRY_MS` | 5 min |
| **A4** Make `MAX_ITERATIONS` configurable | `loop.ts:12` — `process.env.MAX_ITERATIONS || 3` | 2 min |
| **A5** Make worker poll interval configurable | `worker.ts:94` — `process.env.WORKER_POLL_MS || 2000` | 2 min |
| **A6** Add `resetClient()` to geminiClient | `geminiClient.ts` — allow API key rotation without restart | 5 min |
| **A7** Update `.env.example` | Add all missing env vars documented in code | 5 min |

## Sprint B — Medium Impact (half-day fixes)

| Task | File(s) | Details |
|------|---------|---------|
| **B1** Graceful shutdown drains in-flight runs | `server.ts:62-79` | Add `Promise.allSettled(inFlightRuns)` before `closeDb()`, with configurable drain timeout |
| **B2** CSP re-enabled in production | `server.ts:25` | `contentSecurityPolicy: process.env.NODE_ENV === 'production' ? { directives: { defaultSrc: ["'self'"] } } : false` |
| **B3** `finalizeRun()` made transactional | `src/server/agent/finalize.ts` | Use raw `pg` client or a DB-side transaction to atomically update run status + goal status + append audit event |
| **B4** Health check with DB + worker probes | `src/server/routes.ts:71` | Add DB ping, worker `isAlive`, scheduler `isAlive` to `/api/status` |
| **B5** Input length validation enforced at middleware | `server.ts:46,54` | Cap `express.json({ limit: '2mb' })` to a smaller limit for Slack events specifically |

## Sprint C — Observability Overhaul (1-2 days)

| Task | Files | Details |
|------|-------|---------|
| **C1** Migrate 32 `console.*` to `slog()` | All files | Systematic sweep — every `console.log/error/warn` becomes `slog(module, event, data)` |
| **C2** Request correlation IDs | `server.ts` + `routes.ts` | Express middleware that attaches `X-Request-Id` header, stores on `req`, passes through to agent pipeline |
| **C3** Basic Prometheus metrics | New `src/server/metrics.ts` | Counters for: runs started/completed/failed, Gemini latency, tool execution latency, error rate by type. Expose at `/api/metrics` |

## Sprint D — Security (1 day)

| Task | Files | Details |
|------|-------|---------|
| **D1** Move brute-force lockout to DB | `src/server/auth.ts` | Replace `Map<string, AuthAttempt>` with `failed_login_attempts` table and periodic cleanup |
| **D2** Add idempotency key to background processing | `src/server/routes.ts` | Store `eventId` in `processed_events` before `setImmediate`, check before executing pipeline |
| **D3** Concurrent approval resolution guard | `src/server/routes.ts:173-358` | Use DB-level `SELECT ... FOR UPDATE` or optimistic lock with status check |

## Sprint E — Test Coverage (1-2 days, ongoing)

| Task | Files |
|------|-------|
| **E1** Add unit tests for `agentStore.ts` (critical queries) | `tests/agentStore.test.ts` |
| **E2** Add unit tests for `worker.ts` (queue processing, lease management) | `tests/worker.test.ts` |
| **E3** Add unit tests for `geminiClient.ts` (retry logic, timeout) | `tests/geminiClient.test.ts` |
| **E4** Add unit tests for `routes.ts` (auth, model selection, event handlers) | `tests/routes.test.ts` |
| **E5** Expand `vitest.config.ts` coverage scope | Include `src/server/storage/**`, `src/server/tools/**`, `src/server/auth.ts` |

---

## Recommended Execution Order

**Phase 0 — Immediate (before any other work):**
- A1 (fix test), A2 (PORT env), A7 (env.example)

**Phase 1 — Sprint A + B (before Phase 3.0):**
- All of Sprint A and Sprint B — these are safety and config gaps that make Phase 3.0 development smoother

**Phase 2 — In parallel with Phase 3.0:**
- Sprints C, D — observability and security are cross-cutting and don't block feature work
- Sprint E — test as you go
