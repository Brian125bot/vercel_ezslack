import type { AgentRiskLevel, PolicyDecision } from './types.js';
import { query } from '../storage/db.js';

export function checkPolicy(riskLevel: AgentRiskLevel, requestedAction: string): PolicyDecision {
  switch (riskLevel) {
    case 'read':
    case 'draft':
      return { allowed: true, requiresApproval: false, reason: 'Safe read/draft operation' };
    
    case 'internal_write':
      return { allowed: true, requiresApproval: false, reason: 'Internal write permitted' };
      
    case 'external_write':
      return { allowed: true, requiresApproval: true, reason: 'External state modification requires explicit approval' };
      
    case 'destructive':
      return { allowed: false, requiresApproval: false, reason: 'Destructive actions are strictly blocked' };
      
    case 'privileged':
      return { allowed: false, requiresApproval: false, reason: 'Privileged operations are blocked' };
      
    default:
      return { allowed: false, requiresApproval: false, reason: 'Unknown risk level' };
  }
}

export const POLICY_PROFILES: Record<string, readonly string[]> = {
  coding: [
    'sandbox.exec',
    'sandbox.read',
    'sandbox.write',
    'sandbox.edit',
    'sandbox.ls',
    'sandbox.glob',
    'sandbox.grep',
    'sandbox.python',
    'sandbox.node',
    'memory.write',
    'memory.search',
    'task.record'
  ],
  research: [
    'search.query',
    'web.fetch',
    'sandbox.read',
    'sandbox.ls',
    'sandbox.glob',
    'sandbox.grep',
    'memory.write',
    'memory.search',
    'task.record'
  ],
  messaging: [
    'slack.replyInThread',
    'slack.react'
  ],
  minimal: [
    'slack.replyInThread'
  ]
} as const;

export type PolicyProfile = keyof typeof POLICY_PROFILES;

export function getPolicyProfile(profile: PolicyProfile): readonly string[] {
  return POLICY_PROFILES[profile];
}

export function getToolsForProfile(profile: PolicyProfile): readonly string[] {
  return POLICY_PROFILES[profile];
}

interface ToolPolicyRow {
  profile: string;
}

function resolvePolicyRow(row: ToolPolicyRow | null, workspaceId: string, channelId: string | null, level: 'channel' | 'workspace'): readonly string[] | null {
  if (!row) return null;
  if (row.profile === 'unrestricted') return null;
  if (Object.prototype.hasOwnProperty.call(POLICY_PROFILES, row.profile)) {
    return POLICY_PROFILES[row.profile];
  }

  console.error('[ToolPolicy] Unknown tool policy profile; denying all tools', {
    workspaceId,
    channelId,
    level,
    profile: row.profile
  });
  return [];
}

export async function resolveAllowedTools(
  workspaceId: string,
  channelId: string | null
): Promise<readonly string[] | null> {
  if (channelId) {
    const channelRows = await query<ToolPolicyRow>(
      `SELECT profile FROM tool_policies WHERE workspace_id = $1 AND channel_id = $2 LIMIT 1`,
      [workspaceId, channelId]
    );
    if (channelRows.length > 0) {
      return resolvePolicyRow(channelRows[0], workspaceId, channelId, 'channel');
    }
  }

  const workspaceRows = await query<ToolPolicyRow>(
    `SELECT profile FROM tool_policies WHERE workspace_id = $1 AND channel_id IS NULL LIMIT 1`,
    [workspaceId]
  );
  if (workspaceRows.length > 0) {
    return resolvePolicyRow(workspaceRows[0], workspaceId, channelId, 'workspace');
  }

  return null;
}
