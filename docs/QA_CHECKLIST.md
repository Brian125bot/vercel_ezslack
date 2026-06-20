# QA Checklist — `version-3` Branch Pre-Merge Review

**Branch:** `version-3`  
**Base:** `main` (HEAD: `5af8c1f`)  
**Commits:** `89eb959` → `17deb43` → `cbaec04`  
**Scope:** Weeks 3–4 implementation (Real-World Action + Autonomy & Hardening)

---

## 🏗 Build & Local Verification

- [ ] `npm install` — completes without errors
- [ ] `npm run lint` (`tsc --noEmit`) — zero type errors
- [ ] `npm run build` — Vite frontend + esbuild backend compile successfully
- [ ] `npm test` — all 8 suites pass (63+ tests)
- [ ] `npm run test:coverage` — review coverage report for gaps
- [ ] `npm start` (or `node dist/server.cjs`) — server starts on port 3000
- [ ] No new `npm audit` vulnerabilities introduced

---

## 🧪 Test Suite Verification

### Existing Tests (should still pass)

| Suite | File | Cases | Status |
|-------|------|:-----:|:------:|
| Intent Classification | `tests/intent.test.ts` | 11 | [ ] |
| Policy Gate | `tests/policy.test.ts` | 6 | [ ] |
| Secret Sanitization | `tests/sanitize.test.ts` | 8 | [ ] |
| Rule Verifier | `tests/verifier.test.ts` | 6 | [ ] |
| Action Reporter | `tests/reporter.test.ts` | 8 | [ ] |

### New Tests (version-3)

| Suite | File | Cases | Status |
|-------|------|:-----:|:------:|
| Deferral Detection | `tests/deferral.test.ts` | 15 | [ ] |
| Agent Loop | `tests/loop.test.ts` | 4 | [ ] |
| Migration Idempotency | `tests/migration.test.ts` | 9 | [ ] |

---

## 📋 Week 3 — Real-World Action

### W3-A: Exec-Time Content Generation (`generate` step kind)

- [ ] `src/server/agent/types.ts` — `StepKind` type includes `'tool' | 'generate' | 'note'`
- [ ] `src/server/agent/executor.ts` — `generate` branch calls Gemini with upstream outputs
- [ ] `src/server/agent/executor.ts` — downstream `slack.replyInThread` auto-injects generated text when `input.text` is empty
- [ ] `src/server/storage/agentStore.ts` — `updateStepInput()` exists for runtime input patching
- [ ] `src/server/agent/planner.ts` — LLM prompt teaches about `generate` kind + dynamic tool catalogue
- [ ] **Manual test:** Send a complex question to the agent → verify the planner emits a `generate` step before `slack.replyInThread`

### W3-B: External Adapter Framework

- [ ] `src/server/tools/adapters/base.ts` — `ExternalAdapter` interface with `name`, `isConfigured()`, `getTools()`
- [ ] `src/server/tools/adapters/githubIssue.ts` — `GitHubIssueAdapter` class
  - [ ] Returns `isConfigured() = true` only when `GITHUB_TOKEN` is set
  - [ ] Tool declares `riskLevel: 'external_write'`
  - [ ] Creates GitHub issues via REST API (`POST /repos/:owner/:repo/issues`)
- [ ] `src/server/tools/adapters/email.ts` — `EmailAdapter` class
  - [ ] Returns `isConfigured() = true` only when `EMAIL_WEBHOOK_URL` is set
  - [ ] Tool declares `riskLevel: 'external_write'`
- [ ] `src/server/tools/registry.ts` — calls `registerAdapter()` for both adapters
- [ ] **Verification:** Start without `GITHUB_TOKEN` → confirm logs show "Adapter skipped (not configured): GitHub"
- [ ] **Verification:** Start with `GITHUB_TOKEN` → confirm logs show "Adapter registered: GitHub"

### W3-C: Block Kit Interactive Approvals

- [ ] `src/server/tools/slack.ts` — `postApprovalBlockKit()` function exists
  - [ ] Posts Slack message with Approve/Reject buttons
  - [ ] Includes approval UUID in `action.value`
  - [ ] Sets 30-minute expiry on approval request
- [ ] `src/server/routes.ts` — `POST /api/slack/interactivity` route
  - [ ] Parses URL-encoded `payload` field
  - [ ] Calls `verifySlackSignature()` before processing (**Bug 1 fix**)
  - [ ] Resolves approval, updates Block Kit message, resumes/cancels
- [ ] `src/server/tools/slack.ts` — `updateApprovalMessage()` removes buttons and shows outcome
- [ ] `slack-manifest.json` — `interactivity.is_enabled: true` with correct `request_url`
- [ ] `server.ts` — `express.urlencoded()` middleware is registered

