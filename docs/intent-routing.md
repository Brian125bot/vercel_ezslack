# Intent Routing Taxonomy

This document outlines the design and operational specifics of the robust runtime intent classification system implemented in the agent core. Refer to `src/server/agent/intent.ts` as the canonical source.

---

## 1. Intent Categories

The agent classifies every incoming message into exactly one of six distinct categories:

1. **`direct_reply`**
   * **Purpose**: General casual conversation, social pleasantries, greetings, chitchat, or direct questions seeking conversational explanations rather than multi-step tool executions.
2. **`durable_task`**
   * **Purpose**: Complex, multi-step actions or goals that require background tracking, plan formation, and automated tool executions (such as creating summaries, setting reminders, or creating tasks).
3. **`status_query`**
   * **Purpose**: Questions checking on previous/current execution processes, listing goals or runs, or tracking progress.
4. **`approval_response`**
   * **Purpose**: Interactive responses confirming or rejecting a drafted proposal (e.g. approving a plan to proceed or rejecting it).
5. **`cancel_or_update`**
   * **Purpose**: Requests to stop, kill, abort, or cancel an active background goal.
6. **`unsafe_or_unsupported`**
   * **Purpose**: Static boundaries catching malicious inputs, shell injection patterns, unauthorized system actions, or destructive request types.

---

## 2. Classification Pipeline Flow

The intent classifier runs through three chronological stages to resolve the intent:
1. **Heuristic Patterns Check**: Low-latency, high-accuracy string match filters. If a strong heuristic matches, the model evaluation is bypassed entirely.
2. **LLM Fallback Processing**: If heuristics are inconclusive, the active Gemini model is invoked with a structured classification prompt requesting a JSON response block.
3. **Robust Default**: If errors occur during LLM evaluation, it gracefully falls back to a low-confidence `direct_reply`.

---

## 3. Heuristic Matching Rules

### 3.1 Unsafe or Unsupported Triggers
Matches if the message contains any of the following substrings (case-insensitive):
* `rm -rf`
* `delete database`, `drop database`
* `truncate table`, `drop table`
* `delete from users`, `delete files`
* `shutdown`
* `wipe server`
* `sudo `
* `eval(`
* `format c:`
* `:(){ :|:& };:`
* `privileged`

### 3.2 Approval Responses
Matches only if the lowercase word matches (or starts with) any of these phrases **and** `hasPendingApproval` context is active:
* `approve`, `approved`
* `reject`, `rejected`
* `confirm`
* `yes`, `no`
* `proceed`
* `deny`, `allow`, `disallow`
* `go ahead`
* `stop execution`
* `cancel proposal`

*Note*: If `hasPendingApproval` is `false`, simple approval words (e.g., `yes`, `no`) bypass this block and are treated as `direct_reply` to preserve conversational flow.

### 3.3 Cancel or Update Triggers
Matches if the message includes any of these phrases (case-insensitive):
* `cancel run` / `cancel task` / `cancel goal`
* `stop run` / `stop task`
* `abort run` / `abort task`
* `kill run` / `delete goal`
* `update step` / `change plan` / `modify task`

### 3.4 Status Queries
Matches if the message contains any of these phrases (case-insensitive):
* `status of` / `get status` / `check status` / `any status`
* `what is the status` / `any update on` / `how is the task`
* `show runs` / `list runs` / `list tasks` / `list goals`

### 3.5 Durable Task Triggers
Matches if the message includes any of these high-intent triggers (case-insensitive):
* `remind`, `schedule`, `follow up`, `notify me`
* `create`, `track`, `watch`, `summarize`, `draft`, `investigate`
* `open a task`, `add issue`, `create ticket`, `alert`
* `run task`, `execute command`, `monitor`, `backup`, `restore`

### 3.6 Very Short Message Heuristic
Any message under 8 characters that did not trigger any of the above heuristics defaults directly to `direct_reply` (e.g. "hey", "hello", "ok", "help").

---

## 4. Pending Approval Constraint Rule

The classifier is context-aware via `IntentContext`. Even if a message contains approval tokens ("yes", "approve") or is classified as such by the LLM layer, **it will be coerced to a `direct_reply` if there is no pending approval recorded in the active workspace channel thread.** This guarantees conversational queries are never hijacked by unintentional approval triggers.

---

## 5. IntentResult Signature and Flow

```typescript
export interface IntentResult {
  intent: IntentCategory;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristic' | 'llm' | 'fallback';
}
```

The unified `classifyIntent` handler is dispatched directly by `orchestrator.ts` toward dedicated decoupled handlers in `src/server/agent/handlers/` directory:
* `unsafe_or_unsupported` ➡️ `src/server/agent/handlers/unsafeUnsupported.ts`
* `approval_response` ➡️ `src/server/agent/handlers/approvalResponse.ts`
* `cancel_or_update` ➡️ `src/server/agent/handlers/cancelUpdate.ts`
* `status_query` ➡️ `src/server/agent/handlers/statusQuery.ts`
* `durable_task` ➡️ `src/server/agent/handlers/durableTask.ts`
* `direct_reply` ➡️ `src/server/agent/handlers/directReply.ts`
