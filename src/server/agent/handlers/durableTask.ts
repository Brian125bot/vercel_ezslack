import { agentStore } from '../../storage/agentStore.js';
import { createPlan } from '../planner.js';
import { executeStep } from '../executor.js';
import { verifyRun } from '../verifier.js';
import { reportStatus } from '../reporter.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

export async function handleDurableTask(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'durable_task';
  
  if (!input.dbAvailable) {
    // W1-C: Epic DB-Unavailable Fallback 
    await slackReplyInThreadTool.execute({ text: "I cannot perform durable tasks right now because the database is unavailable." }, context);
    return { status: 'success', intent };
  }

  let goal, run;
  try {
    goal = await agentStore.createGoal({
      workspace_id: input.workspaceId,
      created_by_user_id: input.userId,
      source: input.sourceType,
      source_channel_id: input.channelId,
      source_thread_ts: input.threadTs,
      source_message_ts: input.messageTs,
      title: input.messageText.substring(0, 100),
      original_instruction: input.messageText,
      status: 'created',
      priority: 'normal'
    });

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      type: 'goal.created',
      actor: 'system',
      summary: 'Goal created from Slack message',
      payload: {}
    });

    // Create a planning run
    run = await agentStore.createRun({
      goal_id: goal.id,
      model: input.selectedModel,
      status: 'queued'
    });
    context.runId = run.id;

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.created',
      actor: 'system',
      summary: 'Run created',
      payload: {}
    });

    // Report task accepted to Slack immediately
    await reportStatus('task_accepted', `I have accepted your goal: "${goal.title}". Analyzing constraints and drafting a plan...`, context);

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'report.sent',
      actor: 'system',
      summary: 'Task accepted acknowledgment sent to Slack',
      payload: {}
    });

    // Update statuses to planning stage
    goal = await agentStore.updateGoalStatus(goal.id, 'planning');
    run = await agentStore.updateRunStatus(run.id, 'planning');

    const planDraft = await createPlan(goal.title, goal.original_instruction, input.selectedModel);
    
    const plan = await agentStore.createPlan({
      goal_id: goal.id,
      version: 1,
      summary: planDraft.summary,
      assumptions: planDraft.assumptions,
      risks: [{ level: planDraft.riskLevel, requiresApproval: planDraft.requiresApproval }],
      steps: planDraft.steps,
      status: 'active'
    });

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'plan.created',
      actor: 'system',
      summary: 'Plan generated',
      payload: { planDraft }
    });

    // If the plan draft itself requires approval before execution
    if (planDraft.requiresApproval) {
      const approval = await agentStore.createApprovalRequest({
        goal_id: goal.id,
        run_id: run.id,
        requested_from_user_id: input.userId,
        channel_id: input.channelId,
        message_ts: input.messageTs,
        title: 'Approve drafted plan',
        description: `The plan requires approval: ${planDraft.summary}`,
        risk_level: planDraft.riskLevel,
        proposed_action: { plan: planDraft },
        status: 'pending',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
      await reportStatus('plan_needs_approval', `The plan requires approval: ${planDraft.summary}. Please reply with 'Approve' to proceed.`, context);
      run = await agentStore.updateRunStatus(run.id, 'blocked');
      return { status: 'success', runId: run.id, intent };
    }

    // Step Execution (For Week 1, this runs synchronously)
    run = await agentStore.updateRunStatus(run.id, 'running');
    let allStepsDone = true;

    for (const stepDraft of planDraft.steps) {
      if (run.status !== 'running') break; // Early exit if stopped/cancelled
      
      const step = await agentStore.createStep({
        run_id: run.id,
        plan_id: plan.id,
        title: stepDraft.title,
        description: stepDraft.description,
        kind: stepDraft.kind || 'action', // Default missing kinds to action for unsupported/no-tool checks (W1-D)
        input: stepDraft as any,
        status: 'pending'
      });

      context.stepId = step.id;
      await executeStep(run, step, context);
      
      const updatedStep = await agentStore.getStep(step.id);
      if (updatedStep.status === 'failed' || updatedStep.status === 'blocked') {
        allStepsDone = false;
        if (updatedStep.status === 'blocked') {
          run = await agentStore.updateRunStatus(run.id, 'blocked');
        } else {
          run = await agentStore.updateRunStatus(run.id, 'failed', { error: `Step failed: ${updatedStep.title}` });
        }
        break; // Stop executing further steps
      }
    }

    if (allStepsDone && run.status === 'running') {
      // Trace build and verify
      const fullTrace = {
        run,
        goal,
        plan,
        steps: await agentStore.getStepsForRun(run.id),
        approvals: await agentStore.getApprovalsForRun(run.id),
        memoryWrites: [],
        auditEvents: await agentStore.getAuditEventsForRun(run.id)
      };

      const verification = verifyRun(fullTrace);
      
      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: goal.id,
        run_id: run.id,
        type: 'run.verified',
        actor: 'system',
        summary: `Run verification ${verification.status}`,
        payload: { verification }
      });

      if (verification.status === 'satisfied') {
        run = await agentStore.updateRunStatus(run.id, 'succeeded');
        goal = await agentStore.updateGoalStatus(goal.id, 'succeeded');
        await reportStatus('task_completed', `Goal successfully completed: ${goal.title}`, context);
      } else if (verification.status === 'blocked') {
         run = await agentStore.updateRunStatus(run.id, 'blocked');
      } else {
        run = await agentStore.updateRunStatus(run.id, 'failed', { error: verification.reasons.join(', ') });
        goal = await agentStore.updateGoalStatus(goal.id, 'failed');
        await reportStatus('task_failed', `Goal failed: ${verification.reasons.join(', ')}`, context);
      }
    }

    return { status: 'success', runId: run.id, intent };
  } catch (err: any) {
    if (run) {
      await agentStore.updateRunStatus(run.id, 'failed', { error: err.message });
    }
    if (goal) {
      await agentStore.updateGoalStatus(goal.id, 'failed');
    }
    return { status: 'error', intent, message: err.message, runId: run?.id };
  }
}
