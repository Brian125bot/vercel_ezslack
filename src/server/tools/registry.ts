import type { AgentTool } from '../agent/types.js';
import { slackReplyInThreadTool } from './slack.js';
import { memoryWriteTool, memorySearchTool } from './memory.js';
import { taskRecordTool } from './task.js';

class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }
}

export const toolsRegistry = new ToolRegistry();
toolsRegistry.register(slackReplyInThreadTool);
toolsRegistry.register(memoryWriteTool);
toolsRegistry.register(memorySearchTool);
toolsRegistry.register(taskRecordTool);

