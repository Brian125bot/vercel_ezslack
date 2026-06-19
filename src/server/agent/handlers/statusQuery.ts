import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

export async function handleStatusQuery(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'status_query';
  
  if (!input.dbAvailable) {
    await slackReplyInThreadTool.execute({ text: "Database is unavailable. Cannot check task status." }, context);
    return { status: 'success', intent };
  }
  
  try {
    const activeRuns = await agentStore.getActiveRunsByChannel(input.workspaceId, input.channelId);
    
    let replyText = '';
    if (activeRuns.length === 0) {
      replyText = "There are currently no active tasks or runs in progress.";
    } else {
      const items = activeRuns.map(r => `- Run ${r.id.substring(0, 8)}... : ${r.status} (Goal ${r.goal_id.substring(0, 8)}...)`).join('\n');
      replyText = `Here is the status of active runs:\n${items}`;
    }

    // W1-E5: audit events for status queries (alongside cancel + approval-from-Slack).
    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      type: 'status.queried',
      actor: input.userId,
      summary: `Status query returned ${activeRuns.length} active run(s)`,
      payload: { channelId: input.channelId, activeRunCount: activeRuns.length, query: input.messageText }
    });

    await slackReplyInThreadTool.execute({ text: replyText }, context);
    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
