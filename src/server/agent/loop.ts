import { agentStore } from '../storage/agentStore.js';
import type { AgentRun, AgentRunTrace } from '../storage/types.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { createPlan } from './planner.js';
import { executeStep } from './executor.js';
import { finalizeRun } from './finalize.js';
import { verifyRun } from './verifier.js';
import { verifySemantically } from './semanticVerifier.js';
import { slog } from './log.js';

const MAX_ITERATIONS = 3;

async function buildScopedTrace(runId: string, planId?: string | null): Promise<AgentRunTrace> {
  const steps = planId 
    ? await agentStore.getStepsForPlan(planId)
    : await agentStore.getStepsForRun(runId);
  const run = await agentStore.getRun(runId);
  const goal = await agentStore.getGoal(run.goal_id);
  const plan = planId ? (await agentStore.getRunTrace(runId)).plan : undefined;
  const allToolCalls = (await agentStore.getRunTrace(runId)).toolCalls;
  const stepIds = new Set(steps.map(s => s.id));
  const toolCalls = allToolCalls.filter(tc => tc.step_id && stepIds.has(tc.step_id));
  
  return {
    run,
    goal,
    plan,
    steps,
    toolCalls,
    approvals: await agentStore.getApprovalsForRun(runId),
    auditEvents: await agentStore.getAuditEventsForRun(runId)
  };
}

export async function runLoop(runIn: AgentRun): Promise<void> {
  let run = runIn;
  const goal = await agentStore.getGoal(run.goal_id);

  try {
    if (run.iteration_count && run.iteration_count >= MAX_ITERATIONS) {
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
    } else {
      // Create new plan path
      run = await agentStore.incrementRunIteration(run.id);

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

    // Verify
    const trace = await buildScopedTrace(run.id, planId);
    const ruleVerify = verifyRun(trace);
    const semVerify = executionUnblocked ? await verifySemantically(trace, run.model) : null;

    if (!executionUnblocked || ruleVerify.status !== 'satisfied' || (semVerify && !semVerify.satisfied)) {
      // Replan
      const reason = !executionUnblocked ? 'Step failed' : 
                     (ruleVerify.status !== 'satisfied' ? ruleVerify.reasons.join(', ') : semVerify?.reasoning);
      
      run = await agentStore.updateRunStatus(run.id, 'running', { failure_reason: reason, plan_id: null }); // clear plan_id to start fresh next loop
      // We do not stop the worker processing yet, just tail recurse or loop!
      // But actually, just return and let the worker re-process it? No, if we want loop:
      slog('loop', 'replan_triggered', { run_id: run.id, reason });
      setImmediate(() => runLoop(run)); // recursive without blocking
      return;
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
    await finalizeRun(run, 'succeeded');

  } catch (err: any) {
    slog('loop', 'runLoop.error', { run_id: run.id, error: err.message });
    await finalizeRun(run, 'failed', err.message);
  }
}
