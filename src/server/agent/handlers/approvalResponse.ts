import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

export async function handleApprovalResponse(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'approval_response';
  
  if (!input.dbAvailable) {
    await slackReplyInThreadTool.execute({ text: "Database is unavailable. Cannot process approvals." }, context);
    return { status: 'success', intent };
  }

  try {
    const pendingApprovals = await agentStore.getPendingApprovals(input.workspaceId, input.channelId);
    if (pendingApprovals.length === 0) {
      await slackReplyInThreadTool.execute({ text: "There are no pending approvals to resolve at the moment." }, context);
      return { status: 'success', intent };
    }

    const text = input.messageText.toLowerCase();
    const isApproving = text.includes('approve') || text.includes('yes') || text.includes('proceed');
    const isDenying = text.includes('reject') || text.includes('no') || text.includes('deny');

    let newStatus: 'approved' | 'rejected' = isApproving ? 'approved' : 'rejected';
    
    // Default to approved if ambiguous? W1-A intent heuristics only let it here if approval words are present.
    // If we have a pending approval, resolve the oldest one
    const targetApproval = pendingApprovals[0]; // Resolves the first pending wait.
    await agentStore.resolveApproval(targetApproval.id, newStatus);
    
    // Also append an audit event so it is visible in UI
    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: targetApproval.goal_id,
      run_id: targetApproval.run_id,
      step_id: targetApproval.step_id,
      type: `approval.${newStatus}`,
      actor: input.userId,
      summary: `User ${newStatus} execution of ${targetApproval.proposed_action?.tool || 'tool'}`,
      payload: { user_message: input.messageText }
    });

    const actionText = newStatus === 'approved' ? 'approved and will resume' : 'rejected and will halt processing';
    await slackReplyInThreadTool.execute({ text: `Task has been ${actionText}.` }, context);
    
    // We update the run status to queued to resume processing if approved (W2 will use workers, W1 might just leave it)
    if (newStatus === 'approved' && targetApproval.run_id) {
      // In Week 1, we might need a way to unblock the run. For now, mark it queued.
      await agentStore.updateRunStatus(targetApproval.run_id, 'queued');
    }

    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
