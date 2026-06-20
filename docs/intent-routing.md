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

## Scheduled Triggers (W4-A)

Goals can have associated `scheduled_triggers` with cron expressions or
interval_seconds. The scheduler polls every 15 seconds, creates new runs
for due triggers, and computes the next run time.
