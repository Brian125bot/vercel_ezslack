# 🧠 Dynamic Gemini Slack AI Agent Backend

[![Engine](https://img.shields.io/badge/Gemini-2.5%20Flash%20%7C%203.5%20Flash-blueviolet?style=flat-square&logo=google)](https://ai.google.dev/)
[![Platform](https://img.shields.io/badge/Runtime-Node.js%2022%20%7C%20Express-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Deploy](https://img.shields.io/badge/Deploy-Cloud%20Run-blue?style=flat-square&logo=google-cloud)](https://cloud.google.com/run)
[![Tests](https://img.shields.io/badge/Tests-8%20suites%20%7C%2063+%20cases-brightgreen?style=flat-square)](tests/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

An enterprise-ready, secure, and hot-swappable **Slack AI Agent Backend** powered by **Express.js** and the **Google Gen AI SDK**. This agent incorporates dynamic runtime intent classification, multi-turn threaded memory persistence, and an interactive real-time telemetry dashboard.

Designed specifically to run under the strict timeout requirements of Slack API infrastructures, the backend features an **asynchronous non-blocking double-queue architecture** to decouple initial event ingestion from complex multi-step generative cognition.

---

## Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Agent Pipeline](#-agent-pipeline)
- [Intent Classification](#-intent-classification)
- [Tool System & Adapters](#-tool-system--adapters)
- [Approval Flow](#-approval-flow)
- [Scheduler & Deferral](#-scheduler--deferral)
- [Database Schema](#-database-schema)
- [Worker & Queue](#-worker--queue)
- [Test Suite](#-test-suite)
- [API Reference](#-api-reference)
- [Project Structure](#-project-structure)
- [Environment Variables](#-environment-variables)
- [Deployment](#-deployment)
- [Dashboard](#-dashboard)
- [Slack Configuration](#-slack-configuration)

---

## 🏗 Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Slack Workspace                                                     │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │ @mentions     │  │ DMs            │  │ Channel messages          │ │
│  └──────┬───────┘  └───────┬────────┘  └────────────┬─────────────┘ │
└─────────┼──────────────────┼───────────────────────┼────────────────┘
          └──────────────────┴───────────────────────┘
                             │ HTTPS POST
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Express Server (Cloud Run)                                            │
│                                                                        │
│  POST /api/slack/events ───► Verify Signature (HMAC-SHA256)            │
│       │                      Dedup (event_id + client_msg_id)          │
│       │                      ACK 200 OK (<15ms)                        │
│       │                                                                │
│       └─── setImmediate() ──► Intent Classifier                        │
│                               │                                        │
│            ┌──────────────────┼──────────────────────────────┐         │
│            │                  │                              │         │
│            ▼                  ▼                              ▼         │
│       direct_reply    durable_task              cancel_or_update       │
│       status_query    approval_response         unsafe_or_unsupported  │
│            │                  │                              │         │
│            │                  ▼                              │         │
│            │          ┌──────────────┐                       │         │
│            │          │ Deferral     │                       │         │
│            │          │ Detection    │                       │         │
│            │          └──┬───────┬───┘                       │         │
│            │         now │       │ later                     │         │
│            │             ▼       ▼                           │         │
│            │     Worker Queue  Scheduler                     │         │
│            │             │      (15s poll)                   │         │
│            │             ▼                                   │         │
│            │     ┌──────────────────────────────────┐        │         │
│            │     │ CLOSED LOOP (max 3 iterations)   │        │         │
│            │     │                                  │        │         │
│            │     │  Plan ──► Execute ──► Verify ──┐ │        │         │
│            │     │   ▲                            │ │        │         │
│            │     │   └──── Replan (if failed) ◄───┘ │        │         │
│            │     │                                  │        │         │
│            │     │  Policy Gate ──► Approval (if    │        │         │
│            │     │                   external_write)│        │         │
│            │     └──────────────────────────────────┘        │         │
│            │                  │                              │         │
│            └──────────────────┼──────────────────────────────┘         │
│                               ▼                                        │
│                      Finalize + Report                                 │
│                               │                                        │
│  POST /api/slack/interactivity ◄── Block Kit buttons (Approve/Reject)  │
│  GET  /api/health              ◄── Uptime probe                        │
│                                                                        │
│  ┌────────────────────────────────────────────┐                        │
│  │ PostgreSQL (Cloud SQL)                     │                        │
│  │ goals → plans → runs → steps → tool_calls  │                        │
│  │ approval_requests, memory_records           │                        │
│  │ audit_events, scheduled_triggers            │                        │
│  └────────────────────────────────────────────┘                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| ACK Slack within 15ms, process via `setImmediate` | Slack cancels and retries if no `200 OK` within 3 seconds |
| `FOR UPDATE SKIP LOCKED` queue claims | Safe multi-instance concurrency on Cloud Run without Redis |
| Semantic + rule-based dual verification | Rules catch structural failures; LLM catches semantic mismatches |
| `generate` step kind | Solves the "chat wrapper" problem — content generation deferred to exec time |
| Atomic `DELETE ... RETURNING` for scheduler | Prevents double-firing across Cloud Run instances |
| Dynamic adapter registration | External tools only activate when env vars are set |

---

## 🔄 Agent Pipeline

The full durable task lifecycle:

```
User Message
  │
  ├─ classifyIntent()         # Heuristic rules → LLM fallback
  │
  ├─ handleDurableTask()      # Create goal
  │   ├─ detectDeferral()     # "remind me tomorrow" → scheduled_trigger
  │   └─ createRun()          # Queue for worker
  │
  ├─ Worker claims run        # FOR UPDATE SKIP LOCKED
  │   └─ runLoop()            # Up to 3 iterations
  │       │
  │       ├─ assembleContext() # Thread history + memory + prior steps
  │       ├─ createPlan()     # Gemini structured output → ordered steps
  │       │
  │       ├─ For each step:
  │       │   ├─ policyGate()          # Check risk level
  │       │   │   └─ postApprovalBlockKit()  # If external_write
  │       │   ├─ executeStep()         # Tool call or content generation
  │       │   │   ├─ kind: 'tool'      # Registry lookup → execute
  │       │   │   ├─ kind: 'generate'  # Gemini call with upstream outputs
  │       │   │   └─ kind: 'note'      # No-op (conceptual step)
  │       │   └─ sanitize()            # Redact secrets from output
  │       │
  │       ├─ verifyRun()      # Rule-based verification
  │       ├─ verifySemantically()  # LLM verification
  │       │   ├─ Both pass → finalizeRun('succeeded')
  │       │   └─ Semantic fail → clear plan, setImmediate(replan)
  │       │
  │       └─ finalizeRun()
  │           ├─ updateRunStatus()
  │           ├─ updateGoalStatus()
  │           └─ reportRunResult()  # Action-aware Slack summary
  │
  └─ Audit trail logged at every stage
```

---

## 🧠 Intent Classification

See [docs/intent-routing.md](docs/intent-routing.md) for the full specification.

### Classification Flow

```
Incoming Message
  ├─ Heuristic rules (fast, no LLM call)
  │   ├─ Unsafe patterns       → unsafe_or_unsupported
  │   ├─ Approval words + pending → approval_response
  │   ├─ Cancel/stop words     → cancel_or_update
  │   ├─ Status query words    → status_query
  │   ├─ Durable task words    → durable_task
  │   └─ Short messages (<8ch) → direct_reply
  │
  └─ LLM fallback (Gemini structured JSON)
      └─ { intent, confidence } or fallback → direct_reply
```

### Intent → Handler Mapping

| Intent | Handler | DB Required | Description |
|--------|---------|:-----------:|-------------|
| `direct_reply` | `handleDirectReply` | No | DB-less Gemini call → Slack reply |
| `durable_task` | `handleDurableTask` | Yes | Full Goal→Run→Plan→Execute→Verify loop |
| `status_query` | `handleStatusQuery` | Yes | Query goals/runs → Slack summary |
| `approval_response` | `handleApprovalResponse` | Yes | Resolve pending approval → resume/cancel |
| `cancel_or_update` | `handleCancelUpdate` | Yes | Cancel active runs OR mutate pending plan |
| `unsafe_or_unsupported` | `handleUnsafeUnsupported` | No | Log + polite refusal |

---

## 🔧 Tool System & Adapters

### Core Tools (always available)

| Tool Name | Risk Level | Description |
|-----------|-----------|-------------|
| `slack.replyInThread` | `internal_write` | Post a Slack message in the source thread |
| `memory.write` | `internal_write` | Persist a memory record (with secret filtering) |
| `memory.search` | `read` | Search memory by workspace/user/channel |
| `task.record` | `internal_write` | Record a task outcome to audit log |

### External Adapters (conditional on env vars)

| Adapter | Tool Name | Risk Level | Env Var Required |
|---------|-----------|-----------|------------------|
| `GitHubIssueAdapter` | `github.createIssue` | `external_write` | `GITHUB_TOKEN` |
| `EmailAdapter` | `email.send` | `external_write` | `EMAIL_WEBHOOK_URL` |

External adapters implement the `ExternalAdapter` interface from `src/server/tools/adapters/base.ts`. They self-register at startup only when their required environment variables are present. All external adapter tools automatically require user approval via Block Kit buttons.

### Adding a New Adapter

```typescript
// src/server/tools/adapters/myAdapter.ts
import type { ExternalAdapter, AgentTool } from './base.js';

export class MyAdapter implements ExternalAdapter {
  name = 'MyAdapter';
  isConfigured(): boolean { return !!process.env.MY_API_KEY; }
  getTools(): AgentTool[] {
    return [{
      name: 'my.action',
      description: 'Does something external',
      riskLevel: 'external_write',
      requiresApproval: true,
      execute: async (input, context) => { /* ... */ }
    }];
  }
}
```

Then register in `src/server/tools/registry.ts`:
```typescript
import { MyAdapter } from './adapters/myAdapter.js';
toolsRegistry.registerAdapter(new MyAdapter());
```

### Step Kinds

The planner can emit steps with different `kind` values:

| Kind | Behaviour |
|------|-----------|
| `tool` | Executes a registered tool from the registry |
| `generate` | Calls Gemini at execution time to produce content using upstream outputs |
| `note` | No-op conceptual step (always succeeds) |

The `generate` kind solves the "chat wrapper" problem: instead of baking reply content at plan time (when tool outputs aren't yet available), the planner defers content generation to execution time.

---

## ✅ Approval Flow

```
Step with riskLevel 'external_write' or 'destructive'
  │
  ├─ policyGate() blocks execution
  │
  ├─ postApprovalBlockKit()
  │   └─ Posts Slack message with Approve/Reject buttons
  │      (UUID in action.value, 30-minute expiry)
  │
  ├─ User clicks button
  │   └─ POST /api/slack/interactivity
  │       ├─ verifySlackSignature() (HMAC-SHA256)
  │       ├─ resolveApproval() (checks status='pending' AND expires_at > now())
  │       ├─ updateApprovalMessage() (removes buttons, shows outcome)
  │       └─ approved → resumeAgentPipeline()
  │          rejected → cancel run + goal
  │
  └─ Approval timeout (30 min) → resolveApproval() rejects with "expired" error
```

---

## ⏰ Scheduler & Deferral

### Time-Deferred Detection

When a `durable_task` message contains time-deferred language, the handler creates a `scheduled_trigger` instead of an immediate run:

```
"remind me tomorrow to check the deploy"
  → detectDeferral() → { deferred: true, delayMs: ~24h }
  → createScheduledTrigger({ next_run_at: tomorrow 9AM })
  → No immediate run created
```

Supported patterns:
- `"remind me in N (minutes|hours|days|weeks)"`
- `"remind me tomorrow"`
- `"follow up (tomorrow|next week|in N units)"`
- `"schedule (this|it) for tomorrow / next week / in N units"`
- Bare `"in N units"` with action verb context guard

### Scheduled Triggers Poller

- Polls every 15 seconds via `setInterval`
- Atomic `DELETE ... FOR UPDATE SKIP LOCKED ... RETURNING *` prevents double-firing
- Recurring triggers (cron/interval): re-inserted with next run time after claim
- One-shot triggers: not re-inserted after firing
- `cron-parser` for full cron expression support (graceful fallback if not installed)
- Scheduled runs inherit the model from the goal's most recent run
- Starts alongside the worker in `server.ts`; gracefully stops on SIGTERM/SIGINT

---

## 🗄 Database Schema

PostgreSQL with 2 idempotent migrations. All DDL uses `IF NOT EXISTS` / `IF EXISTS` guards.

### Tables

| Table | Purpose |
|-------|---------|
| `agent_goals` | Top-level user objectives with status tracking |
| `agent_plans` | Versioned step-by-step plans generated by the planner |
| `agent_runs` | Individual execution attempts (queue claims, lease tracking) |
| `agent_steps` | Ordered steps within a run (tool/generate/note) |
| `tool_calls` | Detailed tool execution records |
| `approval_requests` | Pending/resolved approval records with expiry |
| `memory_records` | Agent long-term memory (per-workspace, per-user) |
| `audit_events` | Full replayable timeline of all agent actions |
| `scheduled_triggers` | Cron/interval/one-shot triggers for deferred goals |

### Key Columns (agent_runs)

| Column | Purpose |
|--------|---------|
| `claimed_by` | Worker instance ID holding the lease |
| `claimed_at` | When the lease was acquired |
| `lease_expires_at` | Lease TTL (300s) — stale claims auto-recovered |
| `iteration_count` | Replan counter (max 3) |

### Migration System

Migrations are defined in `src/server/storage/schema.ts` and executed by `src/server/storage/migrations.ts`. The system uses a `schema_migrations` table to track applied versions. Running migrations multiple times is always safe.

---

## ⚙️ Worker & Queue

| Parameter | Value | Description |
|-----------|-------|-------------|
| Poll interval | 2,000ms | How often the worker checks for queued runs |
| Lease TTL | 300s (5 min) | Lock duration per claimed run |
| Max concurrent | 2 | Runs per Cloud Run instance |
| Claim pattern | `FOR UPDATE SKIP LOCKED` | Atomic, multi-instance safe |
| Stale recovery | Per poll cycle | `recoverStaleClaims()` at start of each cycle |
| Max iterations | 3 | Replan/retry limit per run |

---

## 🧪 Test Suite

8 test suites, 63+ test cases. Run with:

```bash
npm test              # Single run
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

| Suite | File | Cases | Tests |
|-------|------|:-----:|-------|
| Intent Classification | `tests/intent.test.ts` | 11 | Heuristic patterns for all 6 intent categories |
| Policy Gate | `tests/policy.test.ts` | 6 | Risk-level-based allow/deny/approval decisions |
| Secret Sanitization | `tests/sanitize.test.ts` | 8 | Token/password/key detection and redaction |
| Rule Verifier | `tests/verifier.test.ts` | 6 | Post-execution rule-based outcome verification |
| Action Reporter | `tests/reporter.test.ts` | 8 | Structured Slack report generation |
| Deferral Detection | `tests/deferral.test.ts` | 15 | Time-deferred pattern matching, false positive prevention |
| Agent Loop | `tests/loop.test.ts` | 4 | Full closed-loop integration (plan→execute→verify→finalize) |
| Migration Idempotency | `tests/migration.test.ts` | 9 | Static SQL analysis for IF NOT EXISTS guards |

### CI Gate (Cloud Build)

`cloudbuild.yaml` runs lint and test gates before building:

```yaml
steps:
  - name: node:22-alpine
    entrypoint: npm
    args: ['ci']
  - name: node:22-alpine
    entrypoint: npm
    args: ['run', 'lint']   # tsc --noEmit
  - name: node:22-alpine
    entrypoint: npm
    args: ['test']          # vitest run
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '...', '.']
  # ... push + deploy
```

---

## 📡 API Reference

### Public Endpoints (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/slack/events` | Slack Events API webhook (signature verified) |
| `POST` | `/api/slack/interactivity` | Block Kit button callbacks (signature verified) |
| `GET` | `/api/health` | Health check: `{ status: 'ok', uptime: N }` |

### Dashboard Endpoints (password-protected)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | System configuration status |
| `POST` | `/api/model/select` | Switch active Gemini model at runtime |
| `GET` | `/api/logs` | Pipeline event logs |
| `POST` | `/api/logs/clear` | Clear event logs |
| `GET` | `/api/agent/runs` | List runs (supports `?limit`, `?offset`, `?status`) |
| `GET` | `/api/agent/runs/:id` | Full run trace (goal, plan, steps, tools, audit) |
| `GET` | `/api/agent/goals/:id` | Get goal details |
| `GET` | `/api/agent/memory` | Search memory (`?workspace_id` required) |
| `GET` | `/api/agent/audit` | Audit events (`?runId` required) |
| `POST` | `/api/agent/approvals/:id/resolve` | Dashboard approval resolution |
| `POST` | `/api/slack/test` | Pipeline simulator (test webhook) |

---

## 📂 Project Structure

```
├── server.ts                          # Express entry point, graceful shutdown
├── src/
│   ├── App.tsx                        # React Dashboard UI
│   ├── main.tsx                       # React entry
│   ├── index.css                      # Tailwind CSS
│   ├── types.ts                       # Shared frontend/backend types
│   └── server/
│       ├── routes.ts                  # All API routes + Slack signature verify
│       ├── auth.ts                    # Dashboard password auth middleware
│       ├── state.ts                   # In-memory logs, model selection, dedup sets
│       ├── ai.ts                      # Gemini SDK wrapper
│       ├── agent/
│       │   ├── orchestrator.ts        # Pipeline entry point, resume logic
│       │   ├── intent.ts              # Heuristic + LLM intent classifier
│       │   ├── handlers/
│       │   │   ├── index.ts           # Handler dispatch
│       │   │   ├── directReply.ts     # DB-less conversational reply
│       │   │   ├── durableTask.ts     # Goal creation + deferral detection
│       │   │   ├── statusQuery.ts     # Active goal/run queries
│       │   │   ├── approvalResponse.ts # Resolve pending approvals
│       │   │   ├── cancelUpdate.ts    # Cancel runs OR mutate plans
│       │   │   └── unsafeUnsupported.ts # Refusal handler
│       │   ├── context.ts            # Thread history + memory assembly
│       │   ├── planner.ts            # Gemini structured plan generation
│       │   ├── executor.ts           # Step execution (tool/generate/note)
│       │   ├── verifier.ts           # Rule-based post-execution verification
│       │   ├── semanticVerifier.ts   # LLM-based semantic verification
│       │   ├── loop.ts               # Closed loop (plan→exec→verify→replan)
│       │   ├── finalize.ts           # Run/goal status finalization
│       │   ├── reporter.ts           # Action-aware Slack run reports
│       │   ├── policy.ts             # Risk-level policy gate
│       │   ├── sanitize.ts           # Secret detection and redaction
│       │   ├── worker.ts             # Background queue poller
│       │   ├── scheduler.ts          # Scheduled trigger poller (15s)
│       │   ├── deferral.ts           # Time-deferred language detection
│       │   ├── planMutation.ts       # NL plan modification via Gemini
│       │   ├── log.ts                # Structured logging utility
│       │   └── types.ts              # Agent type definitions
│       ├── storage/
│       │   ├── schema.ts             # Migration SQL definitions
│       │   ├── migrations.ts         # Migration runner
│       │   ├── agentStore.ts         # All DB queries (goals, runs, steps, etc.)
│       │   ├── db.ts                 # PostgreSQL connection pool
│       │   └── types.ts              # DB row types
│       └── tools/
│           ├── registry.ts           # Tool registry + adapter registration
│           ├── slack.ts              # Slack reply + Block Kit approval tools
│           ├── memory.ts             # Memory read/write tools
│           ├── task.ts               # Task recording tool
│           └── adapters/
│               ├── base.ts           # ExternalAdapter interface
│               ├── index.ts          # Barrel export
│               ├── githubIssue.ts    # GitHub Issues adapter
│               └── email.ts          # Email webhook adapter
├── tests/
│   ├── intent.test.ts                # 11 intent classification tests
│   ├── policy.test.ts                # 6 policy gate tests
│   ├── sanitize.test.ts              # 8 secret redaction tests
│   ├── verifier.test.ts              # 6 rule verification tests
│   ├── reporter.test.ts              # 8 report generation tests
│   ├── deferral.test.ts              # 15 deferral detection tests
│   ├── loop.test.ts                  # 4 closed-loop integration tests
│   └── migration.test.ts             # 9 migration idempotency tests
├── docs/
│   └── intent-routing.md             # Intent routing architecture spec
├── slack-manifest.json               # Slack App Manifest (copy-paste ready)
├── cloudbuild.yaml                   # GCP Cloud Build CI/CD pipeline
├── Dockerfile                        # Multi-stage Node 22 Alpine build
├── vitest.config.ts                  # Vitest configuration
├── vite.config.ts                    # Vite build configuration
├── CHANGELOG.md                      # Version history (v2.0.0 → v3.1.0)
├── .env.example                      # Environment variable template
└── package.json                      # Dependencies and scripts
```

---

## 🔐 Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (HMAC verification) |

### Database (one of these groups)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Full PostgreSQL connection string |
| `CLOUD_SQL_CONNECTION_NAME` | GCP Cloud SQL instance (e.g., `project:region:instance`) |
| `SQL_HOST` + `SQL_USER` + `SQL_PASSWORD` + `SQL_DB_NAME` | Standard PostgreSQL params |

### Optional

| Variable | Description |
|----------|-------------|
| `DASHBOARD_PASSWORD` | Password for the admin dashboard |
| `APP_URL` | Public URL (for self-referential links) |
| `GITHUB_TOKEN` | Enables the GitHub Issue adapter |
| `EMAIL_WEBHOOK_URL` | Enables the Email adapter |

---

## 🐳 Deployment

### Option 1: Cloud Buildpacks (Source Deploy)
```bash
gcloud run deploy slack-ai-agent \
  --source . \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=...,SLACK_BOT_TOKEN=...,SLACK_SIGNING_SECRET=..."
```

### Option 2: Docker + Cloud Run
```bash
docker build -t gcr.io/YOUR_PROJECT/slack-ai-agent .
docker push gcr.io/YOUR_PROJECT/slack-ai-agent
gcloud run deploy slack-ai-agent \
  --image gcr.io/YOUR_PROJECT/slack-ai-agent \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="..."
```

### Option 3: Cloud Build CI/CD (Automated)

Push to `main` triggers the `cloudbuild.yaml` pipeline:

1. `npm ci` → `npm run lint` → `npm test` (gates)
2. Docker build (Node 22 Alpine, multi-stage)
3. Push `:$COMMIT_SHA` and `:latest` tags
4. Deploy to Cloud Run (`us-west1`)

```bash
gcloud builds triggers run <TRIGGER_ID> --branch=main --project=<PROJECT_ID>
```

### Lifecycle

```
Start: migrations → startWorker() → startScheduler() → listen(:3000)
Stop:  SIGTERM → stopWorker() → stopScheduler() → drain HTTP → closeDb() → exit
```

---

## 📊 Dashboard

The companion React dashboard provides:

- **Model Control Panel** — Switch Gemini model at runtime without redeployment
- **Agent Runs & SQL Trace** — Drill into goal → plan → steps → tool calls
- **Pipeline Event Logs** — Signature states, intent classification, latency
- **Simulator Gateway** — Test agent responses without a live Slack workspace

---

## 📝 Slack Configuration

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an App Manifest**
2. Paste the contents of `slack-manifest.json`
3. Update `request_url` values to your Cloud Run URL:
   - Events: `https://YOUR_URL/api/slack/events`
   - Interactivity: `https://YOUR_URL/api/slack/interactivity`
4. **Install to Workspace** and authorize
5. Copy **Signing Secret** and **Bot User OAuth Token** into your environment

### Required Bot Scopes

| Scope | Purpose |
|-------|---------|
| `app_mention` | Respond when @mentioned |
| `channels:history` | Read channel messages |
| `groups:history` | Read private channel messages |
| `im:history` | Read direct messages |
| `chat:write` | Post replies and approval messages |

### Required Event Subscriptions

| Event | Purpose |
|-------|---------|
| `app_mention` | Trigger on @mentions |
| `message.channels` | Trigger on public channel messages |
| `message.groups` | Trigger on private channel messages |
| `message.im` | Trigger on DMs |

---

## ⚡ Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Brian125bot/slack_ez_cloud.git
cd slack_ez_cloud
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your GEMINI_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET

# 3. Start development server
npm run dev
# Dashboard available at http://localhost:3000

# 4. Run tests
npm test
```

---

## 📅 Roadmap

See [CHANGELOG.md](CHANGELOG.md) for detailed version history.

| Version | Status | Milestone |
|---------|--------|-----------|
| v2.0.0 | ✅ Done | Weeks 1–2: Trust & Correctness, Agent Loop |
| v2.1.0 | ✅ Done | CI/CD Pipeline, Node 22, Repo Cleanup |
| v3.0.0 | ✅ Done | Weeks 3–4: Real-World Action, Autonomy & Hardening |
| v3.0.1 | ✅ Done | Pre-merge QA Bug Fixes (3 security/correctness) |
| v3.1.0 | ✅ Done | Final DoD Gaps: Deferral, Plan Mutation, Loop Tests |
