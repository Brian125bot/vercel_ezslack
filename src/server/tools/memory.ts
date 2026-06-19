import type { AgentTool } from '../agent/types.js';
import { agentStore } from '../storage/agentStore.js';
import { containsSecret } from '../agent/sanitize.js';

export const memoryWriteTool: AgentTool<{ content: string; kind: string; visibility: string }> = {
  name: 'memory.write',
  description: 'Write a memory record.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  async execute(input, context) {
    const content = input.content || '';

    // W1-E: refuse to persist credentials/secrets to memory (centralized detector).
    if (containsSecret(content)) {
      return { status: 'failed', error: 'Refusing to write potentially sensitive information or secrets to memory.' };
    }

    const memory = await agentStore.writeMemory({
      workspace_id: context.workspaceId,
      user_id: context.userId,
      channel_id: context.channelId || '',
      kind: input.kind || 'fact',
      content: content,
      source: 'agent',
      visibility: input.visibility || 'workspace',
      confidence: 1.0
    } as any);
    return { status: 'success', memoryId: memory.id };
  }
};

export const memorySearchTool: AgentTool<{ query: string; kind?: string }> = {
  name: 'memory.search',
  description: 'Search memory records.',
  riskLevel: 'read',
  requiresApproval: false,
  async execute(input, context) {
    const records = await agentStore.searchMemory({
      workspace_id: context.workspaceId,
      user_id: context.userId,
      channel_id: context.channelId,
      kind: input.kind,
      limit: 10
    });
    return { status: 'success', records: records.map(r => r.content) };
  }
};
