# Changelog

All notable changes to this project will be documented in this file.

## [6.2.0] - Production Reliability & Feedback Fixes - 2026-06-27

Resolves the remaining critical and high-priority issues identified during Vercel production deployment analysis, plus a batch of low-priority edge-case fixes.

### 🔴 Critical Fix

* **Slack interactivity signature verification (Fix 6).** `express.urlencoded()` in `server.ts` now includes a `verify` callback that captures `req.rawBody` for URL-encoded payloads, matching the existing `express.json()` parser. All Block Kit button clicks (Approve/Reject) were returning 401 in production because the HMAC was computed over an empty body. Now works in production.

### 🐛 High-Priority Bug Fixes

* **`slack.ts` respects dashboard model selection (Fix 7).** `src/server/tools/slack.ts` now imports `selectedModel` from the state module instead of reading `process.env.SELECTED_MODEL` (always `undefined`). The auto-reply synthesis path now uses the user's chosen model.
* **Fire-and-forget async calls now awaited (Fix 8).** Four previously-unawaited async calls — two `addLog()` calls in `routes.ts`, one `updateLog()` in `agentRun.ts`, and a dynamic `import()` in the dashboard approval handler — are now properly awaited with error handling.
* **`enqueueRunTask` no longer silently swallows errors (Fix 9).** `taskClient.ts` changed from `Promise<void>` to `Promise<boolean>`. `durableTask.ts` checks the return value and throws on failure, which marks the run as `failed` instead of leaving it stranded in `queued` forever with a misleading "I have accepted your goal" reply.
* **Dashboard approval handler wrapped in `waitUntil` (Fix 10).** The `POST /agent/approvals/:id/resolve` route wraps the dynamic import and pipeline resume in `waitUntil()`, matching the interactivity handler pattern. Prevents Vercel from freezing the function before pipeline resume completes.
* **`setInterval` guarded for Vercel serverless (Fix 11).** Two `setInterval` calls in `state.ts` (dedup cache eviction, DB cleanup) are now guarded with `if (process.env.VERCEL !== '1')`. The DB `processed_events` cleanup was moved to the Vercel Cron handler as a replacement.
* **Step-level approval resume fixed (Fix 18).** `resumeAgentPipeline()` in `orchestrator.ts` now resets any blocked steps to `pending` before re-queuing the run. Previously, approving a tool call silently skipped the blocked step because `runLoop()` only processes steps with status `pending`.

### 🟡 Medium-Priority Fixes

* **DB pool serverless optimization (Fix 7).** Increased `connectionTimeoutMillis` from 5000 to 10000 (configurable via `DB_CONNECTION_TIMEOUT`). Added retry logic to `query()` with 2 attempts and exponential backoff for transient connection errors.
* **Vercel-optimized build script (Fix 8).** Added `"vercel-build": "vite build"` to `package.json`, skipping the esbuild CJS backend bundle (unused on Vercel) during deployment.
* **Node engine requirement declared (Fix 9).** Added `"engines": { "node": ">=18.0.0" }` to prevent silent breakage on older runtimes.
* **Complete `.env.example` (Fix 10).** Added all missing documented variables: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DASHBOARD_PASSWORD`, `DATABASE_SSL`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT`, `DIRECT_REPLY_CONCURRENCY`, `RUN_TIMEOUT_MS`, `WORKER_LEASE_SECONDS`, `GEMINI_TIMEOUT_MS`, `VERCEL_AUTOMATION_BYPASS_SECRET`.
* **`require()` replaced with `await import()` in ESM module (Fix 11).** `scheduler.ts` replaced `require('cron-parser')` with `await import()`, making `computeNextRunAt` async. Fixes a correctness issue in the ESM module context.

### 🟢 Low-Priority Fixes

