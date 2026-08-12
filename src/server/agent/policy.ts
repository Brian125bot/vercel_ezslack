import type { AgentRiskLevel, PolicyDecision } from './types.js';
import { agentStore } from '../storage/agentStore.js';

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
    'sandbox.node'
  ],
  research: [
    'search.query',
    'web.fetch',
    'sandbox.read',
    'sandbox.ls',
    'sandbox.glob',
    'sandbox.grep'
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

export async function resolveAllowedTools(
  workspaceId: string,
  channelId: string | null
): Promise<readonly string[] | null> {
  let policyRow = null;

  // 1. Look up a channel-level row if channelId is non-null.
  if (channelId) {
    policyRow = await agentStore.getChannelPolicy(workspaceId, channelId);
  }

  // 2. If no channel-level row exists, look up the workspace-level row.
  if (!policyRow) {
    policyRow = await agentStore.getWorkspacePolicy(workspaceId);
  }

  // 3. No row found at all -> null (unrestricted).
  if (!policyRow) {
    return null;
  }

  const profile = policyRow.profile;

  // 4. Row found with profile === 'unrestricted' -> null (unrestricted).
  if (profile === 'unrestricted') {
    return null;
  }

  // 5. Row found with a recognized profile key -> return tools list.
  if (profile in POLICY_PROFILES) {
    return getPolicyProfile(profile as PolicyProfile);
  }

  // 6. Any row found with an unrecognized profile value -> return [] (deny all) and log an error.
  console.error(`[Policy Error] Unrecognized policy profile '${profile}' found in row ${policyRow.id} for workspace ${workspaceId}, scope: ${channelId ? `channel ${channelId}` : 'workspace'}. Failing closed.`);
  return [];
}