### W3-D: Action-Aware Reporting

- [ ] `src/server/agent/reporter.ts` — `buildRunReport(trace)` generates structured Slack report
  - [ ] Lists every step with tool, outcome, generated content length
  - [ ] Includes resolved approvals
- [ ] `src/server/agent/finalize.ts` — calls `reportRunResult(trace)` (not generic "Task finished")
- [ ] **Verification:** Complete a multi-step task → verify the Slack report shows step-by-step breakdown

---

## 📋 Week 4 — Autonomy & Hardening

### W4-A: Scheduled Triggers Poller

- [ ] `src/server/agent/scheduler.ts` — `startScheduler()` / `stopScheduler()` lifecycle
  - [ ] Polls every 15 seconds
  - [ ] `getDueScheduledTriggers()` uses atomic `DELETE ... FOR UPDATE SKIP LOCKED ... RETURNING *` (**Bug 3 fix**)
  - [ ] `cron-parser` integration with graceful fallback
  - [ ] Model inherited from goal's most recent run via `getRunsForGoal()`
  - [ ] Recurring triggers re-inserted with next run time; one-shot not re-inserted
- [ ] `server.ts` — `startScheduler()` called alongside `startWorker()`
- [ ] `server.ts` — `stopScheduler()` called in `gracefulShutdown()`

### W4-B: Test Suite & CI Gate

- [ ] `vitest.config.ts` — proper Vitest configuration
- [ ] `package.json` — `test`, `test:watch`, `test:coverage` scripts present
- [ ] `cloudbuild.yaml` — `npm run lint` and `npm test` steps before Docker build
- [ ] `vitest` listed in `devDependencies`

### W4-C: Natural Language Plan Mutation

- [ ] `src/server/agent/planMutation.ts` — `mutatePlan()` function
  - [ ] Supports `add`, `remove`, `replace`, `modify` actions (NOT `reorder` — removed)
  - [ ] Only mutates `pending` steps (protects `succeeded`/`running`/`blocked`)
  - [ ] Logs `plan.mutated` audit event
- [ ] `src/server/agent/handlers/cancelUpdate.ts` — wired into handler (**no longer dead code**)
  - [ ] `classifyCancelVsUpdate()` sub-classifies cancel vs update
  - [ ] Cancel patterns → cancel all active runs
  - [ ] Everything else → calls `mutatePlan()` on active run's plan

### W4-D: Ops Hardening

- [ ] `server.ts` — graceful shutdown handler for `SIGTERM` and `SIGINT`
  - [ ] Stops worker, stops scheduler, drains HTTP, closes DB pool
- [ ] `src/server/routes.ts` — `GET /api/health` returns `{ status: 'ok', uptime: N }`
- [ ] `express.urlencoded()` middleware registered for interactivity payloads

### W4-F1: Time-Deferred Trigger Detection

- [ ] `src/server/agent/deferral.ts` — `detectDeferral()` function
  - [ ] Handles: "remind me in N hours", "remind me tomorrow", "follow up next week", "schedule this for tomorrow", bare "in N units" with action-verb guard
  - [ ] Returns `{ deferred: false }` for non-deferred messages
  - [ ] `hasActionContext()` prevents false positives on "interested in 3 days of vacation"
- [ ] `src/server/agent/handlers/durableTask.ts` — calls `detectDeferral()` before `createRun()`
  - [ ] Creates `scheduled_trigger` when deferred
  - [ ] Logs `trigger.created` audit event
  - [ ] Replies to user with confirmation message including delay label

---

## 🔒 Security Review

### Signature Verification

- [ ] `verifySlackSignature()` in `routes.ts` — shared helper
  - [ ] Checks `x-slack-signature` and `x-slack-request-timestamp` headers
  - [ ] Rejects timestamps older than 300 seconds (replay attack prevention)
  - [ ] Uses `crypto.timingSafeEqual()` for constant-time comparison
  - [ ] Permissive when `SLACK_SIGNING_SECRET` not set (local dev only)
- [ ] Applied to `POST /api/slack/events`
- [ ] Applied to `POST /api/slack/interactivity`

### Approval Security

