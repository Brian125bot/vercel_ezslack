import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

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
    
    if (activeRuns.length === 0) {
      await slackReplyInThreadTool.execute({ text: "There are no active tasks to cancel." }, context);
      return { status: 'success', intent };
    }

    // Cancel all active runs in this channel for now
    for (const run of activeRuns) {
      await agentStore.updateRunStatus(run.id, 'failed', { error: 'Cancelled by user via Slack command' });
      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        type: 'run.cancelled',
        actor: input.userId,
        summary: `Run cancelled by user`,
        payload: { user_message: input.messageText }
      });
    }

    await slackReplyInThreadTool.execute({ text: `I have cancelled ${activeRuns.length} active task(s).` }, context);
    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