* **`waitUntil` lambda error handling (Fix 12).** The interactivity handler's `waitUntil` lambda now wraps its body in `try/catch` and awaits `resumeAgentPipeline()` instead of fire-and-forget with `.catch()`.
* **Timer leak in executor (Fix 13).** The `Promise.race` timeout in `executor.ts` is now wrapped in `try/finally` to always clear the timeout, preventing timer leaks when a tool rejects before the timeout fires.
* **"Tomorrow" before 9 AM off by ~1h (Fix 14).** Removed the `Math.min(delta, MS_DAY)` cap in `msUntilTomorrow9am()` so "tomorrow" always means the next calendar day at 9 AM, even when more than 24h away.
* **Single-letter time units supported (Fix 15).** Added pre-processing `.replace()` calls that normalize `10m`→`10 minutes`, `2h`→`2 hours`, etc. before deferral pattern matching.
* **"Let me know in X" deferral pattern (Fix 16).** Added `know` and `let` to `hasActionContext()` regex to catch "let me know in 2 hours".
* **Connector socket leak (Fix 17).** Both `connector = new Connector()` calls in `db.ts` are now guarded with `if (!connector)` to prevent overwrite and socket leak when both admin and regular pools use Cloud SQL Connector.

### 📊 Observability

* **Confidence type mismatch resolved.** `IntentResult.confidence` (`'high' | 'medium' | 'low'`) was being passed directly to the DB column `slack_event_logs.confidence` (type `numeric`), causing `invalid input syntax for type numeric: "high"` on every workflow invocation. Added `confidenceToNumber()` mapping (`high→1.0`, `medium→0.5`, `low→0.0`) and updated the `SlackEventLog` type to `number`.
* **Semaphore acquire timeout.** `Semaphore.acquire()` now accepts an optional `timeoutMs` parameter (10s for direct reply concurrency). If no permit is available within the window, the caller logs a warning and proceeds without blocking.
* **`runLoop` entry/exit instrumentation.** Added `slog('loop', 'runLoop.start', ...)` and `slog('loop', 'runLoop.complete', ...)` (in a `finally` block) so every `runLoop()` invocation leaves a visible trace in Vercel logs with elapsed time and final run status.

### ✅ Verification

* `npm run lint` — 0 type errors.
* `npm test` — 11 files, 94 tests pass.
* All fixes deployed to production and verified in Vercel logs.

## [6.1.0] - Vercel Stability Hardening - 2026-06-27

Resolves five reliability gaps discovered during Vercel serverless deployment testing.

### 🐛 Bug Fixes

* **Model selection now resolves on cold start (Fix 1).** `agentRun.ts` calls `getSelectedModel()` at handler bootstrap so the user's dashboard-selected Gemini model is used instead of the module default on every Vercel cold start. The old behavior silently pinned all workflow runs to `gemini-3.1-flash-lite` regardless of dashboard selection.
* **Interactivity handler no longer drops async work (Fix 2).** The `POST /api/slack/interactivity` route wraps approval resolution and pipeline resumption in `waitUntil()` from `@vercel/functions`, preventing Vercel from terminating the function before async work completes.
* **Workflow triggers retry on transient failures (Fix 3).** `enqueueRunTask()` now retries 3 times with exponential backoff (1s → 2s → 4s) on network errors and 5xx responses. Client errors (4xx) are not retried. Previously, any `fetch` failure silently dropped the task.
* **Stale lease reclamation wired into cron (Fix 4).** `recoverStaleClaims()` and `reapExpiredApprovals()` — both defined in `agentStore.ts` but never called — now run at the start of every Vercel Cron cycle and on workflow handler startup. Runs abandoned by terminated serverless invocations are reclaimed and re-queued.
* **Cooperative timeout guard prevents hard termination (Fix 5).** `runLoop()` checks elapsed wall-clock time before plan creation, each step execution, and verification. When the configurable `RUN_TIMEOUT_MS` (default 45s) is approached, the run is gracefully re-queued for the next invocation instead of being hard-killed by the Vercel serverless timeout (60s Pro / 15s Hobby).

