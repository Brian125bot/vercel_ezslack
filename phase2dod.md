# Definition of Done — Phase 2 Agentic Implementation

> **STATUS: COMPLETE** 🚀
> The project successfully implemented the Phase 2 Durable Agent Loop, inclusive of intent classification, cloud-native SQL storage schema, policy & approval boundaries, runtime executions, error verifications, and audit logging trails. This implementation fulfills the criteria detailed below.

The immediate agentic implementation is complete when this project reliably behaves as a durable, inspectable, Slack-native agent runtime backed by Cloud SQL PostgreSQL, while preserving the existing Slack chat experience.

This definition is the source of truth for acceptance. A feature is not done because the file exists or the module compiles. It is done when the behavior is observable through Slack, persisted in SQL, inspectable in the dashboard, and verified by runtime state.

---

## 1. Slack Ingress
Slack event handling remains stable and secure.

### Acceptance Criteria:
- Slack request signatures are verified using the raw request body.
- Requests older than Slack’s allowed replay window are rejected.
- Duplicate Slack events and duplicate Slack messages are ignored.
- Bot/self-originated messages are ignored.
- URL verification challenge still works.
- The webhook returns `200 OK` quickly before LLM calls, tool calls, database-heavy work, or Slack posting.
- Invalid signatures return `401`.
- Simulator requests still exercise the same `/api/slack/events` path.

### Done Check:
- Send a valid simulator message and receive `200 OK`.
- Send an invalid signature and receive `401`.
- Send a replay-aged request and receive `401`.
- Send the same event twice and see only one processing path.

---

## 2. Direct Chat Path
Simple Slack chat continues to work.

### Acceptance Criteria:
- Greetings, simple factual questions, and non-task requests use the direct reply path.
- Direct replies do not unnecessarily create durable agent runs.
- Thread memory still works for recent conversational context.
- Direct replies still work when the database is unavailable, as long as Gemini and Slack config are valid.
- Direct replies are logged in the dashboard event log.

### Done Check:
- Send "hello" or "what can you do?".
- The agent replies normally.
- No durable `agent_run` is created unless explicitly configured for audit-only behavior.

---

## 3. Durable Task Detection
Task-like messages are routed into the agent runtime.

### Acceptance Criteria:
- The intent router distinguishes:
  - `direct_reply`
  - `durable_task`
  - `status_query`
  - `approval_response`
  - `cancel_or_update`
  - `unsafe_or_unsupported`
- Task-like language creates a durable run.
- Short greetings and simple questions stay direct.
- Approval, cancellation, and status messages do not get treated as generic chat when they refer to known runs or approvals.
- Intent routing combines deterministic heuristics with model classification, but final routing is predictable and testable.

### Examples that must route to `durable_task`:
- "summarize this thread"
- "draft a response"
- "remind me tomorrow"
- "track this"
- "follow up next week"
- "investigate this issue"
- "watch this channel for deployment failures"

### Done Check:
- Each example creates a durable `agent_goal` and `agent_run`.
- "hello" and "what is this bot?" do not create durable runs.

---

## 4. Cloud SQL Persistence
Cloud SQL PostgreSQL is the durable source of truth for agent state.

### Acceptance Criteria:
- Production supports `CLOUD_SQL_CONNECTION_NAME`.
- Local development supports `DATABASE_URL`.
- Connection pooling is conservative for Cloud Run.
- `/api/status` reports:
  - `databaseConfigured`
  - `databaseAvailable`
- The app starts cleanly if DB is unavailable and reports that state instead of failing silently.
- Migrations are idempotent.
- No destructive migrations run automatically.
- SQL queries are parameterized.
- Runtime state survives app restart.

### Required Persisted Tables:
- `agent_goals`
- `agent_plans`
- `agent_runs`
- `agent_steps`
- `tool_calls`
- `approval_requests`
- `memory_records`
- `audit_events`
- `scheduled_triggers`
- `schema_migrations`

### Done Check:
- Start with Cloud SQL configured.
- Run migrations twice without errors.
- Create a task-like run.
- Restart the app.
- The run is still visible in the dashboard.

---

## 5. Store Abstraction
All agent persistence goes through a typed store layer.

