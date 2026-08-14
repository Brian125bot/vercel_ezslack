# 🧠 Dynamic Gemini Slack AI Agent Backend 

[![Engine](https://img.shields.io/badge/Gemini-3.5%20Flash%20%7C%203.1%20Flash%20Lite-blueviolet?style=flat-square&logo=google)](https://ai.google.dev/)
[![Platform](https://img.shields.io/badge/Runtime-Node.js%2022%20%7C%20Express-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Deploy](https://img.shields.io/badge/Deploy-Vercel-black?style=flat-square&logo=vercel)](https://vercel.com)
[![Tests](https://img.shields.io/badge/Tests-28%20files%20%7C%20355%20cases-brightgreen?style=flat-square)](tests/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

An enterprise-ready, secure, and hot-swappable **Slack AI Agent Backend** powered by **Express.js** and the **Google Gen AI SDK**, deployed as **Vercel Serverless Functions**. This agent incorporates dynamic runtime intent classification, multi-turn threaded memory persistence, and an interactive real-time telemetry dashboard.

Designed specifically to run under the strict timeout requirements of Slack API infrastructures, the backend features an **asynchronous non-blocking architecture** via **Vercel Workflows** to decouple initial event ingestion from complex multi-step generative cognition.

---

### Multimodal Input & Thread History Bounds

The agent can see and reason about images, screenshots, and PDFs attached to
Slack messages. Supported formats: PNG, JPEG, WebP, HEIC/HEIF, and PDF, up to
15MB per file and 4 files per message (configurable via `MAX_ATTACHMENT_BYTES`
and `MAX_ATTACHMENTS_PER_MESSAGE`). This works for both direct replies and
multi-step durable tasks — attachments are passed to Gemini as native
multimodal input, not OCR'd or pre-processed.

**Thread History Bounding** — Prevents unbounded row growth in `thread_memories`
and stops the agent from re-embedding stale attachment payloads. Historical
messages with attachments persist metadata only (filename, mimeType, sizeBytes)
without `base64Data`, and are summarized via a text note in the model context.
Configurable via:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_THREAD_HISTORY_MESSAGES` | 20 | Max messages retained in thread history |
| `MAX_THREAD_HISTORY_CHARS` | 40000 | Cumulative character cap for history |
| `MAX_THREAD_MESSAGE_CHARS` | 4000 | Per-message truncation limit |

**Model-Aware Thread History Budget** — `MAX_THREAD_HISTORY_CHARS` now defaults
to a percentage of the selected Gemini model's actual context window (tokens ×
4 chars/token × 5%). This ensures models with larger context windows can
utilize more capacity for conversation history while maintaining safety and
efficiency. Override with `THREAD_HISTORY_BUDGET_PERCENT` (default `0.05`).
Explicit `MAX_THREAD_HISTORY_CHARS` in the environment still takes precedence.

## Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Agent Pipeline](#-agent-pipeline)
- [Intent Classification](#-intent-classification)
- [Tool System & Adapters](#-tool-system--adapters)
- [Approval Flow](#-approval-flow)
- [Scheduler & Deferral](#-scheduler--deferral)
- [Security](#-security)
- [Database Schema](#-database-schema)
- [Worker & Queue](#-queue)
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
┌──────────────────────────────────────────────────────────────────────────┐
│  Vercel Serverless Functions / Express                                   │
│                                                                          │
│  POST /api/slack/events ────► Verify Signature (HMAC-SHA256)             │
│       │                        Dedup (event_id + client_msg_id + intent)│
│       │                        ACK 200 OK (<15ms)                        │
│       │                                                                  │
│       └─── triggerWorkflow() ────► Intent Classifier                     │
│                                   │                                      │
│               ┌──────────────────┼────────────────────────┐              │
│               │                  │                          │             │
│               ▼                  ▼                          ▼             │
│          direct_reply     durable_task          cancel_or_update          │
│          status_query     approval_response    unsafe_or_unsupported      │
│               │                  │                          │             │
│               │           ┌──────┴──────┐                   │             │
│               │           │  Deferral   │                   │             │
│               │           │  Detection  │                   │             │
│               │           └──┬──────┬───┘                   │             │
│               │          now │      │ later                 │             │
│               │              ▼      ▼                       │             │
│               │         Vercel Workflows / agentRun                     │
│               │              │                              │             │
│               │       ┌──────┴─────────────────┐            │             │
│               │       │                        │            │             │
│               │       ▼                        ▼            │             │
│               │  ┌──────────────────┐  ┌──────────────────┐ │             │
│               │  │ CLOSED LOOP      │  │ ReAct LOOP       │ │             │
│               │  │ (plan→exec→verify│  │ (stream + func   │ │             │
│               │  │  →replan x3)     │  │  calling + turns)│ │             │
│               │  │ ┌──────────────┐ │  │ ┌──────────────┐ │ │             │
│               │  │ │Plan → Execute│ │  │ │Agent Step →  │ │ │             │
│               │  │ │→ Verify →   │ │  │ │Stream Reply  │ │ │             │
│               │  │ │→ Replan ↺   │ │  │ │→ Post to     │ │ │             │
│               │  │ └──────────────┘ │  │ │  Slack (thr.)│ │ │             │
│               │  │ Policy Gate →    │  │ └──────────────┘ │ │             │
│               │  │ Approval (if     │  │ Cost tracking:   │ │             │
│               │  │  external_write) │  │ total_tokens     │ │             │
│               │  └──────────────────┘  └──────────────────┘ │             │
│               │              │                              │             │
│               └──────────────┼──────────────────────────────┘             │
│                              ▼                                           │
│                     Finalize + Report                                    │
│                              │                                           │
│  POST /api/slack/interactivity ◄── Block Kit buttons (Approve/Reject)    │
│  GET  /api/health              ◄── Uptime probe                          │
│  GET  /api/cron/poll           ◄── Vercel Cron (daily 9AM UTC)           │
│                                                                          │
│  ┌──────────────────────────────────────────────┐                        │
│  │ Vercel Postgres (Neon)                       │                        │
│  │ goals → plans → runs → steps → tool_calls    │                        │
│  │ approval_requests, memory_records             │                        │
│  │ audit_events, scheduled_triggers              │                        │
│  │ agent_messages (ReAct loop turns)             │                        │
│  │ slack_event_logs                              │                        │
│  └──────────────────────────────────────────────┘                        │
│                                                                          │
│  ┌──────────────────────────────────────┐                               │
│  │ Vercel KV / Upstash Redis            │                               │
│  │ event dedup │ msg dedup │ intent lock │                               │
│  │ thread cache │ rate limit counters    │                               │
│  └──────────────────────────────────────┘                               │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| ACK Slack within 15ms, delegate to Vercel Workflow | Slack cancels and retries if no `200 OK` within 3 seconds |
| Atomic `claimQueuedRunById` for run claiming | Prevents duplicate/concurrent invocations from both entering `runLoop` |
| `FOR UPDATE SKIP LOCKED` queue claims | Concurrency fallback for synchronous execution paths |
| Dual verification (semantic + rule-based) | Rules catch structural failures; LLM catches semantic mismatches |
| `generate` step kind | Solves the "chat wrapper" problem — content generation deferred to exec time |
| Atomic `DELETE ... RETURNING` for scheduler | Prevents double-firing across concurrent function invocations |
| Dynamic adapter registration | External tools only activate when env vars are set |
| HTTP 508 Loop Detected as terminal state | Prevents useless retries when Vercel identifies recursive invocation chains |
| Model-aware thread history budget | Context window proportional to selected model's token limit |
| Thread history message/char bounds | Prevents unbounded DB growth and token window saturation |
| `injectInto` field for generate-step output routing | Routes generated content into any downstream tool field |
| Durable run attachments persisted in DB | Survives serverless HTTP hops without in-memory cache |
| ReAct loop with streaming replies | `streamReplyToThread` delivers progressive answer text to Slack with throttled edits |
| Intent-based dedup via SHA-256 + Redis NX | Prevents duplicate processing of the same user intent across concurrent invocations |
| KV-backed rate limiting | Shared counter across all serverless instances prevents DoS in production |
| Skills system | Reusable system-prompt fragments injected at plan time based on environment |
| Bot mention stripping on `app_mention` events | Passes clean text to LLM (no `<@BOTID>` prefix confusion) |
| Configurable date/timezone context | `AGENT_TIMEZONE` + `AGENT_INCLUDE_DATETIME` for time-aware agent behavior |
| Fail-fast env validation at boot | Catches missing/placeholder secrets before `app.listen()`, not on first user request |
| Content Security Policy (CSP) | `default-src 'self'` + restrictive directives prevent XSS via `dangerouslySetInnerHTML` rendering of Slack/AI content |
| HTTPS redirect + HSTS | Production-only middleware redirects HTTP→HTTPS when `x-forwarded-proto` is `http`; `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` |
| Semantic message deduplication via Jaccard similarity | Dual-strategy dedup (exact SHA-256 hash + bigram Jaccard similarity) prevents near-duplicate Slack replies; configurable threshold, window size, and TTL |
| ReAct loop final answer persistence | Final text answers are persisted as a `succeeded` step so the semantic verifier sees the delivered result, preventing infinite replan/re-enqueue storms |

---

## 🔄 Agent Pipeline

### Durable Task Lifecycle (Closed Loop)

```
User Message
  │
  ├─ classifyIntent()         # Heuristic rules → LLM fallback
  │
  ├─ handleDurableTask()      # Create goal, detect deferral, queue run
  │   ├─ detectDeferral()     # "remind me tomorrow" → scheduled_trigger
  │   └─ createRun()          # Queue for worker (queued → claimed → running)
  │
  ├─ Worker claims run        # Atomic claimQueuedRunById (prevents storm)
  │   └─ runLoop()            # Up to 3 plan iterations
  │       │
  │       ├─ assembleContext()   # Thread history + memory + prior steps
  │       ├─ createPlan()       # Gemini structured output → ordered steps
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
  │       ├─ verifyRun()             # Rule-based structural checks
  │       ├─ verifySemantically()    # LLM-based semantic alignment
  │       │   ├─ Both pass → finalizeRun('succeeded')
  │       │   └─ Semantic fail → clear plan, replan (max 3 iterations)
  │       │
  │       └─ finalizeRun()
  │           ├─ updateRunStatus()
  │           ├─ updateGoalStatus()
  │           └─ reportRunResult()  # Action-aware Slack summary
  │
  └─ Audit trail logged at every stage (audit_events table)
```

### ReAct Loop (Streaming + Function Calling)

For `direct_reply` intents and as an alternative execution path, the agent
uses a **ReAct loop** with native Gemini function calling:

```
User Message
  │
  ├─ classifyIntent() → direct_reply (or durable task generate step)
  │
  ├─ geminiAgentStep()       # Stream + AUTO function calling
  │   ├─ generateContentStream()  # Real-time token streaming
  │   ├─ function calls dispatched to tool registry
  │   └─ thoughtSignature preserved through streaming chunks
  │
  ├─ streamReplyToThread()   # Post initial message → incremental edits
  │   └─ Throttled at 800ms intervals to avoid Slack rate limits
  │
├─ Agent turns persisted   # agent_messages table (survives requeue)
      │
      ├─ Final answer persisted   # Succeeded step for semantic verifier; prevents replan storms
      │
      └─ Cost tracking           # total_tokens captured per run
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

| Adapter | Tool Name | Risk Level | Env Var Required | Note on SSRF Guard |
|---------|-----------|-----------|------------------|--------------------|
| `WebSearchAdapter` | `search.query` | `read` | `TAVILY_API_KEY` | |
| `WebFetchAdapter` | `web.fetch` | `read` | `ENABLE_WEB_FETCH` | Protected by a multi-hop SSRF guard which blocks loopback, private CIDRs (including cloud metadata address `169.254.169.254`), IPv6 equivalents, IPv4-mapped/translated IP forms, and open redirects targeting those ranges. *Limitation:* It does NOT block DNS-rebinding (connection pinning is deferred). |
| `GitHubIssueAdapter` | `github.createIssue` | `external_write` | `GITHUB_TOKEN` | |
| `EmailAdapter` | `email.send` | `external_write` | `EMAIL_WEBHOOK_URL` | |
| `SandboxAdapter` | `sandbox.*` | `internal_write` | `SANDBOX_API_KEY` | |

External adapters implement the `ExternalAdapter` interface from `src/server/tools/adapters/base.ts`. They self-register at startup only when their required environment variables are present. All `external_write` adapters automatically require user approval via Block Kit buttons. `read` and `internal_write` adapters execute without approval.

### Skills System

The agent loads **skills** — reusable system-prompt fragments — at plan assembly
time. Built-in skills live in `skills/builtin/` and are injected into the
planner's system instruction based on the active environment configuration:

| Skill | Description |
|-------|-------------|
| `coding-standards.md` | Code style and naming conventions when writing code |
| `research-methodology.md` | Structured research approach for web searches |
| `slack-communication.md` | Slack message formatting and tone guidelines |

Skills are loaded by `src/server/agent/skills.ts` and appended to the planner
and ReAct loop system prompts.

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
  │       ├─ Authorization Check
  │       │   ├─ Allow if user is requester or in SLACK_APPROVAL_ADMIN_IDS
  │       │   └─ Deny → postEphemeral() + audit event + early return
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
- Single-letter units: `10m` → `10 minutes`, `2h` → `2 hours`, etc.
- `"let me know in X"` / `"know in X"` patterns

### Scheduled Triggers Poller

- Triggered on-demand via the scheduler poll webhook endpoint (`/api/cron/poll`) and on every workflow bootstrap (`/api/workflows/agentRun`).
- Atomic `DELETE ... FOR UPDATE SKIP LOCKED ... RETURNING *` prevents double-firing.
- Recurring triggers (cron/interval): re-inserted with next run time after claim.
- One-shot triggers: not re-inserted after firing.
- `cron-parser` (v5) for full cron expression support.
- Scheduled runs inherit the model from the goal's most recent run.
- Lifecycle is handled on-demand via HTTP webhooks, replacing persistent `setInterval` polling loops.
- Maintenance (`recoverStaleClaims`, `reapExpiredApprovals`, dedup cleanup, trigger polling) runs on every workflow invocation for low MTTR; daily Vercel Cron (`0 9 * * *`) is the idle-period safety net. On Vercel Pro, change `vercel.json` to `*/15 * * * *` for 15-minute idle coverage.

---

## 🔁 Semantic Message Deduplication

The agent suppresses near-duplicate Slack replies within the same thread using a
dual-strategy deduplication system:

1. **Exact hash match** — SHA-256 of normalized text (first 16 chars) for instant
   duplicate detection.
2. **Semantic similarity** — Jaccard similarity over FNV-1a 32-bit bigram hashes,
   catching paraphrased or near-identical messages (e.g., "The World Cup was won
   by Spain" vs "2026 World Cup was won by Spain").

### How It Works

- `src/server/agent/dedup.ts` implements `computeFingerprint()`, `jaccardSimilarity()`,
  `isNearDuplicate()`, and `storeMessageFingerprint()`.
- Fingerprints are stored in Redis (`dedup:thread:<channelId>:<threadTs>`) with a TTL,
  falling back to an in-memory LRU `Map` when Redis is unavailable.
- Short messages (< 3 bigrams / < 4 words) use exact-hash check only to avoid false
  positives.
- Deduplication is **fail-open**: errors never block a Slack post.

### Integration

`slack.replyInThread` calls `isNearDuplicate()` before posting. If suppressed, it
returns `{ status: 'suppressed' }` and the ReAct loop continues. The fingerprint is
stored **after** a successful post.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_DEDUP_SIMILARITY_THRESHOLD` | `0.75` | Jaccard similarity above which a message is suppressed (0.0–1.0) |
| `SLACK_DEDUP_WINDOW_SIZE` | `5` | Number of recent messages per thread to compare against |
| `SLACK_DEDUP_TTL_SECONDS` | `300` | TTL for stored fingerprints (5 minutes) |

### Why Semantic Dedup Matters

Without it, a model that generates slightly different phrasing for the same answer
(e.g. after a replan) would post a second near-duplicate Slack message. Semantic
dedup catches these while allowing genuinely new content through.

---

## 🔒 Security

### Content Security Policy (CSP)

A restrictive CSP is applied via `helmet` at server startup. All directives use `'self'` as the baseline, with specific allowances for the React/Vite dev environment:

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Baseline — everything same-origin |
| `script-src` | `'self'` `'unsafe-inline'` | Vite HMR injects inline module scripts in dev; React renders formatted content through `dangerouslySetInnerHTML` |
| `style-src` | `'self'` `'unsafe-inline'` `https://fonts.googleapis.com` | Tailwind CSS inline styles + Google Fonts stylesheet |
| `font-src` | `'self'` `https://fonts.gstatic.com` | Google Fonts woff2 delivery |
| `img-src` | `'self'` `data:` `https:` | Slack-hosted images and inline data URIs |
| `connect-src` | `'self'` `ws://localhost:3000` `ws://0.0.0.0:3000` | API calls + Vite HMR WebSocket |
| `frame-ancestors` | `'none'` | Clickjacking prevention |
| `object-src` | `'none'` | Block plugin execution |
| `base-uri` | `'self'` | Prevent base tag injection |
| `form-action` | `'self'` | Restrict form submission targets |

`upgrade-insecure-requests` is also present (helmet default), auto-upgrading HTTP resources to HTTPS.

### HTTP Security Headers

| Header | Value | Applied | Purpose |
|--------|-------|---------|---------|
| `X-Content-Type-Options` | `nosniff` | All responses | Prevent MIME-type sniffing |
| `X-Frame-Options` | `DENY` | All responses | Legacy clickjacking prevention |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Production only | Enforce HTTPS at browser level |
| `X-Powered-By` | Removed | All responses | Hide server info |
| `Referrer-Policy` | `no-referrer` | All responses | Prevent referrer leakage |

### Startup Validation

Environment variables are validated at boot in `src/server/env.ts`. The check runs before `app.listen()` and covers:

- **Critical vars** (all environments): `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- **Dashboard password** (all environments): `DASHBOARD_PASSWORD` — always warns if unset or placeholder; never hard-fails. Dashboard runs without auth (open access) when unset. Placeholder values are also warned, not fatal.
- **Database** (all environments): `DATABASE_URL`, `CLOUD_SQL_CONNECTION_NAME`, or `SQL_HOST` — at least one is required on all platforms (including Vercel). Missing/unconfigured database vars prevent startup.
- **`APP_URL`** (production only, required): webhook callbacks use localhost fallback in dev
- **Placeholder detection**: case-insensitive match against a blocklist (`MY_GEMINI_API_KEY`, `xoxb-myslackbottoken`, `my_slack_signing_secret`, `changeme`, `placeholder`, etc.) prevents accidental deployment with example values
- **`VERCEL=1`**: validation is enforced on all platforms including Vercel (bypass removed)
- **External adapter vars** (`TAVILY_API_KEY`, `GITHUB_TOKEN`, `EMAIL_WEBHOOK_URL`, `SANDBOX_API_KEY`): warned but never block boot

### Distributed Brute-Force Lockout

Dashboard authentication is protected by an IP-based brute-force lockout that is shared across all serverless instances via Redis:

- **Redis as source of truth**: On each failed login, `recordAuthFailure()` atomically creates or increments a counter with a 15-minute TTL anchored to the first failure. When the counter reaches 5, `lockoutAuth()` sets a lockout key.
- **Stale-local-counter immunity**: When Redis is available, the middleware trusts the Redis count as authoritative. If the shared 15-minute TTL window expires, the in-memory `Map` (which does not decay) cannot re-lock a legitimate admin. The local counter is only used as a fallback when Redis is unavailable.
- **Cross-instance consistency**: A warm serverless instance with a stale local counter cannot re-lock an IP after the shared Redis window has reset. Subsequent requests check `isAuthLockedOut()` against the Redis key before inspecting the local map.
- **Graceful fallback**: When Redis is not configured, the in-memory `Map` from earlier versions provides the same lockout guarantees (but per-instance only).

### HTTPS Redirect

In production, a middleware checks `x-forwarded-proto` (set by Cloud Run / Vercel edge) and issues an HTTP 301 redirect to `https://` when the header value is `http`. Disable with `DISABLE_HTTPS_REDIRECT=1`.

---

## 🗄 Database Schema

PostgreSQL with 12 idempotent migrations (v1–v12). All DDL uses `IF NOT EXISTS` / `IF EXISTS` guards.

### Tables

| Table | Purpose |
|-------|---------|
| `agent_goals` | Top-level user objectives with status tracking |
| `agent_plans` | Versioned step-by-step plans generated by the planner |
| `agent_runs` | Individual execution attempts (queue claims, lease tracking) |
| `agent_steps` | Ordered steps within a run (tool/generate/note) |
| `tool_calls` | Detailed tool execution records |
| `approval_requests` | Pending/resolved approval records with expiry, plan version scoping, and consumption tracking |
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

The background processing system runs on **Vercel Serverless Functions** with HTTP-based task triggering. Durable, long-running agent workflows execute via the `/api/workflows/agentRun` endpoint.

| Mechanism | Description |
|-----------|-------------|
| **Execution** | Self-triggered HTTP fetch to `/api/workflows/agentRun` with `waitUntil()` from `@vercel/functions` |
| **Trigger Retry** | Exponential backoff retry (3 attempts: 1s → 2s → 4s) on transient fetch failures (5xx, network errors). Client errors (4xx) are not retried. |
| **HTTP 508 Handling** | Treats HTTP 508 Loop Detected as terminal — prevents useless retries when Vercel identifies a recursive function-invocation chain. |
| **Atomic Run Claiming** | `claimQueuedRunById` atomically transitions a run from `queued` to `running`. Duplicate concurrent invocations for the same `runId` receive `null` and exit immediately, preventing the "concurrent-worker storm" bug. |
| **Scheduling** | Daily Vercel Cron (`0 9 * * *`) plus on-demand maintenance on every workflow bootstrap; upgrade to Pro and set `*/15 * * * *` in `vercel.json` for 15-minute idle coverage |
| **Stale Recovery** | `runSystemMaintenance()` (recoverStaleClaims + reapExpiredApprovals + dedup + trigger poll) on workflow bootstrap and daily cron |
| **Timeout Guard** | Cooperative wall-clock check (configurable `RUN_TIMEOUT_MS`, default 45s) before plan creation, each step, and verification — gracefully re-queues instead of hard-terminating on Vercel's serverless timeout |
| **Security** | Workflow endpoint secured via Vercel Automation Bypass secret for preview deployments; cron endpoint secured via `CRON_SECRET` |

*Note: The old `FOR UPDATE SKIP LOCKED` logic remains as a concurrency fallback for synchronous paths, but background execution and polling are entirely driven by Vercel serverless functions.*

---

## 🧪 Test Suite

28 test files, 355 test cases. Run with:

```bash
npm test              # Single run
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

| Suite | File | Tests | Coverage |
|-------|------|:-----:|----------|
| Env Validation | `tests/env.test.ts` | 31 | Missing/empty/placeholder vars, DB variants, VERCEL guard, APP_URL, adapter warnings, DASHBOARD_PASSWORD dev/prod split, DB/APP_URL placeholder detection, no value leaks |
| Security Headers | `tests/security-headers.test.ts` | 12 | CSP directives, HSTS, X-Frame-Options, nosniff, HTTPS redirect |
| Agent Handlers | `tests/handlers.test.ts` | 27 | direct reply, durable task, status query, approval response, cancel/update |
| Agent Extras | `tests/agent-extra.test.ts` | 23 | Plan mutation, intent ensure, pipeline dispatch, semaphore |
| State Management | `tests/state.test.ts` | 15 | Thread memory, dedup sets, intent hash, LRU eviction |
| Context Assembly | `tests/context.test.ts` | 14 | Thread history compaction, memory formatting, date/time context |
| Intent Classification | `tests/intent.test.ts` | 13 | Heuristic rules, LLM fallback, category dispatch |
| Attachment Conversion | `tests/attachments.test.ts` | 13 | Slack file download, size/count limits, MIME types, inlineData parts |
| Vercel Integration | `tests/vercel.test.ts` | 14 | Lazy migrations, cron auth, workflow trigger, retry, timeout guard |
| Auth Lockout | `tests/auth.test.ts` | 11 | Redis distributed lockout, in-memory fallback, audit safety |
| Approval Scope Creep | `tests/approval-scope-creep.test.ts` | 4 | Single-use consumption, plan-version scoping, mutation bump |
| System Maintenance | `tests/maintenance.test.ts` | 5 | Centralized maintenance: stale claims, approval expiry, dedup cleanup, trigger polling |
| Secret Sanitization | `tests/sanitize.test.ts` | 11 | Token/password/key detection and redaction |
| Gemini Client | `tests/geminiClient.test.ts` | 11 | mapStructured response parsing, thoughtSignature preservation |
| Web Search | `tests/webSearch.test.ts` | 10 | Tavily adapter integration, result formatting, error handling |
| Deferral Detection | `tests/deferral.test.ts` | 10 | Time-deferred language patterns, unit normalization, negative cases |
| Rate Limit Store | `tests/rateLimitStore.test.ts` | 10 | KV-backed store, sliding window, TTL expiry |
| Scheduler | `tests/scheduler.test.ts` | 8 | Cron parsing, interval triggers, one-shot scheduling |
| Semantic Message Deduplication | `tests/dedup.test.ts` | 17 | Fingerprinting, tokenization, Jaccard similarity, exact-hash check, Redis fallback |
| Planner | `tests/planner.test.ts` | 8 | Plan generation, date/time context injection |
| Policy Gate | `tests/policy.test.ts` | 7 | Risk level evaluation, approval requirement, policy decisions |
| Orchestrator + Planner | `tests/orchestrator-planner.test.ts` | 7 | Pipeline dispatch, plan mutation wiring |
| Agent Loop (Closed) | `tests/loop.test.ts` | 6 | Full closed-loop: plan→execute→verify→finalize |
| ReAct Agent Loop | `tests/agent-loop.test.ts` | 6 | runAgentLoop with tool calls, streaming yields, deadline, turn cap |
| Finalize | `tests/finalize.test.ts` | 6 | Run/goal status finalization, Slack reporting |
| Tool Registry | `tests/registry.test.ts` | 5 | Adapter registration, tool catalog freshness |
| Debug Mock | `tests/debug-mock.test.ts` | 1 | Simulated environment smoke test |

### CI Gate

`npm run lint` (`tsc --noEmit`) and `npm test` are the pre-merge CI gates.

---

## 📡 API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/slack/events` | Slack Events API webhook (signature verified) |
| `POST` | `/api/slack/interactivity` | Block Kit button callbacks (signature verified) |
| `GET` | `/api/health` | Health check: `{ status: 'ok', uptime: N }` |
| `POST` | `/api/workflows/agentRun` | Agent execution workflow (self-triggered) |
| `POST` | `/api/cron/poll` | Scheduled trigger poller (Vercel Cron) |

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
├── server.ts                          # Express entry point, exported for Vercel
├── vercel.json                        # Vercel routing and cron configuration
├── api/
│   ├── index.ts                       # Vercel serverless entry (re-exports Express app)
│   ├── cron/poll.ts                   # Vercel Cron handler for scheduled triggers
│   └── workflows/agentRun.ts          # Vercel Workflow handler for agent execution
├── src/
│   ├── App.tsx                        # React Dashboard UI
│   ├── main.tsx                       # React entry
│   ├── index.css                      # Tailwind CSS
│   ├── types.ts                       # Shared frontend/backend types
│   └── server/
│   ├── routes.ts                  # All API routes + Slack signature verify
│   ├── auth.ts                    # Dashboard password auth middleware
│   ├── env.ts                     # Startup environment variable validation
│   ├── state.ts                   # In-memory logs, model selection, dedup sets
│   ├── ai.ts                      # Gemini SDK wrapper
│   ├── rateLimitStore.ts          # KV-backed express-rate-limit store
│   ├── redis.ts                   # Vercel KV / Upstash Redis client
│       ├── agent/
│       │   ├── orchestrator.ts        # Pipeline entry point, resume logic
│       │   ├── intent.ts              # Heuristic + LLM intent classifier
│       │   ├── dedup.ts               # Semantic message deduplication (Jaccard + SHA-256)
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
│       │   ├── planNormalize.ts      # Plan normalization (tool hallucination fix)
│       │   ├── executor.ts           # Step execution (tool/generate/note)
│       │   ├── verifier.ts           # Rule-based post-execution verification
│       │   ├── semanticVerifier.ts   # LLM-based semantic verification
│       │   ├── loop.ts               # Closed loop (plan→exec→verify→replan)
│       │   ├── reactLoop.ts          # ReAct loop with streaming + function calling
│       │   ├── finalize.ts           # Run/goal status finalization
│       │   ├── reporter.ts           # Action-aware Slack run reports
│       │   ├── policy.ts             # Risk-level policy gate
│       │   ├── sanitize.ts           # Secret detection and redaction
│       │   ├── skills.ts             # Skill system prompt loader
│       │   ├── semaphore.ts          # Concurrency semaphore
│       │   ├── attachments.ts        # Slack file download + multimodal conversion
│       │   ├── maintenance.ts        # Centralized system maintenance (stale claims, approvals, dedup, triggers)
│       │   ├── worker.ts             # Webhook execution handler (formerly queue poller)
│       │   ├── scheduler.ts          # Scheduled trigger processor (formerly trigger poller)
│       │   ├── taskClient.ts         # Vercel Workflows/Cron client wrapper
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
│               ├── email.ts          # Email webhook adapter
│               ├── webSearch.ts      # Tavily web search adapter
│               ├── webFetch.ts       # Generic URL fetch adapter
│               └── sandbox.ts        # Vercel Sandbox code execution adapter
├── tests/
│   ├── handlers.test.ts              # 27 handler dispatch tests
│   ├── agent-extra.test.ts           # 23 plan mutation + pipeline tests
│   ├── state.test.ts                 # 15 state management tests
│   ├── context.test.ts               # 14 context assembly tests
│   ├── intent.test.ts                # 13 heuristic + LLM intent tests
│   ├── env.test.ts                   # 29 env validation tests
│   ├── security-headers.test.ts      # 12 security header tests
│   ├── sanitize.test.ts              # 11 secret redaction tests
│   ├── loop.test.ts                  # 6 agent-loop integration tests
│   ├── vercel.test.ts                # 14 Vercel integration tests
│   ├── attachments.test.ts           # 13 attachment processing tests
│   ├── geminiClient.test.ts          # 11 Gemini client response parsing tests
│   ├── webSearch.test.ts             # 10 web search adapter tests
│   ├── deferral.test.ts              # 10 time-deferred detection tests
│   ├── rateLimitStore.test.ts        # 10 KV rate limit store tests
│   ├── scheduler.test.ts             # 8 scheduled trigger tests
│   ├── planner.test.ts               # 8 plan generation tests
│   ├── policy.test.ts                # 7 policy gate tests
│   ├── orchestrator-planner.test.ts  # 7 pipeline dispatch tests
│   ├── agent-loop.test.ts            # 6 ReAct loop orchestration tests
│   ├── finalize.test.ts              # 6 run finalization tests
│   ├── registry.test.ts              # 5 tool registry tests
│   ├── maintenance.test.ts           # 5 system maintenance tests
│   └── debug-mock.test.ts            # 1 simulated environment smoke test
├── skills/
│   └── builtin/
│       ├── coding-standards.md       # Code style guidelines
│       ├── research-methodology.md   # Research approach for web searches
│       └── slack-communication.md    # Slack formatting and tone guidelines
├── docs/
│   ├── intent-routing.md             # Intent routing architecture spec
│   └── QA_CHECKLIST.md               # QA verification checklist
├── slack-manifest.json               # Slack App Manifest (copy-paste ready)
├── cloudbuild.yaml                   # GCP Cloud Build CI/CD pipeline
├── Dockerfile                        # Multi-stage Node 22 Alpine build
├── vitest.config.ts                  # Vitest configuration
├── vite.config.ts                    # Vite build configuration
├── CHANGELOG.md                      # Version history (v2.0.0 → v7.3.0 → unreleased)
├── .env.example                      # Environment variable template
└── package.json                      # Dependencies and scripts
```

---

## 🔐 Environment Variables

### Required (validated at boot)

Three are required in all environments; `DASHBOARD_PASSWORD` is warn-only everywhere (open access when unset):

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (HMAC verification) |
| `DASHBOARD_PASSWORD` | Password for the admin dashboard (production-required) |
| `APP_URL` | Base URL of your deployed application (production-required for webhook callbacks) |

### Database (at least one required — all platforms including Vercel)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Full PostgreSQL connection string |
| `CLOUD_SQL_CONNECTION_NAME` | GCP Cloud SQL instance (e.g., `project:region:instance`) |
| `SQL_HOST` + `SQL_USER` + `SQL_PASSWORD` + `SQL_DB_NAME` | Standard PostgreSQL params |

### Agent Context

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_INCLUDE_DATETIME` | `true` | Inject current date/time into all LLM prompts |
| `AGENT_TIMEZONE` | `UTC` | Timezone for date/time display (e.g. `America/Chicago`) |

### Thread History

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_THREAD_HISTORY_MESSAGES` | `20` | Max messages retained in thread history |
| `MAX_THREAD_HISTORY_CHARS` | auto | Cumulative char cap (model-aware budget if unset) |
| `MAX_THREAD_MESSAGE_CHARS` | `4000` | Per-message truncation limit |
| `THREAD_HISTORY_BUDGET_PERCENT` | `0.05` | % of model context window used for history budget |

### Attachments

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ATTACHMENT_BYTES` | `15728640` | Max file size per attachment (15 MB) |
| `MAX_ATTACHMENTS_PER_MESSAGE` | `4` | Max files processed per message |
| `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `20000` | Slack file download timeout |

### Model

| Variable | Default | Description |
|----------|---------|-------------|
| `SELECTED_MODEL` | `gemini-3.1-flash-lite` | Override default Gemini model |

### Vercel / Workflows

| Variable | Default | Description |
|----------|---------|-------------|
| `CRON_SECRET` | — | **Required on Vercel.** Bearer token for `/api/cron/poll` authentication (set in Vercel Project Settings) |
| `RUN_TIMEOUT_MS` | `45000` | Soft wall-clock limit for `runLoop()` (graceful re-queue) |
| `DIRECT_REPLY_CONCURRENCY` | `5` | Max concurrent direct-reply Gemini calls |
| `GEMINI_TIMEOUT_MS` | `30000` | Per-call Gemini API timeout |
| `WORKER_LEASE_SECONDS` | `300` | DB lease TTL for run claims |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | — | Bypass Vercel deployment protection for preview testing |

### Vercel KV / Redis

| Variable | Description |
|----------|-------------|
| `KV_REST_API_URL` | Vercel KV REST endpoint (event dedup, thread cache, rate limiting) |
| `KV_REST_API_TOKEN` | Vercel KV REST API token |
| `UPSTASH_REDIS_REST_URL` | Alternative: standalone Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Alternative: standalone Upstash Redis token |
| `DISABLE_HTTPS_REDIRECT` | Set to `1` to skip automatic HTTP→HTTPS redirect in production |

### Semantic Message Deduplication

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_DEDUP_SIMILARITY_THRESHOLD` | `0.75` | Jaccard similarity above which a message is suppressed (0.0–1.0) |
| `SLACK_DEDUP_WINDOW_SIZE` | `5` | Number of recent messages per thread to compare against |
| `SLACK_DEDUP_TTL_SECONDS` | `300` | TTL for stored fingerprints (5 minutes) |

### Vercel / Workflows Configuration

### External Adapters

| Variable | Enables | Risk Level | Description |
|----------|---------|:----------:|-------------|
| `TAVILY_API_KEY` | `search.query` | `read` | Web search via Tavily |
| `GITHUB_TOKEN` | `github.createIssue` | `external_write` | GitHub issue creation |
| `EMAIL_WEBHOOK_URL` | `email.send` | `external_write` | Email via webhook relay |
| `ENABLE_WEB_FETCH` | `web.fetch` | `read` | General URL fetching (SSRF protected) |
| `SANDBOX_API_KEY` | `sandbox.*` | `internal_write` | Vercel Sandbox code execution |

### Database Pool

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_SSL` | `false` | Enable SSL for database connections |
| `DB_POOL_MAX` | `5` | Max pool connections |
| `DB_CONNECTION_TIMEOUT` | `10000` | Connection timeout in ms |

---

## 🐳 Deployment (Vercel)

### Step 1: Push to Vercel
Connect your GitHub repository to Vercel. Vercel automatically detects the configuration and deploys:
1. Static Vite UI bundle at `/`
2. Serverless Express API at `/api/*`
3. Workflow API at `/api/workflows/agentRun`
4. Cron trigger at `/api/cron/poll`

### Step 2: Environment Variables
Set the following variables in your Vercel Project Settings:
- `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DASHBOARD_PASSWORD`
- `DATABASE_URL` (points to Vercel Postgres / Neon)
- `CRON_SECRET` (matching Vercel's Cron security configuration)
- `APP_URL` (your deployed Vercel project domain URL, e.g. `https://your-project.vercel.app`)

### Lifecycle

```
Start: database migrations checked lazily on request entrypoint
Stop: serverless execution terminates automatically upon response return
```

---

## 🐳 Self-Hosting with Docker

You can package and deploy the full-stack Slack AI Agent as a standalone Docker container. The built image is secure, minimal, runs under a non-root user, and is optimized for cloud runtimes (such as GCP Cloud Run, AWS ECS, or self-hosted virtual machines).

### Step 1: Build the Image
The build uses a multi-stage `Dockerfile` pinning Node 22 (Debian slim to support native Postgres/Google connectors) and runs the complete build pipeline to output both the static frontend and the compiled Express CJS server:

```bash
docker build -t slack-ez-cloud .
```

### Step 2: Configure Environment
Copy the included `.env.example` to `.env` (it contains placeholders and descriptions for all supported options) and fill in your values.

At a minimum, the container requires:
- **Core Credentials**: `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- **Dashboard Password**: `DASHBOARD_PASSWORD` (for logging in to the admin panel)
- **App URL**: `APP_URL` (the public-facing URL of your container, required for Slack webhook callbacks)
- **Database**: A Postgres database connection string in `DATABASE_URL` (or standard connection variables `SQL_HOST`, etc.).

*Note: A running PostgreSQL database is a runtime requirement only. Database migrations are lazily and automatically run during container boot — no database connection is required at image build time.*

### Step 3: Run the Container
Run the container on port 3000 (or any PORT of your choice):

```bash
docker run -d \
  -p 3000:3000 \
  --name slack-ez-cloud \
  --env-file .env \
  slack-ez-cloud
```

### Gaps and Differences from Vercel Deployment

When self-hosting with Docker, keep in mind the following platform-specific differences:
1. **Cron Poller**: Vercel Cron automatically triggers `/api/cron/poll` to run maintenance and trigger scheduled tasks. In Docker, you must set up an external scheduler or cron job (e.g., using crontab, AWS EventBridge, or GCP Cloud Scheduler) to hit the POST/GET `/api/cron/poll` endpoint regularly (e.g. every 15 minutes or daily at 9am UTC) with the correct `CRON_SECRET` headers.
2. **Key-Value / Redis Store**: In Vercel, Upstash Redis details are auto-injected. When self-hosting, you should manually supply standard Upstash/Redis connection variables (`KV_REST_API_URL` and `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`) in your `.env` file to enable shared rate-limiting, deduplication, and thread caches across instances. If unconfigured, the app gracefully falls back to an in-memory store.
3. **Sandbox Code Execution**: Vercel Sandbox tools are available natively only when deployed on Vercel. For self-hosting, sandbox tools require configuring a standalone `SANDBOX_API_KEY` for execution, or they will be skipped.

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
3. Update `request_url` values to your Vercel deployment URL:
   - Events: `https://YOUR_APP.vercel.app/api/slack/events`
   - Interactivity: `https://YOUR_APP.vercel.app/api/slack/interactivity`
4. **Install to Workspace** and authorize
5. Copy **Signing Secret** and **Bot User OAuth Token** into your environment

### Required Bot Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mention events |
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
git clone https://github.com/Brian125bot/vercel_ezslack.git
cd vercel_ezslack
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
| v5.0.0 | ✅ Done | Google Cloud Tasks migration, error boundary hardening, and reporting resilience |
| v6.0.8 | ✅ Done | Vercel Migration (Vercel Serverless, Vercel Workflows, Neon Postgres, Vercel Cron) |
| v6.1.4 | ✅ Done | Vercel Stability Hardening (cold-start model selection, retry, stale lease recovery, timeout guard) |
| v6.2.1 | ✅ Done | Production Reliability & Feedback Fixes (interactivity sig verify, model selection in slack.ts, step-level approval resume, confidence normalization, semaphore timeout, observability) |
| v6.3.0 | ✅ Done | Multimodal Input & Generic Output Injection (images/PDFs, `injectInto` field) |
| v6.4.0 | ✅ Done | Thread History Bounding & DB Bloat Fix (message/char caps, attachment metadata-only) |
| v6.5.0 | ✅ Done | Durable Run Attachments (persist attachments in DB, remove in-memory cache) |
| v6.6.0 | ✅ Done | Atomic Run Claiming & 508 Handling (prevent concurrent workers, 508 terminal state) |
| v6.7.0 | ✅ Done | Model-Aware Thread History Budget (context-window proportional budget) |
| v6.8.0 | ✅ Done | Fix order_index overflow — migration v11 `bigint`, sequential counter, remove SSL override |
| v6.9.1 | ✅ Done | Fix Gemini thoughtSignature to preserve raw parts through streaming response pipeline |
| v6.10.0 | ✅ Done | ReAct Loop with native tool-calling, streaming Slack replies, token cost tracking |
| v6.11.0 | ✅ Done | Configurable date/timezone context in all LLM prompt paths |
| v6.12.0 | ✅ Done | Intent-based deduplication with SHA-256 hash + Redis NX lock; Vercel KV backends for dedup + thread cache |
| v6.13.0 | ✅ Done | KV-backed express-rate-limit store for production rate limiting |
| v6.14.0 | ✅ Done | Skills system, Sandbox code execution adapter, WebFetch adapter, WebSearch adapter |
| v6.15.0 | ✅ Done | Bot mention stripping from `app_mention` events; thread history compaction for direct replies |
| v7.0.0 | ✅ Done | Startup env validation & security hardening (CSP, HSTS, HTTPS redirect, X-Frame-Options, nosniff) |
| v7.1.0 | ✅ Done | Centralized system maintenance (shared runSystemMaintenance, cron/workflow dedup) |
| v7.2.0 | ✅ Done | Env validation on Vercel, approval scope creep fix (plan_version_id, consumption) |
| v7.3.0 | ✅ Done | Redis distributed auth lockout, approval scope creep hardening, Vercel Analytics |
| v7.4.0 | ✅ Done | Gemini 3.7 Flash support (latest-gen model, 1M context, 8192 max output) |
| Unreleased | 🔄 In Progress | Semantic message deduplication (Jaccard + SHA-256), self-host Dockerfile, ReAct loop final answer persistence, SSRF Guard for `web.fetch` |
