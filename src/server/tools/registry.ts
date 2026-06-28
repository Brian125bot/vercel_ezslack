import type { AgentTool } from '../agent/types.js';
import { slackReplyInThreadTool } from './slack.js';
import { memoryWriteTool, memorySearchTool } from './memory.js';
import { taskRecordTool } from './task.js';
import { GitHubIssueAdapter, EmailAdapter, WebSearchAdapter } from './adapters/index.js';
import type { ExternalAdapter } from './adapters/index.js';

class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private adapters: ExternalAdapter[] = [];

  register(tool: AgentTool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /** Register an external adapter if its env vars are configured */
  registerAdapter(adapter: ExternalAdapter) {
    this.adapters.push(adapter);
    if (adapter.isConfigured()) {
      for (const tool of adapter.getTools()) {
        this.register(tool);
      }
      console.log(`[Registry] Adapter registered: ${adapter.name}`);
    } else {
      console.log(`[Registry] Adapter skipped (not configured): ${adapter.name}`);
    }
  }

  getAdapters(): ExternalAdapter[] {
    return this.adapters;
  }
}

export const toolsRegistry = new ToolRegistry();

// Core tools (always available)
toolsRegistry.register(slackReplyInThreadTool);
toolsRegistry.register(memoryWriteTool);
toolsRegistry.register(memorySearchTool);
toolsRegistry.register(taskRecordTool);

// External adapters (registered only when env vars are present)
toolsRegistry.registerAdapter(new GitHubIssueAdapter());
toolsRegistry.registerAdapter(new EmailAdapter());
toolsRegistry.registerAdapter(new WebSearchAdapter());
