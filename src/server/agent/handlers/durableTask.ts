import { agentStore } from '../../storage/agentStore.js';
import { reportStatus } from '../reporter.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import { slog } from '../log.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

/**
 * Durable task handler (Week 2: enqueue-only).
 *
 * Creates the goal + a `queued` run and ACKs the user immediately (W2-F1). The background
 * worker (worker.ts) then claims the run and drives the closed loop. This handler intentionally
 * contains NO planning/execution/verification lifecycle — that lives in loop.ts (W2-E5/W2-E6).
 */
export async function handleDurableTask(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'durable_task';

  if (!input.dbAvailable) {
    // W1-C: durable tasks need persistence; refuse clearly when the DB is down.
    await slackReplyInThreadTool.execute(
      { text: 'I cannot start a durable task right now because the database is unavailable. Simple questions still work though.' },
      context
    );
    return { status: 'success', intent };
  }

  try {
    const goal = await agentStore.createGoal({
      workspace_id: input.workspaceId,
      created_by_user_id: input.userId,
      source: input.sourceType,
      source_channel_id: input.channelId,
      source_thread_ts: input.threadTs,
      source_message_ts: input.messageTs,
      title: input.messageText.substring(0, 100),
      original_instruction: input.messageText,
      status: 'created',
      priority: 'normal',
    });

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      type: 'goal.created',
      actor: 'system',
      summary: 'Goal created from Slack message',
      payload: {},
    });

    // Enqueue a run for the worker to pick up.
    const run = await agentStore.createRun({
      goal_id: goal.id,
      model: input.selectedModel,
      status: 'queued',
    });
    context.runId = run.id;

    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: goal.id,
      run_id: run.id,
      type: 'run.enqueued',
      actor: 'system',
      summary: 'Run enqueued for background worker',
      payload: {},
    });

    // ACK before the plan completes (W2-F1).
    await reportStatus('task_accepted', `Got it — "${goal.title}". Queued it and I'm working on it in the background.`, context);

    slog('durableTask', 'enqueued', { runId: run.id, goalId: goal.id });
    return { status: 'success', runId: run.id, intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
