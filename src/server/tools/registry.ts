import type { AgentTool, ToolParameterSchema } from '../agent/types.js';
import { slackReplyInThreadTool } from './slack.js';
import { memoryWriteTool, memorySearchTool } from './memory.js';
import { taskRecordTool } from './task.js';
import { GitHubIssueAdapter, EmailAdapter, WebSearchAdapter, WebFetchAdapter, SandboxAdapter } from './adapters/index.js';
import type { ExternalAdapter } from './adapters/index.js';

/**
 * A Gemini SDK `FunctionDeclaration` (plain-data subset). We emit
 * `parametersJsonSchema` rather than the older `parameters`/`Type`-enum form so
 * the schema stays plain JSON-Schema data (no SDK enum coupling) and is
 * straightforward to assert against in tests.
 */
export interface ToolFunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema?: ToolParameterSchema;
}

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

  /**
   * Tool-policy scoping (opt-in). `allowedTools === null` means unrestricted —
   * identical to `getAll()` — which is the default when no policy row is
   * configured for a workspace/channel.
   */
  getAllowed(allowedTools: readonly string[] | null): AgentTool[] {
    if (allowedTools === null) return this.getAll();
    const allowedSet = new Set(allowedTools);
    return this.getAll().filter((tool) => allowedSet.has(tool.name));
  }

  /**
   * Look up a tool while honoring policy scoping. `tool` is `undefined` both
   * when the name is unregistered AND when it is registered but disallowed by
   * the current policy — callers must treat both cases identically for any
   * model-facing error text. `deniedByPolicy` is `true` only in the
   * registered-but-disallowed case, for the caller's own audit-logging use;
   * it must never be surfaced to the model.
   */
  getScoped(
    name: string,
    allowedTools: readonly string[] | null
  ): { tool: AgentTool | undefined; deniedByPolicy: boolean } {
    const tool = this.tools.get(name);
    if (!tool) return { tool: undefined, deniedByPolicy: false };
    if (allowedTools !== null && !allowedTools.includes(name)) {
      return { tool: undefined, deniedByPolicy: true };
    }
    return { tool, deniedByPolicy: false };
  }

  /**
   * Emit every registered (and policy-allowed) tool as a Gemini
   * FunctionDeclaration. Because adapters only register their tools when
   * env-configured, the model is never advertised a tool that cannot actually
   * run — this is the fix for "plan silently does nothing" when an adapter
   * key is missing. `allowedTools` defaults to `null` (unrestricted), which
   * preserves prior behavior for callers that don't scope by policy.
   */
  toFunctionDeclarations(allowedTools: readonly string[] | null = null): ToolFunctionDeclaration[] {
    return this.getAllowed(allowedTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.parameters ? { parametersJsonSchema: tool.parameters } : {})
    }));
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
toolsRegistry.registerAdapter(new WebFetchAdapter());
toolsRegistry.registerAdapter(new SandboxAdapter());
