import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';
import { detectDeferral } from '../deferral.js';
import { enqueueRunTask } from '../taskClient.js';

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
    // W4-F1: Check for time-deferred language before creating a run
    const deferral = detectDeferral(input.messageText);

    if (deferral.deferred && deferral.delayMs) {
      // Create the goal but NOT an immediate run — schedule it for later
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

      const nextRunAt = new Date(Date.now() + deferral.delayMs);

      const trigger = await agentStore.createScheduledTrigger({
        goal_id: goal.id,
        next_run_at: nextRunAt,
        timezone: 'UTC',
      });

      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: goal.id,
        type: 'trigger.created',
        actor: 'system',
        summary: `Scheduled trigger created: fires at ${nextRunAt.toISOString()} (${deferral.label})`,
        payload: { triggerId: trigger.id, delayMs: deferral.delayMs, label: deferral.label }
      });

      await slackReplyInThreadTool.execute({
        text: `Got it — I'll ${deferral.label || 'follow up'} at ${nextRunAt.toLocaleString()}. ⏰`
      }, context);

      return { status: 'success', intent };
    }

    // Immediate execution path (unchanged)
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

    // Create a queued run
    run = await agentStore.createRun({
      goal_id: goal.id,
      model: input.selectedModel,
      status: 'queued'
    });
    
    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.enqueued',
      actor: 'system',
      summary: 'Run enqueued for worker processing',
      payload: {}
    });

    // Fire the run to the workflow endpoint
    const enqueued = await enqueueRunTask(run.id);
    if (!enqueued) {
      throw new Error('Failed to enqueue run for processing');
    }

    await slackReplyInThreadTool.execute({
      text: `I have accepted your goal: "${goal.title}". Analyzing constraints and drafting a plan...`
    }, context);

    return { status: 'success', runId: run.id, intent };
  } catch (err: any) {
    if (run) await agentStore.updateRunStatus(run.id, 'failed', { failure_reason: err.message });
    if (goal) await agentStore.updateGoalStatus(goal.id, 'failed');
    return { status: 'error', intent, message: err.message, runId: run?.id };
  }
}
