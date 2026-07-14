import type { AgentTool } from '../agent/types.js';
import { agentStore } from '../storage/agentStore.js';
import { containsSecret } from '../agent/sanitize.js';

export const memoryWriteTool: AgentTool<{ content: string; kind: string; visibility: string }> = {
  name: 'memory.write',
  description: 'Write a memory record.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact or note to remember.' },
      kind: { type: 'string', description: 'Memory kind.', enum: ['fact', 'task', 'preference', 'note'] },
      visibility: { type: 'string', description: 'Who can see this memory.', enum: ['private', 'workspace', 'public'] }
    },
    required: ['content']
  },
  async execute(input, context) {
    const content = input.content || '';

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
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to match against stored memory records.' },
      kind: { type: 'string', description: 'Optional kind filter.', enum: ['fact', 'task', 'preference', 'note'] }
    },
    required: ['query']
  },
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
