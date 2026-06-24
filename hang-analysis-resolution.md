# Hang Analysis & Resolution Plan

## "Analyzing constraints and drafting a plan..." Never Returns

---

## Execution Path Overview

1. `routes.ts` → `classifyIntent` → `durable_task` → `runAgentPipeline`
2. `orchestrator.ts` → `handleDurableTask`
3. `durableTask.ts:93-95` posts **"Analyzing constraints and drafting a plan..."** to Slack
4. `durableTask.ts:77-81` creates a `queued` run in DB, returns `{ status: 'success', runId }`
5. Worker `processQueue` (every 2s) claims the queued run via `claimNextQueuedRun`
6. `worker.ts:74` calls `runLoop(run, workerId).catch(...).finally(...)` — fire-and-forget
7. `loop.ts:77` → `createPlan` → Gemini call with schema
8. `loop.ts:79-87` → saves plan to DB (`agent_plans.steps` as JSON)
9. `loop.ts:136-161` → **Hydration hack**: creates `agent_steps` rows from plan JSON
10. `loop.ts:162-195` → Executes each pending step via `executeStep`
11. `loop.ts:198-200` → Verification: `verifyRun` + `verifySemantically`
12. `loop.ts:207-255` → Success → `finalizeRun` → `reportRunResult` posts Slack reply; Failure → replan
13. `finalize.ts:34-48` → Posts final result to Slack via `reportRunResult`

The entire agent-to-user communication after "Analyzing..." depends on **Slack API calls succeeding** in steps that have no error surface to the user.

---

## Root Cause Analysis

### Critical Bug #1 — Silent Reporting Death

**File:** `finalize.ts:49-51`
**Impact:** User NEVER sees the final result, even when the run succeeds.

When the run completes, `finalizeRun` calls `reportRunResult(trace, context)` to post the result. If this Slack API call fails (rate limiting, empty `messageTs`, transient error, bot removed):

```typescript
} catch (err: any) {
    slog('finalize', 'report.error', { err: err.message, run_id: run.id });
    // ✦ ERROR SWALLOWED — user never sees this
}
```

- The run IS marked `succeeded` in the DB
- The error is logged to structured logs only (not visible to the user)
- **User sees "Analyzing constraints..." and then PERMANENT silence**

**Why it fails:**
- `context.messageTs` is `goal.source_message_ts` which is optional in the schema — often undefined/empty
- Slack API transient errors (429 rate limit, network blip)
- Channel archived or bot removed mid-execution

**Also affects the "blocked" and "failed" paths** — any run that hits `finalizeRun` can have its final message silently dropped.

---

### Critical Bug #2 — Orphaned Approval with No User Notification

**File:** `loop.ts:115-129`
**Impact:** Plan requires approval, Block Kit post fails silently, run is orphaned.

```typescript
if (planDraft.requiresApproval) {
    const approval = await agentStore.createApprovalRequest({...});
    const { postApprovalBlockKit } = await import('../tools/slack.js');
    await postApprovalBlockKit(approval, {...});  // ← THIS CAN FAIL
    await agentStore.updateRunStatus(run.id, 'awaiting_approval', { plan_id: planId });
    clearInterval(leaseHeartbeat);
    return;
}
```

If `postApprovalBlockKit` throws:
1. The error propagates to `runLoop`'s catch at line 257
2. `finalizeRun(run, 'failed', err.message)` is called
3. `finalizeRun`'s `reportRunResult` ALSO fails (same Slack API issue) → silently swallowed
4. **User sees "Analyzing constraints..." then NOTHING**
5. The approval request exists in DB as `pending` but user never saw it
6. It expires 30 minutes later, but the user was never notified

The same issue exists in `executor.ts:249` for step-level approvals.

---

### Bug #3 — Silent Planner Failure + Fallback Mask

**File:** `planner.ts:73-94`
**Impact:** All Gemini planning failures are hidden behind a fallback plan. Operators never know the planner is failing.

