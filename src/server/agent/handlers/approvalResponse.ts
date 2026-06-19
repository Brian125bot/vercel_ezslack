import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

import { finalizeRun } from '../finalize.js';
import { resumeAgentPipeline } from '../orchestrator.js';

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

    const targetApproval = pendingApprovals[0];

    if ((!isApproving && !isDenying) || (isApproving && isDenying)) {
      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: targetApproval.goal_id,
        run_id: targetApproval.run_id,
        step_id: targetApproval.step_id,
        type: 'approval.ambiguous',
        actor: input.userId,
        summary: 'User reply was ambiguous',
        payload: { user_message: input.messageText }
      });
      await slackReplyInThreadTool.execute({ text: "I couldn't clearly understand if you are approving or rejecting. Please reply explicitly with 'approve' or 'reject'." }, context);
      return { status: 'success', intent };
    }

    const newStatus: 'approved' | 'rejected' = isApproving ? 'approved' : 'rejected';
    
    await agentStore.resolveApproval(targetApproval.id, newStatus);
    
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

    if (newStatus === 'approved' && targetApproval.run_id) {
       await slackReplyInThreadTool.execute({ text: `Task has been approved and will resume.` }, context);
       await resumeAgentPipeline(targetApproval.run_id);
    } else if (newStatus === 'rejected' && targetApproval.run_id) {
       const run = await agentStore.getRun(targetApproval.run_id);
       await finalizeRun(run, 'cancelled', 'User rejected the approval request');
    }

    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}

