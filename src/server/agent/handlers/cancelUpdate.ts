import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';
import { finalizeRun } from '../finalize.js';
import { mutatePlan } from '../planMutation.js';

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
      // Original cancel path
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

    // W4-C: Update/mutation path
    if (activeRuns.length === 0) {
      await slackReplyInThreadTool.execute({ text: "There are no active tasks to update." }, context);
      return { status: 'success', intent };
    }

    // Pick the most recent active run
    const run = activeRuns[0];
    const planId = run.plan_id;

    if (!planId) {
      await slackReplyInThreadTool.execute({
        text: "The active task doesn't have a plan yet — it's still in the planning phase. I'll incorporate your feedback when the plan is created."
      }, context);
      return { status: 'success', intent };
    }

    const result = await mutatePlan(run.id, planId, input.messageText, run.model);

    await slackReplyInThreadTool.execute({
      text: result.success
        ? `✅ Plan updated: ${result.summary}`
        : `⚠️ Could not update the plan: ${result.summary}`
    }, context);

    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