```typescript
try {
    const responseText = await geminiCall({...});
    // ... parse and normalize ...
} catch (err) {
    console.error('Planner failed:', err);  // ← console.error, not slog
}
// ← NO RETURN, falls through to fallback plan silently
```

- Every error (timeout, bad JSON, schema validation, normalization failure) is swallowed
- Uses `console.error` instead of `slog` — error is invisible in structured log aggregation
- The fallback plan only does `generate` + `slack.replyInThread` — no real tools executed
- The user gets a semantically empty reply ("I responded to your request") — task NOT actually done
- This can also produce empty-step scenarios that trigger the replan loop

---

### Bug #4 — Hydration Hack Can Produce Zero Steps

**File:** `loop.ts:140-158`
**Impact:** Empty steps trigger replan loop, burning all 3 iterations (~13.5 min silent wait).

```typescript
if (steps.length === 0 && run.plan_id) {
    const planObj = await agentStore.getRunTrace(run.id).then(t => 
       t.plan?.id === planId ? t.plan : null   // ← can return null
    );
    if (planObj && planObj.steps) {             // ← if null/empty, 0 steps created
        // ... creates step rows ...
    }
}
```

If `planObj` is null (race condition, plan deleted concurrently) or `planObj.steps` is empty:
- `currentSteps` = [] (empty array)
- The for loop at line 162 is skipped entirely
- `verifyRun([])` returns `{ status: 'not_satisfied', recommendedNextAction: 'replan' }`
- Replan → `plan_id = null`, re-queue
- **Next iteration**: same empty steps → ALL 3 MAX_ITERATIONS burned
- Each iteration costs 2 Gemini calls (plan + verify) × 135s each max = **~13.5 minutes of silence**

---

### Bug #5 — Excessively Long Stuck Detection Window

**File:** `worker.ts:12`
**Impact:** Silent failures go undetected for 10 minutes.

```typescript
const STUCK_GRACE_SECONDS = LEASE_SECONDS + 300; // 300s lease + 300s grace = 600s = 10 min
```

Combined with Bugs #1 and #2, the user waits **10 minutes** before the run is even detected as stuck, and even then the recovery just marks it failed with no user-facing notification (Bug #1 again).

---

### Bug #6 — No Progress Updates During Long Ops

