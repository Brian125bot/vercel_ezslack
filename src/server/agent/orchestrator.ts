import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from './types.js';
import { classifyIntent } from './intent.js';
import { agentStore } from '../storage/agentStore.js';
import { createPlan } from './planner.js';
import { executeStep } from './executor.js';
import { verifyRun } from './verifier.js';
import { reportStatus } from './reporter.js';
import { generateSimpleResponse } from '../ai.js';
import { threadMemory } from '../state.js';
import { slackReplyInThreadTool } from '../tools/slack.js';

export async function runAgentPipeline(input: AgentPipelineInput): Promise<AgentPipelineResult> {
  const intent = await classifyIntent(input.messageText, input.selectedModel);
  
  const context: ToolExecutionContext = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    userId: input.userId,
    runId: '', // To be filled if durable
    stepId: '',
    messageTs: input.messageTs,
    threadTs: input.threadTs
  };

  const threadKeyStr = input.threadTs ? `chan-${input.channelId}-thread-${input.threadTs}` : `chan-${input.channelId}-single`;
  const history = threadMemory.get(threadKeyStr) || [];

  if (intent === 'direct_reply' || intent !== 'durable_task') {
    // Generate simple response right away
    try {
      const replyText = await generateSimpleResponse(input.messageText, input.selectedModel, history);
      
      const updatedHistory = [...history];
      updatedHistory.push({ role: 'user', text: input.messageText });
      updatedHistory.push({ role: 'model', text: replyText });
      if (updatedHistory.length > 20) {
        threadMemory.set(threadKeyStr, updatedHistory.slice(-20));
      } else {
        threadMemory.set(threadKeyStr, updatedHistory);
      }

      await slackReplyInThreadTool.execute({ text: replyText }, context);
      return { status: 'success', intent };
    } catch (err: any) {
      return { status: 'error', intent, message: err.message };
    }
  }

  // Handle durable task
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
      status: 'pending',
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
      status: 'starting'
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

    const planDraft = await createPlan(goal.title, goal.original_instruction, input.selectedModel);
    
    const plan = await agentStore.createPlan({
      goal_id: goal.id,
      version: 1,
      summary: planDraft.summary,
      assumptions: planDraft.assumptions,
      risks: [{ level: planDraft.riskLevel }],
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
      payload: {}
    });

    run = await agentStore.updateRunStatus(run.id, 'running', { plan_id: plan.id, started_at: new Date() });

    // Execute steps sequentially
    for (let i = 0; i < planDraft.steps.length; i++) {
      const stepDraft = planDraft.steps[i];
      const step = await agentStore.createStep({
        run_id: run.id,
        order_index: i,
        title: stepDraft.title,
        status: 'pending',
        input: { toolName: stepDraft.toolName, input: stepDraft.input }
      });
      context.stepId = step.id;

      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: goal.id,
        run_id: run.id,
        step_id: step.id,
        type: 'step.started',
        actor: 'system',
        summary: `Started step: ${step.title}`,
        payload: {}
      });

      await executeStep(run, step, context);

      const trace = await agentStore.getRunTrace(run.id);
      const updatedStep = trace.steps.find(s => s.id === step.id)!;

      if (updatedStep.status === 'failed' || updatedStep.status === 'blocked') {
        break; // Stop running further steps
      }
    }

    const trace = await agentStore.getRunTrace(run.id);
    const verification = verifyRun(trace);

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'verification.completed',
      actor: 'system',
      summary: `Verification ${verification.status}`,
      payload: verification
    });

    let runStatus: any = 'failed';
    if (verification.status === 'satisfied') runStatus = 'completed';
    else if (verification.status === 'blocked') runStatus = 'paused';

    run = await agentStore.updateRunStatus(run.id, runStatus, {
      result_summary: verification.reasons.join(' '),
      failure_reason: runStatus !== 'completed' ? verification.reasons.join(' ') : undefined
    });

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: `run.${runStatus}`,
      actor: 'system',
      summary: `Run ${runStatus}`,
      payload: {}
    });

    await agentStore.updateGoalStatus(goal.id, runStatus === 'completed' ? 'completed' : 'failed');

    // Skip reporting to slack every time to avoid noisiness, except on failure/block
    if (runStatus === 'paused' || runStatus === 'failed') {
      await reportStatus('failed', verification.reasons.join(' '), context);
    }

    return { status: 'success', intent, runId: run.id };

  } catch (err: any) {
    console.error('Agent pipeline failed:', err);
    if (run) {
      await agentStore.updateRunStatus(run.id, 'failed', { failure_reason: err.message });
      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: goal?.id,
        run_id: run.id,
        type: 'run.failed',
        actor: 'system',
        summary: 'Agent pipeline error',
        payload: { error: err.message }
      });
    }
    return { status: 'error', intent, message: err.message };
  }
}
