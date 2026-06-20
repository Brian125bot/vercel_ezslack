# Intent Routing Architecture

## Overview

Every incoming Slack message goes through intent classification before any processing.
The classifier determines how the message should be handled: as a quick direct reply,
a durable multi-step task, a status query, an approval response, a cancel/update, or
flagged as unsafe.

## Classification Flow

```
Incoming Message
  ├─ Heuristic rules (fast, no LLM call)
  │   ├─ Unsafe patterns → unsafe_or_unsupported
  │   ├─ Approval words + pending approval → approval_response
  │   ├─ Cancel/stop words → cancel_or_update
  │   ├─ Status query words → status_query
  │   ├─ Durable task words → durable_task
  │   └─ Short messages (<8 chars) → direct_reply
  │
  └─ LLM fallback (Gemini, structured JSON output)
      └─ Returns { intent, confidence } or falls back to direct_reply
```

## Intent Categories

| Intent | Handler | Pipeline |
|---|---|---|
| `direct_reply` | `handleDirectReply` | DB-less Gemini call → Slack reply |
| `durable_task` | `handleDurableTask` | Goal → Run → Plan → Execute → Verify → Finalize |
| `status_query` | `handleStatusQuery` | Query `agent_goals`/`agent_runs` → Slack reply |
| `approval_response` | `handleApprovalResponse` | Resolve approval → Resume blocked run |
| `cancel_or_update` | `handleCancelUpdate` | Cancel run + update status |
| `unsafe_or_unsupported` | `handleUnsafeUnsupported` | Log + refusal message |

## Step Kinds (W3)

The planner can emit steps with different `kind` values:

| Kind | Behaviour |
|---|---|
| `tool` | Executes a registered tool from the registry |
| `generate` | Calls Gemini at execution time to produce content |
| `note` | No-op conceptual step (always succeeds) |

The `generate` kind solves the "chat wrapper" problem: instead of the planner baking
reply content at plan time (when it doesn't have tool outputs yet), it defers content
generation to execution time when upstream step outputs are available.

## Tool Registry

Tools are registered at startup:
- **Core tools** (always available): `slack.replyInThread`, `memory.write`, `memory.search`, `task.record`
- **External adapters** (conditional on env vars): `github.createIssue`, `email.send`

External adapter tools declare `riskLevel: 'external_write'` and go through the
policy gate, which requires explicit user approval via Block Kit buttons.

## Approval Flow (W3-C)

```
Policy blocks tool → Post Block Kit message (Approve/Reject buttons)
  → User clicks button
  → POST /api/slack/interactivity
  → Resolve approval in DB
  → Update Block Kit message (remove buttons)
  → If approved: resume pipeline
  → If rejected: cancel run
```

## Plan Mutation (W4-C)

Users can modify pending plan steps with natural language:
- "Change step 2 to search memory instead"
- "Add a step to post in #general"
- "Remove the email step"

The mutation engine uses Gemini to interpret the instruction and applies
add/remove/replace/modify operations to pending steps.

## Time-Deferred Detection (W4-F1)

When a `durable_task` message contains time-deferred language, the handler
creates a `scheduled_trigger` instead of an immediate run:

```
"remind me tomorrow to check the deploy"
  → detectDeferral() → { deferred: true, delayMs: ~24h, label: "remind you tomorrow" }
  → createScheduledTrigger({ next_run_at: tomorrow 9 AM })
  → No immediate run created
  → Scheduler fires the trigger at the scheduled time
```

Supported patterns:
- `"remind me in N (minutes|hours|days|weeks)"`
- `"remind me tomorrow"`
- `"follow up (tomorrow|next week|in N units)"`
- `"schedule (this|it) for tomorrow / next week / in N units"`
- Bare `"in N units"` with action verb context (e.g., `"check this in 2 hours"`)

Messages without time-deferred language are queued immediately as before.

## Cancel vs Update Sub-Classification (W4-C)

The `cancel_or_update` handler sub-classifies the user's intent:

| Pattern | Action |
|---|---|
| "cancel", "stop", "abort", "kill", "end", "halt", "nevermind" | Cancel all active runs |
| Everything else | Call `mutatePlan()` on the active run's plan |

This allows mid-run plan modification: `"actually, also include the action items"`
modifies pending steps rather than cancelling the entire run.

## Scheduled Triggers (W4-A)

Goals can have associated `scheduled_triggers` with cron expressions or
interval_seconds. The scheduler polls every 15 seconds, creates new runs
for due triggers, and computes the next run time. Scheduled runs inherit
the model from the goal's most recent run.
