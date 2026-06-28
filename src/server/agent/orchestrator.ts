import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from './types.js';
import { classifyIntent } from './intent.js';
import { agentStore } from '../storage/agentStore.js';
import {
  handleDirectReply,
  handleStatusQuery,
  handleApprovalResponse,
  handleCancelOrUpdate,
  handleUnsafeOrUnsupported,
  handleDurableTask
} from './handlers/index.js';

export async function resumeAgentPipeline(runId: string): Promise<void> {
  const run = await agentStore.getRun(runId);
  await agentStore.updateRunStatus(run.id, 'queued', {
    claimed_by: null,
    claimed_at: null,
    lease_expires_at: null
  });

  // Reset any blocked steps to pending so they are re-executed on approval.
  // The approved approval request (status='approved') will be found by
  // getApprovedStepApproval() in runLoop(), setting preApproved=true.
  if (run.plan_id) {
    const steps = await agentStore.getStepsForPlan(run.plan_id);
    for (const step of steps) {
      if (step.status === 'blocked') {
        await agentStore.updateStepStatus(step.id, 'pending');
      }
    }
  }

  await agentStore.appendAuditEvent({
    workspace_id: null,
    goal_id: run.goal_id,
    run_id: run.id,
    type: 'run.requeued',
    actor: 'system',
    summary: 'Run re-queued to resume processing',
    payload: {}
  });

  const { enqueueRunTask } = await import('./taskClient.js');
  await enqueueRunTask(run.id);
}

export async function runAgentPipeline(input: AgentPipelineInput): Promise<AgentPipelineResult> {
  let intentResult = input.intentResult;
  if (!intentResult) {
    const hasPendingApproval = input.dbAvailable ? await agentStore.hasPendingApproval(input.workspaceId, input.channelId) : false;
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