### Acceptance Criteria:
- Route handlers do not perform raw SQL for agent lifecycle writes.
- Agent modules use an `AgentStore` or equivalent abstraction.
- Store methods are strongly typed.
- Multi-record lifecycle changes use transactions where consistency matters.
- Store methods throw clear errors for:
  - not found
  - invalid state transition
  - database unavailable
- Store methods sanitize audit payloads before persistence.

### Required Store Capabilities:
- create/update goal
- create/update plan
- create/update run
- create/update step
- create/update tool call
- create/resolve approval request
- write/search memory
- append audit event
- list runs
- get goal
- get full run trace

### Done Check:
- A durable task can be traced from goal through audit events without route-level SQL.

---

## 6. Status Semantics
Statuses are consistent across database rows, TypeScript types, runtime logic, and dashboard labels.

### Required Goal Statuses:
- `created`
- `planning`
- `running`
- `awaiting_approval`
- `blocked`
- `completed`
- `failed`
- `cancelled`

### Required Run Statuses:
- `queued`
- `planning`
- `running`
- `awaiting_approval`
- `blocked`
- `succeeded`
- `failed`
- `cancelled`

### Required Step Statuses:
- `pending`
- `running`
- `succeeded`
- `failed`
- `skipped`
- `blocked`

### Required Tool Call Statuses:
- `created`
- `running`
- `succeeded`
- `failed`
- `blocked`
- `requires_approval`

### Acceptance Criteria:
- No mixed synonyms like completed vs succeeded for the same entity type unless intentionally mapped.
- Finished timestamps are written for terminal statuses.
- Dashboard badges match backend statuses.
- Verification result maps cleanly to final run status.

### Done Check:
- Inspect a completed run and confirm goal, run, step, and tool statuses are internally consistent.

---

## 7. Agent Runtime Loop
The runtime owns the durable lifecycle.

### Acceptance Criteria:
- The orchestrator handles:
  - intent result
  - goal creation
  - run creation
  - plan creation
  - step creation
  - policy checks
  - tool execution
  - verification
  - final status update
  - reporting
  - audit events
- The route handler does not contain the full agent lifecycle inline.
- Background errors are caught and persisted.
- Runs do not stay permanently in transient statuses after failure.
- The run trace explains what happened without reading server logs.

### Done Check:
- Send a task-like Slack message.
- Confirm a full lifecycle trace exists in SQL and dashboard.

---

## 8. Planner
The planner produces structured, bounded plans.

### Acceptance Criteria:
- Planner output is structured JSON or typed data.
- Plans include:
  - summary
  - assumptions
  - ordered steps
  - risk level
  - approval requirement
- Plans are limited to a small number of steps for the immediate phase.
- Unsupported actions are explicitly marked blocked or approval-required.
- Planner does not fabricate unavailable tools.
- Planner does not use no-tool conceptual steps to bypass policy.

### Allowed Initial Tools:
- `slack.replyInThread`
- `memory.search`
- `memory.write`
- `task.record`

### Done Check:
- Ask for a GitHub issue to be created.
- The plan marks it unsupported or approval-required.
- No fake GitHub issue creation is reported.

---

## 9. Tool Registry
Tools are typed, registered, and policy-aware.

### Acceptance Criteria:
- Tools are invoked only through a registry.
- Each tool declares:
  - name
  - description
  - risk level
  - approval requirement
  - typed input
  - typed output
- Unknown tools fail safely.
- Tool inputs are validated or constrained before execution.
- Tool results are persisted as tool call outputs.
- Tool errors are persisted as tool call failures.

### Initial Allowed Tools:
- `slack.replyInThread`
- `memory.search`
- `memory.write`
- `task.record`

### Explicitly Out of Scope for Immediate Phase:
- shell execution
- browser control
- filesystem writes
- external email sending
- payment actions
- destructive external actions
- production admin actions

### Done Check:
- A plan referencing an unknown tool creates a blocked or failed step, not a silent success.

---

## 10. Policy
Policy blocks unsafe action before side effects.

### Risk Levels:
- `read`
- `draft`
- `internal_write`
- `external_write`
- `destructive`
- `privileged`

### Acceptance Criteria:
- `read` is allowed.
- `draft` is allowed.
- Safe `internal_write` is allowed.
- `external_write` requires approval.
- `destructive` is blocked.
- `privileged` is blocked.
- Policy decisions are written to audit events.
- Plan-level risk is enforced, not only tool-level risk.
- If approval is required and not present, the run becomes `awaiting_approval` or `blocked`.

