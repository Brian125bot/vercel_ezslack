import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';
import { finalizeRun } from '../finalize.js';

/**
 * W4-C: Determine whether the user wants to cancel or update/modify
 * an active run. "cancel/stop/abort" → cancel, everything else → update.
 */
function classifyCancelVsUpdate(text: string): 'cancel' | 'update' {
  const cancelPatterns = /\b(cancel|stop|abort|kill|end|halt|nevermind|never\s*mind)\b/i;
  if (cancelPatterns.test(text)) return 'cancel';
  return 'update';
}

export async function handleCancelOrUpdate(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'cancel_or_update';
  
  if (!input.dbAvailable) {
    await slackReplyInThreadTool.execute({ text: "Database is unavailable. Cannot cancel or update tasks." }, context);
    return { status: 'success', intent };
  }

  try {
    const activeRuns = await agentStore.getActiveRunsByChannel(input.workspaceId, input.channelId);
    const subIntent = classifyCancelVsUpdate(input.messageText);

    if (subIntent === 'cancel') {
      if (activeRuns.length === 0) {
        await slackReplyInThreadTool.execute({ text: "There are no active tasks to cancel." }, context);
        return { status: 'success', intent };
      }

      for (const run of activeRuns) {
        await finalizeRun(run, 'cancelled', 'Cancelled by user via Slack command');
      }

      await slackReplyInThreadTool.execute({ text: `I have cancelled ${activeRuns.length} active task(s).` }, context);
      return { status: 'success', intent };
    }

    // W4-C: Update/mutation path - conversational turn insertion
    if (activeRuns.length === 0) {
      await slackReplyInThreadTool.execute({ text: "There are no active tasks to update." }, context);
      return { status: 'success', intent };
    }

    const run = activeRuns[0];
    const steps = await agentStore.getStepsForRun(run.id);

    // Create a new step representing user feedback
    await agentStore.createStep({
      run_id: run.id,
      order_index: steps.length + 1,
      title: 'User Feedback',
      status: 'succeeded',
      input: {
        text: `User feedback: ${input.messageText}`,
        role: 'user'
      }
    });

    // Reset status to queued and clear claim to force rerun of execution loop
    await agentStore.updateRunStatus(run.id, 'queued', {
      claimed_by: null, claimed_at: null, lease_expires_at: null
    });

    const { enqueueRunTask } = await import('../taskClient.js');
    await enqueueRunTask(run.id);

    await slackReplyInThreadTool.execute({
      text: `✅ Feedback received. I will adjust my actions based on your input.`
    }, context);

    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
