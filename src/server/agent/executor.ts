import type { AgentRun, AgentStep } from '../storage/types.js';
import { agentStore } from '../storage/agentStore.js';
import { toolsRegistry } from '../tools/registry.js';
import { checkPolicy } from './policy.js';
import type { ToolExecutionContext } from './types.js';

export async function executeStep(
  run: AgentRun, 
  step: AgentStep, 
  context: ToolExecutionContext
): Promise<void> {
  await agentStore.updateStepStatus(step.id, 'running');

  if (!step.input || !(step.input as any).toolName) {
    const stepKind = (step.input as any)?.kind;
    if (stepKind === 'note') {
      await agentStore.updateStepStatus(step.id, 'succeeded', { output: { message: 'Step completed (conceptual note)' } });
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'step.succeeded',
        actor: 'system',
        summary: `Step succeeded: ${step.title} (conceptual)`,
        payload: {}
      });
      return;
    } else {
      await agentStore.updateStepStatus(step.id, 'failed', { error: 'No tool specified and not a note step' });
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'step.failed',
        actor: 'system',
        summary: `Step failed: No tool specified for action step`,
        payload: { error: 'Unsupported / no-tool step cannot succeed' }
      });
      return;
    }
  }

  const toolName = (step.input as any).toolName;
  const toolInput = (step.input as any).input || {};

  const tool = toolsRegistry.get(toolName);
  if (!tool) {
    await agentStore.updateStepStatus(step.id, 'failed', { error: `Tool not found: ${toolName}` });
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Step failed: Tool not found: ${toolName}`,
      payload: { error: `Tool not found: ${toolName}` }
    });
    return;
  }

  const toolCall = await agentStore.createToolCall({
    run_id: run.id,
    step_id: step.id,
    tool_name: tool.name,
    input: toolInput,
    status: 'created',
    risk_level: tool.riskLevel
  });

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'tool.created',
    actor: 'system',
    summary: `Created tool call for ${tool.name}`,
    payload: { toolInput }
  });
  
  await agentStore.updateStepStatus(step.id, 'running', { tool_call_id: toolCall.id });
  await agentStore.updateToolCallStatus(toolCall.id, 'running');

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'tool.started',
    actor: 'system',
    summary: `Started tool execution: ${tool.name}`,
    payload: {}
  });

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
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });

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
    const output = await tool.execute(toolInput, context);
    await agentStore.updateToolCallStatus(toolCall.id, 'succeeded', { output });
    await agentStore.updateStepStatus(step.id, 'succeeded', { output });

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

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.succeeded',
      actor: 'system',
      summary: `Step succeeded: ${step.title}`,
      payload: {}
    });
  } catch (err: any) {
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: err.message });
    await agentStore.updateStepStatus(step.id, 'failed', { error: err.message });

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

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Step failed: ${step.title}`,
      payload: { error: err.message }
    });
  }
}