### Done Check:
- Ask the agent to delete something or make an external system change.
- The run is blocked or awaits approval before any side effect.

---

## 11. Approvals
Approval-required actions are first-class runtime states.

### Acceptance Criteria:
- Approval requests are persisted.
- Approval records include:
  - goal id
  - run id
  - step id where applicable
  - tool call id where applicable
  - requested user
  - proposed action
  - risk level
  - status
  - expiration
- A run requiring approval is not marked successful.
- Rejected approvals keep the run blocked or failed with a clear reason.
- Expired approvals do not allow execution.
- Dashboard exposes pending approvals for a run.

*Note: Immediate phase does not require a full Slack button UI, but persisted approval state must exist and be inspectable.*

### Done Check:
- Trigger an external-write request.
- See an approval request in SQL and dashboard.
- The run is not marked successful.

---

## 12. Executor
Execution is durable and honest.

### Acceptance Criteria:
- Each step is persisted before execution.
- Each tool call is persisted before tool execution.
- Step and tool call status transitions are accurate.
- No-tool steps only succeed when they are explicitly non-actionable and do not represent the requested outcome.
- Execution stops on blocking errors.
- Non-idempotent actions are not retried automatically.
- Failures are visible in run trace.

### Done Check:
- Force a missing tool or failed Slack post.
- The step/tool call fails or blocks.
- The run does not report success.

---

## 13. Verification
Verification controls final success.

### Acceptance Criteria:
- The verifier compares actual state against the original goal and plan.
- Final outcomes are:
  - `satisfied`
  - `partially_satisfied`
  - `not_satisfied`
  - `blocked`
- A run is marked `succeeded` only if verification is `satisfied`.
- Blocked or approval-required plans cannot verify as `satisfied`.
- Verification result is persisted in audit events or a trace-visible record.
- Slack reporting uses the verification result, not optimistic assumptions.

### Done Check:
- Ask for an unsupported external action.
- The verifier returns `blocked` or `not_satisfied`.
- The run is not marked `succeeded`.

---

## 14. Reporting
Slack-facing reporting is accurate and concise.

### Acceptance Criteria:
- The agent reports:
  - `accepted`
  - `planned`
  - `completed`
  - `blocked`
  - `failed`
  - `awaiting approval`
- Reports are based on persisted runtime state.
- The agent never says “done” for a plan-only result.
- Blocked reports include the reason and next required action.
- Slack writes happen in the background path after ACK.

### Done Check:
- Complete a safe internal task and see a completion report.
- Trigger a blocked task and see a blocked report.

---

## 15. Dashboard
The dashboard provides enough visibility to debug an agent run.

### Acceptance Criteria:
- Agent Runs tab exists.
- Runs list shows:
  - run id
  - goal title
  - status
  - model
  - created time
- Run detail shows:
  - original instruction
  - normalized objective if available
  - Slack source metadata
  - plan summary
  - assumptions
  - steps
  - tool calls
  - approvals
  - verification result
  - audit timeline
  - errors
- Dashboard endpoints are protected by `requireDashboardAuth`.
- Empty, loading, error, and DB-unavailable states are clear.
- The UI does not require reading server logs to understand a run.

### Required Endpoints:
- `GET /api/agent/runs`
- `GET /api/agent/runs/:id`
- `GET /api/agent/goals/:id`
- `GET /api/agent/memory`
- `GET /api/agent/audit?runId=...`

### Done Check:
- Select a run and understand exactly why it succeeded, failed, or blocked.

---

## 16. Memory
Memory exists, but remains bounded and safe.

### Acceptance Criteria:
- Memory writes are explicit tool actions.
- Memory records include:
  - workspace
  - optional user
  - optional channel
  - kind
  - content
  - source
  - confidence
  - visibility
- Secrets are not stored.
- Sensitive user content is summarized or refused.
- Memory search is scoped by workspace and visibility.
- Memory records are visible through an authenticated dashboard endpoint.

### Done Check:
- Ask the agent to remember a harmless preference.
- It stores a memory record.
- Ask it to remember a token or password.
- It refuses or redacts and does not persist the secret.

---

## 17. Audit Trail
Every run has a replayable operational trace.

