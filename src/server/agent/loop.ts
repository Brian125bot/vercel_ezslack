import { agentStore } from '../storage/agentStore.js';
import type { AgentRun, AgentRunTrace } from '../storage/types.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { createPlan } from './planner.js';
import { executeStep } from './executor.js';
import { finalizeRun } from './finalize.js';
import { verifyRun } from './verifier.js';
import { verifySemantically } from './semanticVerifier.js';
import { slog } from './log.js';

const LEASE_SECONDS = parseInt(process.env.WORKER_LEASE_SECONDS || '300');
const MAX_ITERATIONS = 3;
const MAX_TRANSIENT_RETRIES = 1;
const LEASE_HEARTBEAT_MS = 60_000; // Renew lease every 60 seconds
const MAX_RUN_WALL_TIME_MS = parseInt(process.env.RUN_TIMEOUT_MS || '45000'); // Soft limit: re-queue before Vercel timeout

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
  const wouldExceedTimeout = (): boolean => (Date.now() - runStartTime) >= MAX_RUN_WALL_TIME_MS;

  slog('loop', 'runLoop.start', { run_id: run.id, goal_id: run.goal_id, worker_id: workerId });

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

    if (planId) {
      // Resume path — check if there's a plan-level approval (step_id IS NULL)
      const planApproval = await agentStore.getApprovedPlanApproval(run.id);
      isPlanPreApproved = !!planApproval;

      // Transition from queued to running if resuming a previously approved plan
      if (run.status === 'queued') {
        run = await agentStore.updateRunStatus(run.id, 'running');
      }
    } else {
      // Create new plan path
      run = await agentStore.incrementRunIteration(run.id);

      // W5-C: Timeout guard before expensive plan creation
      if (wouldExceedTimeout()) {
        slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'plan_creation' });
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'queued', {
          claimed_by: null, claimed_at: null, lease_expires_at: null,
          failure_reason: `Run paused near wall-clock timeout (${MAX_RUN_WALL_TIME_MS}ms) before plan creation`
        });
        const { enqueueRunTask } = await import('./taskClient.js');
        await enqueueRunTask(run.id);
        return;
      }

      const ctx = await assembleContext(goal, run);
      const contextBlock = renderContextForPrompt(ctx);
      
      const planDraft = await createPlan(goal.title, goal.original_instruction, run.model, contextBlock);
      
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
          expires_at: new Date(Date.now() + 30 * 60 * 1000)
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
    }

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

    for (const step of currentSteps) {
      if (step.status !== 'pending') continue;

      // W5-C: Timeout guard before each step execution
      if (wouldExceedTimeout()) {
        slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'step_execution', step: step.title });
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'queued', {
          claimed_by: null, claimed_at: null, lease_expires_at: null,
          failure_reason: `Run paused near wall-clock timeout (${MAX_RUN_WALL_TIME_MS}ms) before step "${step.title}"`
        });
        const { enqueueRunTask } = await import('./taskClient.js');
        await enqueueRunTask(run.id);
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
        failure_reason: `Run paused near wall-clock timeout (${MAX_RUN_WALL_TIME_MS}ms) before verification`
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      await enqueueRunTask(run.id);
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
      await enqueueRunTask(run.id);
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
      await enqueueRunTask(run.id);
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
    slog('loop', 'runLoop.complete', {
      run_id: run.id,
      elapsed: Date.now() - runStartTime,
      final_status: run.status
    });
  }
}
