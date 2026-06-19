import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from './types.js';
import { classifyIntent } from './intent.js';
import { agentStore } from '../storage/agentStore.js';
import { slog } from './log.js';
import {
  handleDirectReply,
  handleStatusQuery,
  handleApprovalResponse,
  handleCancelOrUpdate,
  handleUnsafeOrUnsupported,
  handleDurableTask
} from './handlers/index.js';

export async function runAgentPipeline(input: AgentPipelineInput): Promise<AgentPipelineResult> {
  // Classify intent exactly once. routes.ts already classifies (and computes pending-approval
  // context) before hitting the pipeline, so it passes the result through here. We only
  // re-classify as a defensive fallback when no pre-classified result was supplied.
  let intentResult = input.intentResult;
  if (!intentResult) {
    const hasPendingApproval = input.dbAvailable
      ? await agentStore.hasPendingApproval(input.workspaceId, input.channelId)
      : false;
    intentResult = await classifyIntent(input.messageText, input.selectedModel, {
      context: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        userId: input.userId,
        threadTs: input.threadTs,
        hasPendingApproval
      }
    });
  }
  const intent = intentResult.intent;
  
  const context: ToolExecutionContext = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    userId: input.userId,
    runId: '', // To be filled if durable
    stepId: '',
    messageTs: input.messageTs,
    threadTs: input.threadTs
  };

  switch (intent) {
    case 'direct_reply':
      return handleDirectReply(input, context);
    case 'status_query':
      return handleStatusQuery(input, context);
    case 'approval_response':
      return handleApprovalResponse(input, context);
    case 'cancel_or_update':
      return handleCancelOrUpdate(input, context);
    case 'unsafe_or_unsupported':
      return handleUnsafeOrUnsupported(input, context);
    case 'durable_task':
      return handleDurableTask(input, context);
    default:
      // Fallback
      return handleDirectReply(input, context);
  }
}

/**
 * Resume a run after an approval was granted (W2-F9). Resume always goes through the worker:
 * we simply re-queue the run so the next worker tick re-claims it and the closed loop executes
 * the now-approved plan. Safe to call for runs in awaiting_approval / blocked state.
 */
export async function resumeAgentPipeline(runId: string): Promise<void> {
  const run = await agentStore.getRun(runId);
  const goal = await agentStore.getGoal(run.goal_id);
  await agentStore.updateRunStatus(runId, 'queued');
  await agentStore.appendAuditEvent({
    workspace_id: goal.workspace_id,
    goal_id: run.goal_id,
    run_id: runId,
    type: 'run.requeued',
    actor: 'system',
    summary: 'Run re-queued for worker after approval',
    payload: {}
  });
  slog('orchestrator', 'resume.requeued', { runId });
}
