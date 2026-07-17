import { agentStore } from '../storage/agentStore.js';
import type { AgentRun, AgentRunTrace } from '../storage/types.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { createPlan } from './planner.js';
import { executeStep } from './executor.js';
import { finalizeRun } from './finalize.js';
import { verifyRun } from './verifier.js';
import { verifySemantically } from './semanticVerifier.js';
import { runAgentLoop } from './reactLoop.js';
import { slog } from './log.js';
import { toolsRegistry } from '../tools/registry.js';

const LEASE_SECONDS = parseInt(process.env.WORKER_LEASE_SECONDS || '300');
const MAX_ITERATIONS = 3;
const MAX_TRANSIENT_RETRIES = 1;
const LEASE_HEARTBEAT_MS = 60_000; // Renew lease every 60 seconds

/**
 * Single source of truth for the run wall-clock budget. If Vercel exposes
 * `MAX_DURATION` (function max runtime, in seconds), leave a 5s margin for
 * shutdown; otherwise fall back to RUN_TIMEOUT_MS (default 45s).
 */
export function getRunWallTimeMs(): number {
  const maxDuration = parseInt(process.env.MAX_DURATION || '0');
  if (maxDuration > 0) return Math.max(5000, maxDuration * 1000 - 5000);
  return parseInt(process.env.RUN_TIMEOUT_MS || '45000');
}

/** The agent loop is the default complex-task path; set `false` to fall back
 *  to the single-shot planner. */
export function isAgentLoopEnabled(): boolean {
  return process.env.AGENT_LOOP_ENABLED !== 'false';
}

/** True when this run was (or is being) driven by the ReAct loop — detected via
 *  the persisted conversation turns or the loop-authored plan summary prefix. */
function looksLikeLoopRun(run: AgentRun): boolean {
  return Array.isArray(run.agent_messages) && run.agent_messages.length > 0;
}

async function buildScopedTrace(runId: string, planId?: string | null): Promise<AgentRunTrace> {
  // Single call fetches run, goal, plan, steps, toolCalls, approvals, and auditEvents
  const trace = await agentStore.getRunTrace(runId);
  
  // Filter steps to the specific plan if provided
  const steps = planId 
    ? trace.steps.filter(s => s.plan_id === planId)
    : trace.steps;
  
  const stepIds = new Set(steps.map(s => s.id));
  const toolCalls = trace.toolCalls.filter(tc => tc.step_id && stepIds.has(tc.step_id));
  
  return {
    run: trace.run,
    goal: trace.goal,
    plan: trace.plan,
    steps,
    toolCalls,
    approvals: trace.approvals,
    auditEvents: trace.auditEvents
  };
}