### Acceptance Criteria:
- Audit events are written for:
  - goal created
  - run created
  - plan created
  - step created
  - step started
  - step succeeded
  - step failed
  - tool created
  - tool started
  - tool succeeded
  - tool failed
  - policy allowed
  - policy blocked
  - approval requested
  - verification completed
  - report sent
  - run completed
  - run failed
  - run blocked
- Audit payloads are sanitized.
- Audit events are ordered by creation time.
- The dashboard displays audit events for a run.

### Done Check:
- A run can be reconstructed from audit events alone.

---

## 18. Security
The implementation does not leak secrets or expand permissions.

### Acceptance Criteria:
- Logs, audit events, memory records, and errors redact:
  - Slack bot tokens
  - Slack user tokens
  - Gemini/API keys
  - dashboard passwords
  - signing secrets
  - generic token, secret, password, api_key patterns
- External content is treated as untrusted.
- User messages cannot override policy.
- Tools cannot create new tools or permissions at runtime.
- Destructive and privileged tools are not available in the immediate phase.
- Database credentials are environment-only.

### Done Check:
- Send a fake Slack token in a message.
- It does not appear raw in logs, audit, memory, or dashboard.

---

## 19. Failure Behavior
Failures are explicit and recoverable.

### Acceptance Criteria:
- Background exceptions are caught.
- Failed runs end in failed or blocked, not transient status.
- Error messages are sanitized.
- Slack receives a useful failure/block message when appropriate.
- Dashboard shows the error and failed step/tool call.
- DB unavailable state does not crash non-agent functionality.

### Done Check:
- Force a planner or tool failure.
- The run ends in a terminal or blocked state with visible reason.

---

## 20. Build And Verification
The implementation must pass local checks.

### Required Checks:
- `npm run lint` passes
- `npm run build` passes

### Manual Checks:
- Start app without DB config.
- Start app with DB config.
- Run migrations twice.
- Use simulator for direct chat.
- Use simulator for durable task.
- Use simulator for unsupported external action.
- Use simulator for invalid signature.
- Use simulator for replay timestamp.
- Restart app and confirm run persistence.

---

## Operational Acceptance Scenarios

### Scenario 1: Direct chat
- **Input:** "hello, what can you do?"
- **Expected:**
  - Slack ACKs immediately.
  - Direct reply is generated.
  - No durable run is created unless audit-only mode is intentionally enabled.
  - Event log shows success.

### Scenario 2: Safe durable task
- **Input:** "summarize this thread and reply with three action items"
- **Expected:**
  - Slack ACKs immediately.
  - Goal, run, plan, steps, tool calls, and audit events are created.
  - Safe Slack reply runs or simulated dispatch is recorded.
  - Verifier marks satisfied.
  - Run becomes succeeded.
  - Dashboard shows full trace.

### Scenario 3: Unsupported external action
- **Input:** "create a GitHub issue from this thread"
- **Expected:**
  - Slack ACKs immediately.
  - Goal and run are created.
  - Plan identifies unsupported external write.
  - Approval request is created or run is blocked.
  - No GitHub action is faked.
  - Verifier does not mark satisfied.
  - Dashboard shows blocked reason.

### Scenario 4: Approval required
- **Input:** "notify an external customer about this outage"
- **Expected:**
  - Goal and run are created.
  - Policy marks external write as approval-required.
  - Approval request is persisted.
  - Run becomes awaiting_approval or blocked.

### Scenario 5: Secret Sanitization
- **Input:** "remember my API key xoxb-1234567890-abcdef"
- **Expected:**
  - Token is redacted in logs and audit.
  - Memory write is refused or sanitized.
  - Raw token is not stored.

### Scenario 6: DB unavailable
- **Environment:** No `DATABASE_URL` and no `CLOUD_SQL_CONNECTION_NAME`
- **Expected:**
  - App starts.
  - `/api/status` reports DB unavailable.
  - Dashboard still loads.
  - Direct chat path still works if Gemini and Slack config are valid.
  - Durable task creation reports DB unavailable without crashing.

---

## Final Acceptance Statement
The immediate agentic implementation is done when a user can send a task-like Slack message, the system creates a durable Cloud SQL-backed run, executes only safe approved actions, verifies the outcome before marking success, and exposes the full trace in the authenticated dashboard, while simple chat, security, and failure behavior continue to work correctly.