### 🧪 Tests

* Added 5 new test cases in `tests/vercel.test.ts` covering:
  - Stale claim recovery and approval expiration in the cron handler (Fix 4)
  - Retry-success, retry-exhaustion, and 4xx-no-retry for `enqueueRunTask` (Fix 3)
  - `getSelectedModel()` call during workflow handler bootstrap (Fix 1)
  - Timeout guard re-queuing in `runLoop()` (Fix 5)
* Updated mocks for `agentStore` (added `recoverStaleClaims`, `reapExpiredApprovals`, `updateGoalStatus`, lease, and step operations) and `state` (added `getThreadHistory`, `saveThreadHistory`).
* Full suite: 94 tests passing across 11 test files; `tsc --noEmit` clean.

## [5.0.0] - Google Cloud Tasks Migration & Resilience Hardening - 2026-06-24

Migrates the background processing system to Google Cloud Tasks for serverless task execution and hardens error boundaries for Slack API calls (approvals and reports).

### 🚀 Features & Infrastructure
* **Google Cloud Tasks Integration:** Replaced legacy in-memory `setInterval` polling loops in `worker.ts` and `scheduler.ts` with serverless executions triggered by Google Cloud Tasks webhooks.
  * Added `src/server/agent/taskClient.ts` to enqueue task execution requests to Google Cloud Tasks.
  * Exposed authenticated internal webhook endpoints: `POST /api/internal/worker/execute` for running tasks and `POST /api/internal/scheduler/poll` for evaluating scheduled triggers.
  * Added configuration environment variables: `GCP_PROJECT_ID`, `GCP_LOCATION`, `CLOUD_TASKS_QUEUE_NAME`, and `INTERNAL_API_SECRET`.
  * Decommissioned `setInterval` tasks in the worker and scheduler, keeping lifecycle hooks as lightweight stubs.

### 🛡️ Error Handling & Hardening
* **Slack Approval Posting Safety:** Wrapped `postApprovalBlockKit` in try-catch in both the plan loop (`loop.ts`) and step execution (`executor.ts`). If posting to Slack fails (e.g. invalid message TS, slack timeout), the approval is marked as `failed` in the database, and the run fails with a user-facing Slack message instead of hanging indefinitely.
* **Slack Reporting Resilience:** Wrapped final `reportRunResult` in a try-catch block inside `finalize.ts`. If posting the rich execution report fails, it falls back to a simpler status notification and logs details via `slog` at the error level to prevent silent run execution hangs.

### 🐛 Bug Fixes
* Fixed concurrency issues where multi-instance deployments could double-claim or clash on runs by delegating scheduling and execution orchestration entirely to Cloud Tasks queues.

## [4.4.0] - Agentic base fixes (multistep & planning reliability) - 2026-06-22

Fixes the durable-task plan-and-execute pipeline, which frequently failed on
multistep and planning workflows in Slack. Branch: `agentic-base-fix`.

### 🐛 Bug Fixes
* **Planner tool hallucinations no longer fail or over-gate the whole plan (WS2).**
  Introduced `planNormalize.ts`: unknown/unavailable tool names are degraded to a
  safe `note` step (only that step is flagged) instead of redacting it into a
  no-tool step that the executor failed and poisoning the entire plan to
  `external_write` + `requiresApproval`. Plan `requiresApproval` is now derived
  from whether any executable step actually maps to an external_write tool, and
  free-text `riskLevel` values from the model (e.g. "low"/"medium"/"high") are
  coerced to the strict `AgentRiskLevel` enum. `generate` steps are guaranteed a
  prompt, and `kind`-in-`toolName` mistakes are normalised.
* **Multistep state isolation (WS3).** Upstream-output gathering, the
  `slack.replyInThread` auto-injection, and the empty-reply fallback now scope to
  the current plan iteration (`plan_id`) instead of `getStepsForRun`, which mixed
  steps across abandoned replans (whose `order_index` restarts at 1) and caused
  wrong/blank replies.
