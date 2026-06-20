import type { AgentTool, AgentRiskLevel, ToolExecutionContext } from '../../agent/types.js';

/**
 * Base interface for external service adapters.
 * Each adapter registers one or more AgentTools into the tool registry.
 * Adapters that perform external writes must declare riskLevel='external_write'
 * so that the policy gate requires user approval.
 */
export interface ExternalAdapter {
  /** Human-readable name, e.g. "GitHub Issues" */
  name: string;
  /** Short description shown in the dashboard */
  description: string;
  /** Whether this adapter's env vars are configured and it can be used */
  isConfigured(): boolean;
  /** Returns the AgentTool(s) this adapter contributes to the registry */
  getTools(): AgentTool[];
}