export async function runLoop(runIn: AgentRun, workerId?: string): Promise<void> {
  let run = runIn;
  const runStartTime = Date.now();
  const wallTimeMs = getRunWallTimeMs();
  const deadlineMs = runStartTime + wallTimeMs;
  // Abort controller tied to the deadline: cancels in-flight Gemini calls when
  // the budget is nearly spent, instead of waiting for each call's own timeout.
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort('run_wall_clock'), Math.max(0, wallTimeMs - 2000));
  const wouldExceedTimeout = (): boolean => (Date.now() - runStartTime) >= wallTimeMs;

  slog('loop', 'runLoop.start', { run_id: run.id, goal_id: run.goal_id, worker_id: workerId, wall_time_ms: wallTimeMs });

  const goal = await agentStore.getGoal(run.goal_id);

  // Start lease heartbeat to prevent stale claim recovery during long operations
  const leaseHeartbeat = setInterval(() => {
    agentStore.renewLease(run.id, LEASE_SECONDS).catch(err => {
      slog('loop', 'lease_renewal_failed', { run_id: run.id, error: err.message });
    });
  }, LEASE_HEARTBEAT_MS);

  try {
    if (run.iteration_count && run.iteration_count >= MAX_ITERATIONS) {
      clearInterval(leaseHeartbeat);
      await finalizeRun(run, 'failed', `Max iterations (${MAX_ITERATIONS}) exhausted.`);
      return;
    }

let planId = run.plan_id;
    // Determine if the plan was approved wholesale (plan-level approval, not step-level)
    let isPlanPreApproved = false;
    // Track if we've consumed the plan approval already (single-use per plan version)
    let planApprovalConsumed = false;
    let planApprovalId: string | null = null;

    if (planId) {
      // Resume path — check if there's a plan-level approval (step_id IS NULL) for this plan version
      const planObj = await agentStore.getRunTrace(run.id).then(t => t.plan);
      const planVersionId = planObj ? `${planObj.id}:${planObj.version}` : null;
      let planApproval = null;
      if (planVersionId) {
        planApproval = await agentStore.getApprovedPlanApprovalForVersion(run.id, planVersionId);
      }
      isPlanPreApproved = !!planApproval;
      planApprovalId = planApproval?.id || null;

      // Transition from queued to running if resuming a previously approved plan
      if (run.status === 'queued') {
        run = await agentStore.updateRunStatus(run.id, 'running');
      }
    } else {
      // ── No plan yet: dispatch to the ReAct loop or the single-shot planner ──
      run = await agentStore.incrementRunIteration(run.id);

      // W5-C: Timeout guard before expensive plan creation / loop start
      if (wouldExceedTimeout()) {
        slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'plan_creation' });
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'queued', {
          claimed_by: null, claimed_at: null, lease_expires_at: null,
          failure_reason: `Run paused near wall-clock timeout (${wallTimeMs}ms) before plan creation`
        });
        const { enqueueRunTask } = await import('./taskClient.js');
      const requeued = await enqueueRunTask(run.id);
      if (!requeued) {
        slog('loop', 'reenqueue_failed_finalizing', { run_id: run.id });
        clearInterval(leaseHeartbeat);
        const { finalizeRun } = await import('./finalize.js');
        await finalizeRun(run, 'failed', `Re-enqueue failed after replan trigger or timeout`);
        return;
      }
      return;
      }

      // ── ReAct agent loop (default) ───────────────────────────────────────
      if (isAgentLoopEnabled()) {
        const execContext: import('./types.js').ToolExecutionContext = {
          runId: run.id,
          stepId: '',
          workspaceId: goal.workspace_id,
          channelId: goal.source_channel_id || '',
          userId: goal.created_by_user_id,
          messageTs: goal.source_message_ts || '',
          threadTs: goal.source_thread_ts || ''
        };

        const loopResult = await runAgentLoop(run, goal, {
          deadlineMs,
          signal: abortController.signal,
          execContext
        });

        // Reload run after the loop (plan_id may have been set, status may have changed).
        run = await agentStore.getRun(run.id) || run;
        planId = run.plan_id;

        if (loopResult.status === 'yield') {
          slog('loop', 'agent_loop_yield', { run_id: run.id, reason: loopResult.reason });
          clearInterval(leaseHeartbeat);
          if (loopResult.reason === 'approval') {
            // Run is already in awaiting_approval; the interactivity handler
            // resumes it via resumeAgentPipeline().
            return;
          }
          // Wall-clock: re-queue for resume (messages are persisted).
          await agentStore.updateRunStatus(run.id, 'queued', {
            claimed_by: null, claimed_at: null, lease_expires_at: null,
            failure_reason: `Loop yielded near wall-clock deadline (${wallTimeMs}ms)`
          });
          const { enqueueRunTask } = await import('./taskClient.js');
          const requeued = await enqueueRunTask(run.id);
          if (!requeued) {
            clearInterval(leaseHeartbeat);
            await finalizeRun(run, 'failed', 'Re-enqueue failed after loop yield');
          }
          return;
        }

        if (loopResult.status === 'capped') {
          slog('loop', 'agent_loop_capped', { run_id: run.id, reason: loopResult.reason });
          clearInterval(leaseHeartbeat);
          await finalizeRun(run, 'failed', loopResult.reason);
          return;
        }

        // Loop completed — fall through to the verify/finalize tail below using
        // the steps + tool_calls the loop persisted into the ledger.
        slog('loop', 'agent_loop_completed', { run_id: run.id });

      // ── Single-shot planner fallback ────────────────────────────────────
      } else {
        const ctx = await assembleContext(goal, run);
      const contextBlock = renderContextForPrompt(ctx);
      
      const planDraft = await createPlan(goal.title, goal.original_instruction, run.model, contextBlock, ctx?.attachments);
      
      const plan = await agentStore.createPlan({
        goal_id: goal.id,
        version: run.iteration_count || 1,
        summary: planDraft.summary,
        assumptions: planDraft.assumptions,
        risks: [{ level: planDraft.riskLevel, requiresApproval: planDraft.requiresApproval }],
        steps: planDraft.steps,
        status: 'active'
      });
      planId = plan.id;

      await agentStore.appendAuditEvent({
        workspace_id: goal.workspace_id,
        goal_id: goal.id,
        run_id: run.id,
        type: 'plan.created',
        actor: 'system',
        summary: `Plan created (iteration ${run.iteration_count})`,
        payload: { planDraft }
      });

      if (planDraft.requiresApproval) {
        const planVersionId = `${plan.id}:${plan.version}`;
        const approval = await agentStore.createApprovalRequest({
          goal_id: goal.id,
          run_id: run.id,
          requested_from_user_id: goal.created_by_user_id,
          channel_id: goal.source_channel_id,
          message_ts: goal.source_message_ts,
          title: 'Approve drafted plan',
          description: `The plan requires approval: ${planDraft.summary}`,
          risk_level: planDraft.riskLevel,
          proposed_action: { plan: planDraft },
          status: 'pending',
          expires_at: new Date(Date.now() + 30 * 60 * 1000),
          plan_version_id: planVersionId
        });

        // Post Block Kit approval message to Slack (previously missing for plan-level)
        const { postApprovalBlockKit } = await import('../tools/slack.js');
        try {
          await postApprovalBlockKit(approval, {
            runId: run.id,
            stepId: '',
            workspaceId: goal.workspace_id,
            channelId: goal.source_channel_id || '',
            userId: goal.created_by_user_id,
            messageTs: goal.source_message_ts || '',
            threadTs: goal.source_thread_ts || ''
          });

          await agentStore.updateRunStatus(run.id, 'awaiting_approval', { plan_id: planId });
        } catch (err: any) {
          slog('loop', 'postApprovalBlockKit.error', { run_id: run.id, err: err.message });
          await agentStore.updateApprovalStatus(approval.id, 'failed');
          throw new Error(`Failed to post plan approval to Slack: ${err.message}`);
        }
        clearInterval(leaseHeartbeat);
        return; // Yield
      }
      
      run = await agentStore.updateRunStatus(run.id, 'running', { plan_id: planId });
      } // end planner fallback
    } // end no-plan path