* **Verification & replan control loop (WS4).** Transient failures (e.g. a failed
  Slack post) now retry the failed steps within the same plan (bounded by
  `MAX_TRANSIENT_RETRIES`) instead of discarding the plan. Genuine replans and
  retries re-queue the run (lease-safe) rather than recursing via `setImmediate`,
  which executed the run untracked and could double-execute on lease recovery.
  Semantic-verifier verdicts only trigger a replan when confidence ≥ 0.5; errors
  and empty responses are treated as inconclusive (defer to rule-based verifier)
  instead of forcing a replan. Added `agent_runs.retry_count` (migration v4).
* **Accurate run reports (WS5).** `buildRunReport` now reports only the latest
  plan iteration's steps, so abandoned earlier plans no longer appear as
  duplicate/failed noise in the Slack run report.
* **Time-deferred "tomorrow" capped (WS6).** `msUntilTomorrow9am` is capped at 24h
  so "remind me tomorrow" before 9am no longer schedules >24h out; fixes the
  failing `deferral` test.

### 🛡️ Hardening
* **Model configuration integrity (WS1).** New `agent/models.ts` is the single
  source of truth for allowed Gemini models with a `resolveModel()` safe
  fallback (`gemini-2.5-flash`). All LLM call sites (planner, executor generate
  step, intent classifier, semantic verifier, plan mutation, direct reply, Slack
  reply synthesis) and the persisted/selected model in `state.ts` + `routes.ts`
  now resolve through it, so an unreleased or corrupted model id can never throw
  a "model not found" error and cascade into multistep failure. (Note: the live
  model list confirms `gemini-3.1-flash-lite` and `gemini-3.5-flash` are served,
  so this is a guardrail, not the root cause.)

### 🧪 Tests / CI
* Added `tests/planNormalize.test.ts` and `tests/models.test.ts`; extended
  `tests/loop.test.ts` (retry vs replan, lease-safe re-queue, inconclusive
  semantic verdict) and `tests/reporter.test.ts` (plan-scoped report).
* `vitest.config.ts` binds its internal API server to `127.0.0.1` and uses the
  `forks` pool so the suite runs on a fresh clone with no `localhost` hosts entry.
* Full suite: 83 passing; `tsc --noEmit` clean; server bundle builds.

## [4.3.0] - Pre-merge QA Remediation - 2026-06-20

Resolves every gap found during the `version-3` pre-merge QA review. The branch
now passes its own CI gate (`npm run lint` + `npm test`) end-to-end.

### 🔒 Security Fixes
* **Secret sanitizer no longer leaks secrets.** `sanitizeString()` previously used
  a function replacer that, for patterns *without* capture groups (Slack `xoxb-`,
  OpenAI `sk-`, Google `AIza`, AWS `AKIA`), received `(match, offset, string)` and
  re-emitted the original secret-bearing text via the "suffix" argument. Rewrote
  the sanitizer as a table of `{ regex, stringReplacement }` rules using `$1`/`$2`
  backreferences, so a no-group pattern always collapses to `[REDACTED]`. All four
  opaque-token formats are now redacted; `tests/sanitize.test.ts` passes.

### 🐛 Bug Fixes
* **`tests/loop.test.ts` no longer crashes on load.** Replaced the top-level
  `const mock…` declarations referenced inside hoisted `vi.mock()` factories with a
  `vi.hoisted()` block (the consts were in the temporal dead zone). Added a default
  `getRun`/`getRunTrace` mock in `beforeEach` so `buildScopedTrace()` resolves in the
  verification path. All 4 Agent Loop cases now run and pass.
* **`npm run lint` is clean.** Added the required `provider: 'v8'` to the `coverage`
  block in `vitest.config.ts`, fixing the lone `tsc --noEmit` type error.
