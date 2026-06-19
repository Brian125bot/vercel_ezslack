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
    const isApproving = /\b(approve|approved|yes|yep|proceed|go ahead|confirm|ok|okay)\b/.test(text);
    const isDenying = /\b(reject|rejected|no|nope|deny|denied|cancel|stop|halt)\b/.test(text);

    // W1 gap fix (approval polarity): if the intent is ambiguous — or the user said BOTH
    // approve and reject words — we must NOT silently default to rejected (or approved).
    // Re-prompt for an explicit decision instead. Approval is a destructive, irreversible
    // commit point, so guessing here is unsafe.
    if (isApproving === isDenying) {
      const targetApproval = pendingApprovals[0];
      await agentStore.appendAuditEvent({
        workspace_id: input.workspaceId,
        goal_id: targetApproval.goal_id,
        run_id: targetApproval.run_id,
        step_id: targetApproval.step_id,
        type: 'approval.ambiguous',
        actor: input.userId,
        summary: 'Ambiguous approval response — re-prompted user for explicit decision',
        payload: { user_message: input.messageText }
      });
      await slackReplyInThreadTool.execute({
        text: `I have a pending approval ("${targetApproval.title}") but couldn't tell whether you want to *approve* or *reject* it. Please reply with exactly "approve" or "reject".`
      }, context);
      return { status: 'success', intent };
    }

    const newStatus: 'approved' | 'rejected' = isApproving ? 'approved' : 'rejected';

    // Resolve the oldest pending approval.
    const targetApproval = pendingApprovals[0];
    await agentStore.resolveApproval(targetApproval.id, newStatus);
    
    // Audit event so it is visible in the dashboard.
    await agentStore.appendAuditEvent({
      workspace_id: input.workspaceId,
      goal_id: targetApproval.goal_id,
      run_id: targetApproval.run_id,
      step_id: targetApproval.step_id,
      type: `approval.${newStatus}`,
      actor: input.userId,
      summary: `User ${newStatus} execution of ${targetApproval.proposed_action?.tool || 'plan'}`,
      payload: { user_message: input.messageText }
    });

    const actionText = newStatus === 'approved' ? 'approved and will resume' : 'rejected and will halt processing';
    await slackReplyInThreadTool.execute({ text: `Task has been ${actionText}.` }, context);

    if (targetApproval.run_id) {
      if (newStatus === 'approved') {
        // Resume goes through the worker (W2-F9): re-queue so the worker re-claims and the
        // closed loop executes the now-approved plan.
        await agentStore.updateRunStatus(targetApproval.run_id, 'queued');
      } else {
        // Reject -> terminal via the single finalize path.
        const { finalizeRun } = await import('../finalize.js');
        await finalizeRun({
          runId: targetApproval.run_id,
          goalId: targetApproval.goal_id!,
          workspaceId: input.workspaceId,
          state: 'cancelled',
          failureReason: 'User rejected the plan.',
          context
        });
      }
    }

    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