// Execute plan steps
    const steps = await agentStore.getStepsForPlan(planId);
    let executionUnblocked = true;

    // We only execute pending ones, since resumes might have some already complete
    if (steps.length === 0 && run.plan_id) { // Hack to hydrate if we just created
      const planObj = await agentStore.getRunTrace(run.id).then(t => 
         t.plan?.id === planId ? t.plan : null
       );
      if (planObj && planObj.steps) {
        let order = 0;
        for (const stepDraft of planObj.steps) {
          order++;
          await agentStore.createStep({
            run_id: run.id,
            plan_id: planId,
            order_index: order,
            title: stepDraft.title,
            status: 'pending',
            input: stepDraft as any
          });
        }
      }
    }

    const currentSteps = await agentStore.getStepsForPlan(planId);

    // Import toolsRegistry for risk level checking
    const { toolsRegistry } = await import('../tools/registry.js');

    for (const step of currentSteps) {
      if (step.status !== 'pending') continue;

      // W5-C: Timeout guard before each step execution
      if (wouldExceedTimeout()) {
        slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'step_execution', step: step.title });
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'queued', {
          claimed_by: null, claimed_at: null, lease_expires_at: null,
          failure_reason: `Run paused near wall-clock timeout (${wallTimeMs}ms) before step "${step.title}"`
        });
        const { enqueueRunTask } = await import('./taskClient.js');
      const requeued = await enqueueRunTask(run.id);
      if (!requeued) {
        slog('loop', 'reenqueue_failed_finalizing', { run_id: run.id });
        clearInterval(leaseHeartbeat);
        const { finalizeRun } = await import('./finalize.js');
        await finalizeRun(run, 'failed', `Re-enqueue failed after replan trigger or timeout`);
        return;
      }
      return;
      }

      // Pre-approved only if plan was approved wholesale OR this specific step was approved
      const stepApproval = !isPlanPreApproved
        ? await agentStore.getApprovedStepApproval(run.id, step.id)
        : null;

      const context = {
        runId: run.id,
        stepId: step.id,
        workspaceId: goal.workspace_id,
        channelId: goal.source_channel_id || '',
        userId: goal.created_by_user_id,
        messageTs: goal.source_message_ts || '',
        threadTs: goal.source_thread_ts || '',
        preApproved: isPlanPreApproved || !!stepApproval
      };

      await executeStep(run, step, context);

      // Consume plan approval after first use on an external_write tool step
      if (isPlanPreApproved && planApprovalId && !planApprovalConsumed) {
        const stepKind = (step.input as any)?.kind || 'tool';
        const toolName = (step.input as any)?.toolName;
        if (stepKind === 'tool' && toolName) {
          const tool = toolsRegistry.get(toolName);
          if (tool && tool.riskLevel === 'external_write') {
            await agentStore.consumeApproval(planApprovalId);
            await agentStore.appendAuditEvent({
              workspace_id: goal.workspace_id,
              goal_id: goal.id,
              run_id: run.id,
              step_id: step.id,
              type: 'plan.approval.consumed',
              actor: 'system',
              summary: `Plan approval consumed for external_write step: ${step.title}`,
              payload: { approvalId: planApprovalId, tool: toolName }
            });
            isPlanPreApproved = false;
            planApprovalConsumed = true;
          }
        }
      }

      const updatedStep = await agentStore.getStep(step.id);
      if (updatedStep.status === 'blocked') {
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'blocked');
        await finalizeRun(run, 'blocked', `Step ${updatedStep.title} is blocked.`);
        return;
      }
      if (updatedStep.status === 'failed') {
        executionUnblocked = false;
        run = await agentStore.updateRunStatus(run.id, 'running', { failure_reason: updatedStep.error });
        break;
      }
    }

    // W5-C: Timeout guard before verification
    if (wouldExceedTimeout()) {
      slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'verification' });
      clearInterval(leaseHeartbeat);
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null, claimed_at: null, lease_expires_at: null,
        failure_reason: `Run paused near wall-clock timeout (${wallTimeMs}ms) before verification`
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      const requeued = await enqueueRunTask(run.id);
      if (!requeued) {
        slog('loop', 'reenqueue_failed_finalizing', { run_id: run.id });
        clearInterval(leaseHeartbeat);
        const { finalizeRun } = await import('./finalize.js');
        await finalizeRun(run, 'failed', `Re-enqueue failed after replan trigger or timeout`);
        return;
      }
      return;
    }

    // Verify
    const trace = await buildScopedTrace(run.id, planId);
    const ruleVerify = verifyRun(trace);
    const semVerify = executionUnblocked ? await verifySemantically(trace, run.model) : null;

    // WS4: a semantic verdict only counts as a genuine miss when the model is
    // actually confident. Low-confidence / inconclusive results defer to the
    // rule-based verifier so flaky LLM output never burns replan iterations.
    const semanticMiss = !!semVerify && !semVerify.satisfied && (semVerify.confidence ?? 0) >= 0.5;

    if (executionUnblocked && ruleVerify.status === 'satisfied' && !semanticMiss) {
      // Success path falls through below.
    } else if (ruleVerify.recommendedNextAction === 'retry' && (run.retry_count || 0) < MAX_TRANSIENT_RETRIES) {
      // WS4: transient failure (e.g. a Slack post failed). Re-run the failed
      // steps within the SAME plan instead of throwing the whole plan away.
      run = await agentStore.incrementRunRetry(run.id);
      const failedSteps = (await agentStore.getStepsForPlan(planId)).filter(st => st.status === 'failed');
      for (const fs of failedSteps) {
        await agentStore.updateStepStatus(fs.id, 'pending');
      }
      slog('loop', 'transient_retry', { run_id: run.id, retry: run.retry_count, steps: failedSteps.length });
      // Re-queue for a fresh lease rather than recursing untracked.
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null, claimed_at: null, lease_expires_at: null,
        failure_reason: ruleVerify.reasons.join(', ')
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      const requeued = await enqueueRunTask(run.id);
      if (!requeued) {
        slog('loop', 'reenqueue_failed_finalizing', { run_id: run.id });
        clearInterval(leaseHeartbeat);
        const { finalizeRun } = await import('./finalize.js');
        await finalizeRun(run, 'failed', `Re-enqueue failed after replan trigger or timeout`);
        return;
      }
      return;
    } else {
      // Genuine miss -> replan from scratch (new plan next iteration).
      const reason = !executionUnblocked ? 'Step failed' :
                     (ruleVerify.status !== 'satisfied' ? ruleVerify.reasons.join(', ') : semVerify?.reasoning);

      // WS4: re-queue (lease-safe) instead of setImmediate recursion, which ran
      // the same run untracked and could double-execute on lease recovery.
      slog('loop', 'replan_triggered', { run_id: run.id, reason });
      clearInterval(leaseHeartbeat);
      // Re-queue the run instead of recursive setImmediate to respect MAX_CONCURRENT
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        plan_id: null, // Clear plan to force fresh plan creation
        failure_reason: reason
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      const requeued = await enqueueRunTask(run.id);
      if (!requeued) {
        slog('loop', 'reenqueue_failed_finalizing', { run_id: run.id });
        clearInterval(leaseHeartbeat);
        const { finalizeRun } = await import('./finalize.js');
        await finalizeRun(run, 'failed', `Re-enqueue failed after replan trigger or timeout`);
        return;
      }
      return; // Let the worker pick it up on next cycle
    }

    // Success
    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.semantic_verified',
      actor: 'system',
      summary: 'Semantic verification satisfied',
      payload: semVerify
    });
    clearInterval(leaseHeartbeat);
    await finalizeRun(run, 'succeeded');

  } catch (err: any) {
    clearInterval(leaseHeartbeat);
    slog('loop', 'runLoop.error', { run_id: run.id, error: err.message });
    await finalizeRun(run, 'failed', err.message);
  } finally {
    clearTimeout(abortTimer);
    slog('loop', 'runLoop.complete', {
      run_id: run.id,
      elapsed: Date.now() - runStartTime,
      final_status: run.status
    });
  }
}