* **Approval expiry now matches spec.** Plan/tool approval requests expire after
  30 minutes (`executor.ts`, `loop.ts`) instead of 24 hours, matching the W3-C DoD
  and the documented interactive-approval flow.

### 📦 Dependencies
* Added `cron-parser@^5.6.0` to `dependencies`. It was referenced via
  `require('cron-parser')` in `scheduler.ts` (using the v5 `CronExpressionParser.parse`
  API) but never declared, so cron triggers silently fell back to the naive parser.
  Full cron expressions now compute accurate next-run times.
* Added `@vitest/coverage-v8@^3.2.4` to `devDependencies` so `npm run test:coverage`
  works out of the box.

### ✅ Verification
* `npm run lint` — 0 type errors.
* `npm test` — 8/8 suites, 72/72 tests pass.
* `npm run test:coverage` — runs successfully.
* `npm run build` — Vite + esbuild compile cleanly.
* `npm audit` — 0 vulnerabilities.

## [3.1.0] - Final W3+W4 DoD Completion - 2026-06-20

### ✨ Features

#### W4-F1: Time-Deferred Trigger Detection
* Created `src/server/agent/deferral.ts` with `detectDeferral()` utility.
* Patterns: "remind me in N hours/days", "remind me tomorrow", "follow up
  next week", "schedule this for tomorrow", and bare "in N units" with
  action-verb context guard.
* `durableTask.ts` now checks for deferral before creating a run. When
  detected, creates a `scheduled_trigger` (one-shot) instead of an
  immediate `queued` run. The scheduler poller fires the run at the
  scheduled time.
* Audit event `trigger.created` logged with delay and human-readable label.

#### W4-F9: Plan Mutation Wired into cancel_or_update Handler
* `cancelUpdate.ts` now sub-classifies messages as `cancel` vs `update`.
* Cancel patterns ("cancel", "stop", "abort", etc.) → existing cancel path.
* Everything else → calls `mutatePlan()` to modify pending steps in the
  active run's plan, producing an audit-visible `plan.mutated` event.
* Removed unused `'reorder'` action from `MutationInstruction` type.

#### Scheduler Upgrades
* `cron-parser` used for full cron expression support (dynamic require with
  graceful fallback to basic parsing if not installed).
* Scheduled runs now inherit the model from the goal's most recent run
  instead of hardcoding `gemini-3.1-flash-lite`.

### 🧪 Tests

#### W4-F6: Loop Integration Tests
* `tests/loop.test.ts` — 4 test cases covering the full closed loop:
  - Happy path (plan → execute → verify → succeed)
  - Semantic failure triggers replan via `setImmediate`
  - Max iterations (3) → run fails without creating a plan
  - Step blocked → run blocked and finalized

#### W4-F7: Migration Idempotency Tests
* `tests/migration.test.ts` — 9 static analysis tests:
  - All CREATE TABLE uses IF NOT EXISTS
  - All CREATE INDEX uses IF NOT EXISTS
  - All ADD COLUMN uses IF NOT EXISTS
  - All DROP TABLE/COLUMN uses IF EXISTS
  - Versions unique, ascending, positive integers
  - Every migration has name and non-empty SQL

#### W4-F1: Deferral Detection Tests
* `tests/deferral.test.ts` — 15 tests: "remind me", "follow up",
  "schedule this", unit normalization (mins/hrs), and 5 negative cases
  to prevent false positives.

### 🧹 Cleanup
* Added `getRunsForGoal()` to `agentStore.ts` for model inheritance.
* Removed dead `updateScheduledTriggerAfterRun()` and
  `disableScheduledTrigger()` store methods (superseded by atomic
  `DELETE + reinsert` pattern from v3.0.1).

## [3.0.1] - Pre-merge QA Bug Fixes - 2026-06-20

### 🔒 Security
* **Interactivity signature verification (W3-F7):** Extracted Slack HMAC-SHA256
  verification into a shared `verifySlackSignature()` helper. Both `/api/slack/events`
  and `/api/slack/interactivity` now verify request signatures, preventing forged
  approval/rejection actions.

