import type { AgentRun, AgentStep, ToolCall } from '../storage/types.js';
import { agentStore } from '../storage/agentStore.js';
import { toolsRegistry } from '../tools/registry.js';
import { checkPolicy } from './policy.js';
import { slog } from './log.js';
import type { ToolExecutionContext } from './types.js';

const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');

/**
 * Executes a single tool call, applying policy checks, approvals, timeouts, and error handling.
 */
export async function executeToolCall(
  run: AgentRun,
  step: AgentStep,
  toolCall: ToolCall,
  context: ToolExecutionContext
): Promise<void> {
  const toolName = toolCall.tool_name;
  const toolInput = toolCall.input || {};

  await agentStore.updateToolCallStatus(toolCall.id, 'running');
  await agentStore.updateStepStatus(step.id, 'running');

  const tool = toolsRegistry.get(toolName);
  if (!tool) {
    const errorMsg = `Tool not found: ${toolName}`;
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: errorMsg });
    await agentStore.updateStepStatus(step.id, 'failed', { error: errorMsg });
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Step failed: Tool not found: ${toolName}`,
      payload: { error: errorMsg }
    });
    return;
  }

  let policy = checkPolicy(tool.riskLevel, tool.name);
  
  if (context.preApproved && tool.riskLevel === 'external_write') {
    policy = { allowed: true, requiresApproval: false, reason: 'Pre-approved from plan' };
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'policy.preapproved',
      actor: 'system',
      summary: `Pre-approved outer external_write policy for ${tool.name}`,
      payload: {}
    });
  }

  if (!policy.allowed) {
    if (policy.requiresApproval) {
      const { postApprovalBlockKit } = await import('../tools/slack.js');
      const approval = await agentStore.createApprovalRequest({
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        tool_call_id: toolCall.id,
        requested_from_user_id: context.userId,
        channel_id: context.channelId,
        message_ts: context.messageTs,
        title: `Approve execution of ${tool.name}`,
        description: policy.reason,
        risk_level: tool.riskLevel,
        proposed_action: { tool: tool.name, input: toolInput },
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000)
      });

      try {
        await postApprovalBlockKit(approval, context);

        await agentStore.appendAuditEvent({
          workspace_id: context.workspaceId,
          goal_id: run.goal_id,
          run_id: run.id,
          step_id: step.id,
          type: 'approval.requested',
          actor: 'system',
          summary: `Approval requested for tool ${tool.name} due to ${policy.reason}`,
          payload: { approvalId: approval.id }
        });

        await agentStore.updateToolCallStatus(toolCall.id, 'requires_approval', { approval_id: approval.id, error: policy.reason });
        await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
      } catch (err: any) {
        slog('executor', 'postApprovalBlockKit.error', { run_id: run.id, step_id: step.id, err: err.message });
        await agentStore.updateApprovalStatus(approval.id, 'failed');
        await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: `Failed to post approval to Slack: ${err.message}` });
        await agentStore.updateStepStatus(step.id, 'failed', { error: `Failed to post approval to Slack: ${err.message}` });
        throw err;
      }
    } else {
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'policy.blocked',
        actor: 'system',
        summary: `Policy blocked execution of ${tool.name}`,
        payload: { reason: policy.reason }
      });

      await agentStore.updateToolCallStatus(toolCall.id, 'blocked', { error: policy.reason });
      await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
    }
    return;
  }

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'policy.allowed',
    actor: 'system',
    summary: `Policy allowed execution of ${tool.name}`,
    payload: { reason: policy.reason }
  });

  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let output: any;
    try {
      output = await Promise.race([
        tool.execute(toolInput, context),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    
    await agentStore.updateToolCallStatus(toolCall.id, 'succeeded', { output });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'tool.succeeded',
      actor: 'system',
      summary: `Tool call ${tool.name} succeeded`,
      payload: { output }
    });

  } catch (err: any) {
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: err.message });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'tool.failed',
      actor: 'system',
      summary: `Tool call ${tool.name} failed: ${err.message}`,
      payload: { error: err.message }
    });
  }
}
