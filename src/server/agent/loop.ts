/**
 * Closed-Loop Runtime (W2-C).
 *
 * Drives a single claimed run through: assemble context -> plan -> execute -> verify (rule +
 * semantic) -> replan, up to MAX_ITERATIONS. A run only SUCCEEDS when both the mechanical
 * verifier and the semantic verifier agree the goal was met. Blocked plans (e.g. awaiting
 * approval) yield without a terminal status; the worker re-claims them when re-queued.
 *
 * All terminal transitions go through finalizeRun (the single terminal code path, W2-F11).
 */
import { agentStore } from '../storage/agentStore.js';
import { createPlan } from './planner.js';
import { executeStep } from './executor.js';
import { verifyRun } from './verifier.js';
import { verifySemantically } from './semanticVerifier.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { finalizeRun } from './finalize.js';
import { reportStatus } from './reporter.js';
import { slog } from './log.js';
import type { AgentRun, AgentRunTrace } from '../storage/types.js';
import type { ToolExecutionContext } from './types.js';

export const MAX_ITERATIONS = 3;

export async function runLoop(runInput: AgentRun): Promise<void> {
  let run = runInput;
  const goal = await agentStore.getGoal(run.goal_id);

  const baseContext: ToolExecutionContext = {
    runId: run.id,
    stepId: '',
    workspaceId: goal.workspace_id,
    channelId: goal.source_channel_id || '',
    userId: goal.created_by_user_id,
    messageTs: goal.source_message_ts || '',
    threadTs: goal.source_thread_ts || undefined,
  };

  const finalize = (state: 'succeeded' | 'failed' | 'cancelled' | 'blocked', opts: { summary?: string; failureReason?: string }) =>
    finalizeRun({ runId: run.id, goalId: goal.id, workspaceId: goal.workspace_id, state, context: baseContext, ...opts });

  // Resume path: the user approved a previously drafted plan that hasn't executed yet.
  const existingApprovals = await agentStore.getApprovalsForRun(run.id);
  const approvedPlanApproval = existingApprovals.find(
    (a) => a.status === 'approved' && (a.proposed_action as any)?.plan
  );
  let resumeApprovedPlan = !!approvedPlanApproval && !!run.plan_id;

  let replanFeedback: string | undefined;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const iteration = await agentStore.incrementRunIteration(run.id);
    slog('loop', 'iteration.start', { runId: run.id, iteration, resume: resumeApprovedPlan });

    let planId: string;
    let planSteps: any[];
    let preApproved = false;

    if (resumeApprovedPlan && run.plan_id) {
      // Execute the already-approved plan exactly as approved.
      const trace0 = await agentStore.getRunTrace(run.id);
      if (!trace0.plan) {
        await finalize('failed', { failureReason: 'Approved plan could not be loaded.' });
        return;
      }
      planId = trace0.plan.id;
      planSteps = Array.isArray(trace0.plan.steps) ? (trace0.plan.steps as any[]) : [];
      preApproved = true;
      run = await agentStore.updateRunStatus(run.id, 'running');
    } else {
      // Plan fresh with assembled context + any replan feedback.
      const ctx = await assembleContext({
        goal,
        run,
        workspaceId: goal.workspace_id,
        channelId: baseContext.channelId,
        userId: baseContext.userId,
        threadTs: baseContext.threadTs,
        replanFeedback,
      });
      const planDraft = await createPlan(goal.title, goal.original_instruction, run.model, renderContextForPrompt(ctx));
      const plan = await agentStore.createPlan({
        goal_id: goal.id,
        version: iteration,
        summary: planDraft.summary,
        assumptions: planDraft.assumptions,
        risks: [{ level: planDraft.riskLevel, requiresApproval: planDraft.requiresApproval }],
        steps: planDraft.steps,
        status: 'active',
      });
      run = await agentStore.updateRunStatus(run.id, 'running', { plan_id: plan.id } as any);
      await agentStore.appendAuditEvent({
        workspace_id: goal.workspace_id,
        goal_id: goal.id,
        run_id: run.id,
        type: 'plan.created',
        actor: 'system',
        summary: `Plan v${plan.version} created: ${planDraft.summary}`,
        payload: { version: plan.version, iteration, replan: i > 0, planDraft },
      });

      // Plan requires explicit approval and we don't yet have one -> yield (non-terminal).
      if (planDraft.requiresApproval && !approvedPlanApproval) {
        await agentStore.createApprovalRequest({
          goal_id: goal.id,
          run_id: run.id,
          requested_from_user_id: goal.created_by_user_id,
          channel_id: baseContext.channelId,
          message_ts: baseContext.messageTs,
          title: 'Approve drafted plan',
          description: `This plan requires approval: ${planDraft.summary}`,
          risk_level: planDraft.riskLevel,
          proposed_action: { plan: planDraft },
          status: 'pending',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        await agentStore.updateRunStatus(run.id, 'awaiting_approval');
        await agentStore.appendAuditEvent({
          workspace_id: goal.workspace_id,
          goal_id: goal.id,
          run_id: run.id,
          type: 'approval.requested',
          actor: 'system',
          summary: 'Plan requires user approval before execution',
          payload: { summary: planDraft.summary },
        });
        await reportStatus('awaiting_approval', `${planDraft.summary}. Reply "approve" to proceed.`, baseContext);
        slog('loop', 'yield.awaiting_approval', { runId: run.id });
        return;
      }

      planId = plan.id;
      planSteps = planDraft.steps;
      preApproved = !!approvedPlanApproval;
    }

    // ---- Execute the plan's steps ----
    const execContext: ToolExecutionContext = { ...baseContext, preApproved };
    let order = 0;
    for (const stepDraft of planSteps) {
      const step = await agentStore.createStep({
        run_id: run.id,
        plan_id: planId,
        order_index: order++,
        title: stepDraft.title || `Step ${order}`,
        status: 'pending',
        input: stepDraft,
      } as any);
      execContext.stepId = step.id;
      await executeStep(run, step, execContext);
    }

    // ---- Verify: rule-based, then semantic. Both must agree to succeed. ----
    const scopedTrace: AgentRunTrace = await buildScopedTrace(run.id, planId);
    const ruleResult = verifyRun(scopedTrace);
    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.verified',
      actor: 'system',
      summary: `Rule verification: ${ruleResult.status}`,
      payload: { ruleResult, iteration },
    });

    if (ruleResult.status === 'blocked') {
      await finalize('blocked', { failureReason: ruleResult.reasons.join('; ') });
      return;
    }

    const semantic = await verifySemantically(scopedTrace, run.model);
    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.semantic_verified',
      actor: 'system',
      summary: `Semantic verification: ${semantic.satisfied ? 'satisfied' : 'not satisfied'} (${semantic.confidence}, ${semantic.source})`,
      payload: semantic,
    });

    if (ruleResult.status === 'satisfied' && semantic.satisfied) {
      await finalize('succeeded', { summary: `Goal completed: ${goal.title}` });
      return;
    }

    // Neither verifier was fully satisfied -> prepare replan feedback and iterate.
    replanFeedback = `Rule check (${ruleResult.status}): ${ruleResult.reasons.join('; ') || 'n/a'}. Semantic check: ${semantic.reasoning}`;
    resumeApprovedPlan = false;
    slog('loop', 'replan', { runId: run.id, iteration, feedback: replanFeedback });
  }

  // Exhausted iterations without satisfying the goal (W2-F7).
  await finalize('failed', { failureReason: `Max iterations (${MAX_ITERATIONS}) reached without satisfying the goal. Last feedback: ${replanFeedback || 'n/a'}` });
}

/** Build a run trace whose steps are scoped to a single plan (the current iteration). */
async function buildScopedTrace(runId: string, planId: string): Promise<AgentRunTrace> {
  const trace = await agentStore.getRunTrace(runId);
  const steps = await agentStore.getStepsForPlan(planId);
  return { ...trace, steps };
}