### 🐛 Bug Fixes
* **Expired approval guard (W3-F9):** `resolveApproval()` now checks
  `status = 'pending' AND expires_at > now()`. Expired approvals can no longer be
  approved to execute external tools. Returns descriptive errors for already-resolved,
  expired, or not-found approvals.
* **Scheduler atomic claim (W4-F3):** `getDueScheduledTriggers()` now uses
  `DELETE ... FOR UPDATE SKIP LOCKED ... RETURNING *` for atomic trigger claiming.
  Multiple Cloud Run instances polling concurrently can no longer double-fire the same
  trigger. Recurring triggers are re-inserted with the next run time after successful
  claim; one-shot triggers are not re-inserted (effectively disabled).

## [3.0.0] - Weeks 3–4 (Real-World Action & Autonomy) - 2026-06-20

### Week 3: Real-World Action

#### W3-A: Exec-Time Content Generation (`generate` step kind)
* Added `StepKind` type (`'tool' | 'generate' | 'note'`) to `types.ts`.
* `executor.ts` now handles `kind: 'generate'` steps: calls Gemini at execution time
  with upstream step outputs as context, stores result in `output.generated`.
* Downstream `slack.replyInThread` steps auto-inject generated text when their
  `input.text` is empty, eliminating the "chat wrapper" problem where the planner
  would bake empty `input:{}` at plan time.
* Added `updateStepInput()` to `agentStore.ts` for runtime input patching.
* Updated `planner.ts` to teach the LLM about `generate` steps and build the tool
  catalogue dynamically from the live registry.

#### W3-B: External Adapter Framework + GitHub Issue Adapter
* Created `src/server/tools/adapters/` with `ExternalAdapter` interface (`base.ts`).
* Implemented `GitHubIssueAdapter` — creates issues via GitHub REST API when
  `GITHUB_TOKEN` is set. Declares `riskLevel: 'external_write'`.
* Implemented `EmailAdapter` — sends email via configurable webhook relay when
  `EMAIL_WEBHOOK_URL` is set.
* `registry.ts` now auto-registers configured adapters at startup and exposes
  `registerAdapter()` + `getAdapters()` methods.
* Planner prompt dynamically includes all registered tools.

#### W3-C: Block Kit Interactive Approvals
* `slack.ts` exports `postApprovalBlockKit()` — posts Approve/Reject buttons
  with the approval UUID in `action.value`.
* `executor.ts` calls `postApprovalBlockKit()` when policy blocks a tool.
* Added `POST /api/slack/interactivity` route to `routes.ts`:
  - Parses URL-encoded `payload` from Slack
  - Resolves approval in DB, updates Block Kit message (removes buttons)
  - Resumes pipeline on approve, cancels on reject
* `updateApprovalMessage()` replaces the button message with a resolved state.
* `updateApprovalMessageTs()` added to `agentStore.ts`.
* Updated `slack-manifest.json` with interactivity request URL.

#### W3-D: Action-Aware Reporting
* Rewrote `reporter.ts` with `buildRunReport(trace)` — generates a structured
  Slack message listing every step, its tool, outcome, generated content length,
  and resolved approvals.
* `finalize.ts` now calls `reportRunResult(trace)` instead of posting a generic
  "Task finished with status: X" message.
* Legacy `reportStatus()` preserved for backward compatibility.

### Week 4: Autonomy & Hardening

#### W4-A: Scheduled Triggers Poller
* Created `src/server/agent/scheduler.ts` with 15-second polling interval.
* `startScheduler()` / `stopScheduler()` lifecycle methods.
* `getDueScheduledTriggers()`, `updateScheduledTriggerAfterRun()`,
  `disableScheduledTrigger()`, `createScheduledTrigger()` added to `agentStore.ts`.
