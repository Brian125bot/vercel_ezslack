import { Type } from '@google/genai';
import type { AgentTool } from '../agent/types.js';
import { agentStore } from '../storage/agentStore.js';
import { containsSecret } from '../agent/sanitize.js';

export const memoryWriteTool: AgentTool<{ content: string; kind: string; visibility: string }> = {
  name: 'memory.write',
  description: 'Write a memory record to persist facts, tasks, or configuration details.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  parameters: {
    type: Type.OBJECT,
    properties: {
      content: {
        type: Type.STRING,
        description: 'The content/fact to write to memory.'
      },
      kind: {
        type: Type.STRING,
        description: 'The type of memory. e.g., "fact", "task", "config".'
      },
      visibility: {
        type: Type.STRING,
        description: 'Visibility scope. e.g., "workspace" (visible to all in workspace), "user" (visible only to this user).'
      }
    },
    required: ['content', 'kind', 'visibility']
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
  description: 'Search memory records for facts, tasks, or configurations.',
  riskLevel: 'read',
  requiresApproval: false,
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Search query string.'
      },
      kind: {
        type: Type.STRING,
        description: 'Optional kind filter, e.g., "fact", "task", "config".'
      }
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
