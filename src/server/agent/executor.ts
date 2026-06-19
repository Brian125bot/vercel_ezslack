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
    // If no tool is specified, we just mark it succeeded (e.g. conceptual step)
    await agentStore.updateStepStatus(step.id, 'succeeded', { output: { message: 'Step completed (no tool)' } });
    return;
  }

  const toolName = (step.input as any).toolName;
  const toolInput = (step.input as any).input || {};

  const tool = toolsRegistry.get(toolName);
  if (!tool) {
    await agentStore.updateStepStatus(step.id, 'failed', { error: `Tool not found: ${toolName}` });
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
  
  await agentStore.updateStepStatus(step.id, 'running', { tool_call_id: toolCall.id });
  await agentStore.updateToolCallStatus(toolCall.id, 'running');

  const policy = checkPolicy(tool.riskLevel, tool.name);
  if (!policy.allowed) {
    if (policy.requiresApproval) {
      await agentStore.updateToolCallStatus(toolCall.id, 'requires_approval', { error: policy.reason });
      await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
    } else {
      await agentStore.updateToolCallStatus(toolCall.id, 'blocked', { error: policy.reason });
      await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
    }
    return;
  }

  try {
    const output = await tool.execute(toolInput, context);
    await agentStore.updateToolCallStatus(toolCall.id, 'succeeded', { output });
    await agentStore.updateStepStatus(step.id, 'succeeded', { output });
  } catch (err: any) {
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: err.message });
    await agentStore.updateStepStatus(step.id, 'failed', { error: err.message });
  }
}
