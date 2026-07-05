import type { AgentTool } from '../agent/types.js';
import { agentStore } from '../storage/agentStore.js';

export const taskRecordTool: AgentTool<{ title: string; notes?: string }> = {
  name: 'task.record',
  description: 'Record an internal task or action item.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  async execute(input, context) {
    // Record as memory for now or a sub-task if we implement it.
    await agentStore.writeMemory({
      workspace_id: context.workspaceId,
      user_id: context.userId,
      channel_id: context.channelId || '',
      kind: 'task',
      content: `Task: ${input.title}${input.notes ? ' - ' + input.notes : ''}`,
      source: 'agent',
      visibility: 'workspace',
      confidence: 1.0
    } as any);
    return { status: 'success', recorded: true };
  }
};