The ONLY user-facing message during the entire run lifecycle is the initial "Analyzing constraints...". After that, the user hears nothing until `reportRunResult` fires (which silently fails via Bug #1).

Operations that can take a long time with zero feedback:
- **Planning**: up to 135s (30s timeout × 3 retries + backoff)
- **Step execution**: tool-dependent, some tools take 30-60s
- **Verification**: up to 135s (another Gemini call)
- **Total worst case**: 6-7 minutes of absolute silence from the user's perspective

---

### Bug #7 — Double-Finalize Path on runLoop Error

**File:** `worker.ts:74-83`
**Impact:** When `runLoop` throws, `finalizeRun` is called TWICE — once inside `runLoop`'s catch and once in the worker's `.catch()`.

```typescript
// loop.ts:257-260
} catch (err: any) {
    clearInterval(leaseHeartbeat);
    await finalizeRun(run, 'failed', err.message);  // ← FIRST call
}

// worker.ts:74-81  (fire-and-forget)
runLoop(run, workerId).catch(async (err) => {
    slog('worker', 'runLoop.error', { run_id: run.id, error: err.message });
    await finalizeRun(run, 'failed', err.message);  // ← SECOND call with STALE run
}).finally(() => {
    inFlightRuns.delete(run.id);
});
```

- `finalizeRun` is called twice with the same run
- The second call uses the stale `run` object from the closure, not the updated one from `runLoop`
- Second call's DB updates may fail (status already set to 'failed') or produce duplicate audit events
- The user-facing report is only attempted once (in `finalizeRun`) so no duplicate messages, but the DB operations could cause errors that are themselves swallowed

---

## Resolution Plan

### Fix 1 (Critical) — Surface Slack Post Failures

**File:** `finalize.ts:49-51`

Replace the empty catch block with a retry + fallback strategy:

1. **Primary**: Attempt full `reportRunResult` (as today)
2. **Fallback**: On failure, try a simplified direct-channel message via `slackReplyInThreadTool`
3. **Last resort**: Log prominently — if all Slack posting fails, the system is degraded and ops needs to know
4. Use `slog` at `error` level (not just the current `report.error` which is already there but buried)

Also in `reporter.ts:111-115`: replace `console.error` with `slog`.

---

### Fix 2 (Critical) — Handle Approval Post Failure

**File:** `loop.ts:115-129`

Wrap `postApprovalBlockKit` in try-catch:

1. On failure, mark the approval request as `failed` in DB
2. Fail the run immediately with a clear error message
3. `finalizeRun` will attempt to report the failure to the user
4. The user gets: "I created a plan but couldn't request your approval due to a Slack error. Please try again."

Same fix needed in `executor.ts:249` for step-level approval posts.

---

### Fix 3 (High) — Reduce Stuck Detection Grace Period

**File:** `worker.ts:12`

Change:
```typescript
const STUCK_GRACE_SECONDS = LEASE_SECONDS + 300; // 10 min
```
To:
```typescript
const STUCK_GRACE_SECONDS = LEASE_SECONDS + 120; // 5min lease + 2min grace = 7 min
```

With the 60s heartbeat, a healthy run renews the lease well before the 300s expiry. A stuck run will be detected in ~7 minutes instead of ~10.

---

### Fix 4 (High) — Add Progress Updates During Execution

**File:** `loop.ts` (new function `postProgress`)

Add intermediate Slack messages after key phases:

```typescript
// After plan creation
await postProgress("✅ Plan drafted. Starting execution...", context);

// After each step
await postProgress(`✅ Step ${n}/${total} complete`, context);

// During verification
await postProgress("🔍 Verifying results...", context);
```

Use fire-and-forget pattern (`.catch(() => {})`) — progress messages are non-critical and should never block the main flow.

---

### Fix 5 (High) — Make Planner Failures Observable

**File:** `planner.ts:93`

1. Replace `console.error` with `slog('planner', 'failed', { error: err.message, model: selectedModel })`
2. Add a `plannedUsingFallback: true` flag to the fallback plan so reports and logs can identify degraded operation
3. Consider reducing planner-specific Gemini timeout to 15s (planning responses are typically fast; no need for 30s)

---

### Fix 6 (Moderate) — Robust Step Hydration

**File:** `loop.ts:140-158`

1. Add null/empty guard: if `planObj` is null or `planObj.steps` is empty, log a warning
2. After hydration, re-fetch steps. If `currentSteps` is still empty, fail the run immediately:
   ```typescript
   if (currentSteps.length === 0) {
       await finalizeRun(run, 'failed', 'Plan produced no executable steps');
       return;
   }
   ```

---

### Fix 7 (Low) — Fix Double-Finalize and Stale Run

**File:** `loop.ts:257` and `worker.ts:74-83`

**Option A**: Don't call `finalizeRun` inside `runLoop`'s catch — let the worker's `.catch()` handle it. Simplest fix.

**Option B**: If `runLoop` catches and finalizes, it should signal the worker to skip its own `finalizeRun`. Add a flag or re-throw a sentinel error that the worker recognizes.

**Fix stale run**: In `worker.ts`'s `.catch()`, fetch the run fresh from DB instead of using the closure variable:
```typescript
.catch(async (err) => {
    const freshRun = await agentStore.getRun(run.id);
    await finalizeRun(freshRun, 'failed', err.message);
})
```

---

## Implementation Order

| Priority | Fix | Estimated Effort | Risk |
|----------|-----|-----------------|------|
| P0 | Fix 1 — Surface Slack failures | Small | Low |
| P0 | Fix 2 — Handle approval post failure | Small | Low |
| P1 | Fix 5 — Planner failures observable | Tiny | Low |
| P1 | Fix 4 — Progress updates | Medium | Low |
| P2 | Fix 3 — Reduce stuck detection | Tiny | Low |
| P2 | Fix 6 — Robust hydration | Small | Low |
| P3 | Fix 7 — Double-finalize + stale run | Small | Low |