* Computes next run from cron (basic subset) or `interval_seconds`.
* Broken triggers are auto-disabled to prevent infinite error loops.
* `server.ts` starts the scheduler alongside the worker.

#### W4-B: Test Suite & CI Gate
* Added `vitest` as dev dependency with `vitest.config.ts`.
* Created 5 test files covering core agent modules:
  - `tests/intent.test.ts` — 11 heuristic classification tests
  - `tests/policy.test.ts` — 6 risk-level policy tests
  - `tests/sanitize.test.ts` — 8 secret detection / redaction tests
  - `tests/verifier.test.ts` — 6 rule-based verification tests
  - `tests/reporter.test.ts` — 8 action-aware report generation tests
* `package.json` scripts: `test`, `test:watch`, `test:coverage`.
* `cloudbuild.yaml` now runs `npm run lint` and `npm test` gates before Docker build.

#### W4-C: Natural Language Plan Mutation
* Created `src/server/agent/planMutation.ts` with `mutatePlan()`.
* Supports add/remove/replace/modify actions on pending steps.
* Uses Gemini structured output to interpret user instructions.
* Only pending steps can be mutated; succeeded/running/blocked are protected.
* All mutations are audit-logged with `plan.mutated` event type.

#### W4-D: Ops Hardening
* **Email adapter** — `src/server/tools/adapters/email.ts` (see W3-B).
* **Graceful shutdown** — `server.ts` handles SIGTERM/SIGINT: stops worker,
  stops scheduler, drains HTTP connections, closes DB pool.
* **Health endpoint** — `GET /api/health` returns `{ status: 'ok', uptime }`.
* `express.urlencoded()` middleware added for Slack interactivity payloads.

### Documentation
* Created `docs/intent-routing.md` — full architecture doc covering intent
  classification flow, step kinds, tool registry, approval flow, plan mutation,
  and scheduled triggers.
* Updated this CHANGELOG to cover all v3.0.0 deliverables.

## [2.1.0] - CI/CD Pipeline & Runtime Upgrades - 2026-06-19

### 🚀 Google Cloud Build CI/CD Modernization
* **Hardened Pipeline Configuration**: Restructured `cloudbuild.yaml` to run a fully automated container build, double-tagging pipeline (`COMMIT_SHA` and `:latest`), and deployment steps targeting the correct region (`us-west1`) and repository (`cloud-run-source-deploy`).
* **Cloud Run Metadata Cleanliness**: Transitioned from `gcloud run services update` to `gcloud run deploy` to allow clean specification replacements. Surgically purged a stale `run.googleapis.com/sources` annotation leftover from previous AI Studio source-based deployments, which had been blocking subsequent container-based builds.

### ⚙️ Runtime Environment Upgrades
* **Node.js Engine Upgrade**: Bumped the Dockerfile base images (`builder` and `runner` stages) from `node:20-alpine` to `node:22-alpine` to satisfy engine requirements of `@google-cloud/cloud-sql-connector` and ensure stable database connectivity.

### 🧹 Repo Pruning & Documentation
* **Stale Document Removal**: Purged untracked legacy specification file (`docs/weeks-1-2-spec.md`) to establish the current main branch as the absolute source of truth.
* **Deployment Guide**: Updated `README.md` to include comprehensive guides for setting up automated GCP Cloud Build triggers and resolving common annotation-related deployment conflicts.

## [2.0.0] - Weeks 1–2 (merged) - 2026-06-19

### ✨ Completed Deliverables (Weeks 1–2)

Both Week 1 (Trust & Correctness) and Week 2 (Agent Loop) have been successfully finalized, verified, and merged into the `main` branch.

#### Week 1 Epics

* **Unified Intent Classification (Epic W1-A)**:
  * Consolidated message intent routing into a centralized system within `src/server/agent/intent.ts`.
  * Removed legacy text categorization in `src/server/ai.ts`.
  * Introduced the `IntentResult` data structure to track intent, confidence score, and evaluation source (`heuristic`, `llm`, or `fallback`).
  * Enhanced frontend routing logic to correctly color-code intent labels by category in the Dashboard (e.g. `durable_task` vs `direct_reply`). 