- [ ] `resolveApproval()` in `agentStore.ts`
  - [ ] Checks `status = 'pending'` (can't re-resolve)
  - [ ] Checks `expires_at > now()` (expired approvals rejected) (**Bug 2 fix**)
  - [ ] Returns descriptive error for already-resolved, expired, or not-found

### Secret Sanitization

- [ ] `src/server/agent/sanitize.ts` — blocks secrets from `memory.write`
- [ ] Patterns: password, token, secret, api_key, credentials
- [ ] `sanitize.test.ts` — 8 tests cover detection and redaction

---

## 📄 Documentation Review

### README.md

- [ ] Architecture diagram is accurate and up to date
- [ ] Table of contents links all sections correctly
- [ ] All API endpoints documented
- [ ] Project structure tree matches actual files
- [ ] Environment variables table is complete
- [ ] Deployment options all documented
- [ ] Quick start instructions work end-to-end
- [ ] Roadmap table reflects current version status

### docs/intent-routing.md

- [ ] Classification flow diagram matches `intent.ts` code
- [ ] Intent → Handler table matches `handlers/index.ts`
- [ ] Step Kinds section documents all 3 kinds
- [ ] Tool Registry section lists all core + adapter tools
- [ ] Approval Flow section matches `routes.ts` implementation
- [ ] Plan Mutation section documents cancel-vs-update sub-classification
- [ ] Time-Deferred Detection section documents all supported patterns
- [ ] Scheduled Triggers section mentions model inheritance

### CHANGELOG.md

- [ ] v3.1.0 entry covers all new features and tests
- [ ] v3.0.1 entry covers all 3 bug fixes
- [ ] v3.0.0 entry covers all W3+W4 features
- [ ] No stale or incorrect information from earlier versions

---

## 🔍 Code Quality Spot Checks

### Type Safety

- [ ] No `any` type on public function signatures (acceptable in internal catch blocks)
- [ ] All new functions have JSDoc or inline comments explaining purpose
- [ ] `AgentTool` interface used consistently in registry and adapters

### Error Handling

- [ ] `scheduler.ts` — individual trigger errors don't crash the poller
- [ ] `cancelUpdate.ts` — handles no active runs, no plan_id gracefully
- [ ] `deferral.ts` — always returns `{ deferred: false }` for unrecognized input
- [ ] `planMutation.ts` — handles Gemini API errors without crashing

### Dead Code

- [ ] No `updateScheduledTriggerAfterRun()` in `agentStore.ts` (removed)
- [ ] No `disableScheduledTrigger()` in `agentStore.ts` (removed)
- [ ] No `'reorder'` action in `MutationInstruction` type (removed)
- [ ] `mutatePlan()` is wired into `cancelUpdate.ts` (no longer dead)

### Consistency

- [ ] All store methods follow the same `query<T>(sql, params)` pattern
- [ ] All handlers follow the `(input, context) → AgentPipelineResult` signature
- [ ] All audit events use consistent `type` naming (e.g., `trigger.created`, `plan.mutated`)

---

## 🚀 Integration Testing (Manual, Post-Merge)

> These require a running Slack workspace + database. Perform after merge to `main` and deploy.

### Happy Path

- [ ] Send a simple question → agent replies conversationally (direct_reply)
- [ ] Send "create a task to review the code" → agent creates goal, plan, executes, reports
- [ ] Send "what are you working on?" → agent replies with status (status_query)
- [ ] Send "cancel" → agent cancels active runs
- [ ] Send "remind me in 2 hours to check the deploy" → agent creates scheduled trigger, confirms
- [ ] Wait for trigger to fire → verify new run is created and executed

### Approval Flow

- [ ] Set `GITHUB_TOKEN` → send "create a GitHub issue about the bug"
- [ ] Agent should post Block Kit approval message
- [ ] Click Approve → agent creates the issue
- [ ] Click Reject → agent cancels the run
- [ ] Wait 30+ minutes without clicking → verify expired approval cannot be resolved

### Plan Mutation

- [ ] While a multi-step task is running, send "add a step to also check the logs"
- [ ] Verify plan is mutated (new step added), not cancelled

### Error Recovery

- [ ] Disconnect database → send a question → agent still replies (DB-less fallback)
- [ ] Send a durable task with DB down → agent replies "Database unavailable"
- [ ] Kill the process with SIGTERM → verify clean shutdown logs

### Dashboard

- [ ] Login with `DASHBOARD_PASSWORD`
- [ ] Switch model → verify next message uses the new model
- [ ] View run trace → drill into steps, tool calls, audit events
- [ ] Use simulator to test a pipeline without Slack

---

## ✅ Final Sign-Off

| Area | Reviewer | Date | Status |
|------|----------|------|--------|
| Build & Tests | | | [ ] |
| Week 3 Features | | | [ ] |
| Week 4 Features | | | [ ] |
| Security | | | [ ] |
| Documentation | | | [ ] |
| Code Quality | | | [ ] |
| Integration (post-merge) | | | [ ] |

**Merge Decision:** [ ] Approved / [ ] Needs Changes

**Notes:**
_______________________________________________________
_______________________________________________________
_______________________________________________________
