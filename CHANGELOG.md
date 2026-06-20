# Changelog

All notable changes to this project will be documented in this file.

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