* **Intent Handler Dispatch System (Epic W1-B)**:
  * De-cluttered `orchestrator.ts` by splitting logic into specialized isolated modules within `src/server/agent/handlers/`.
  * Created dedicated handlers for varying task categories: `directReply`, `statusQuery`, `cancelUpdate`, `unsafeUnsupported`, `approvalResponse`, and `durableTask`.
* **DB-Unavailable Fallback Logic (Epic W1-C)**:
  * Adjusted handlers and the core router in `routes.ts` to allow conversational operations (`direct_reply`) safely without a connected PostgreSQL instance.
  * Ensures Slack bot availability stays highly-resilient, cleanly refusing durable workflows with an explicit user notification rather than timing out or crashing when SQL instances restart or drop.
* **Honest Step Execution / No-Tool Blocking (Epic W1-D)**:
  * Hardened the step runner in `executor.ts` to detect unsupported and "no-tool" plans generated by the LLM. Step executions now explicitly fail unless explicitly marked as a conceptual step (`note` kind), preventing empty tasks from falsely reporting as completed.
* **Memory Secret Refusal (Epic W1-E)**:
  * Reinforced standard agentic boundaries with an intercepted credential pattern match. The application explicitly blocks "secret", "password", or "token"-esque entries into `memory.write` routines, keeping database entries compliant.
* **Orchestrator Context Wiring**:
  * Connected standard memory queries, agent states, pending approvals, and active runs checks via updated bindings inside `agentStore.ts`.

#### Week 2 Epics

* **Run Worker & Queue Semantics (Epic W2-A)**:
  * Severed the direct run execution sequence from the immediate HTTP request cycle.
  * Designed and implemented an independent background execution runner in `worker.ts` utilizing database queueing with atomic task row reservation via `FOR UPDATE SKIP LOCKED`.
  * Implemented stale-claim recovery with leases to allow tasks to scale resiliently across multiple nodes.
* **Context Assembly for Planner (Epic W2-B)**:
  * Enhanced `planner.ts` to consume long-term thread history snapshots and active memory snippets (`context.ts`), allowing the generative step to reason with user context and historical feedback before building multi-step maps.
* **Closed-Loop Runtime (Epic W2-C)**:
  * Extended the executor to automatically feed failed runs / blocked verification states back into a new contextual planner instance (`loop.ts`). 
  * Supported up to 3 automatic replan/retry cycles during failures without needing user input.
* **Semantic Verifier (Epic W2-D)**:
  * Introduced `semanticVerifier.ts` to intelligently determine if the final execution trace actually aligns with the user's intent. Supplementing hardcoded rule-verifications with LLM-layer verification.
* **Observability & Dashboard Updates (Epic W2-E)**:
  * Exposed the iteration counts (re-plans) and Semantic Verification signals inside the live React telemetry panel.

### 🧹 Commit Cleanup & Refinements (Polishing gap closure)

* **Robust Finished Condition Invariant**: Corrected run status updates so `finished_at` is always written for all terminal runs, including those ending in `blocked` status.
* **Goal Completed Timestamps**: Enhanced goal tracking to ensure `completed_at` timestamps are applied to all goals ending as `completed`, `failed`, `cancelled`, or `blocked`.
* **Technical Documentation**: Created `docs/intent-routing.md` to lay out the full intent taxonomy and heuristics matching structures. Updated `README.md` to document the 7 Worker & Queue system invariants.
* **Log Sanitation**: Added complete descriptive JSDoc comments detailing structured logging and its strict automatic sanitization logic to hide runtime secret keys.
* **File Cleanup**: Removed stale temporary specification documents (`phase2dod.md` and `weeks-1-2-spec.md`) to establish `slack_ez_cloud` as the clear source of truth.
