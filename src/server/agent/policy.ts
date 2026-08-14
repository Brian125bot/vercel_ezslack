import type { AgentRiskLevel, PolicyDecision } from './types.js';
import { agentStore } from '../storage/agentStore.js';
import { slog } from './log.js';

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

function isKnownProfileValue(profile: string): boolean {
  return profile === 'unrestricted' || Object.prototype.hasOwnProperty.call(POLICY_PROFILES, profile);
}

/**
 * Resolve the set of tool names allowed for a given workspace/channel scope.
 *
 * Precedence (see PR description for the full rationale):
 * 1. A channel-level row (workspace_id + channel_id), if `channelId` is
 *    non-null, is the answer, full stop — regardless of its value.
 * 2. Otherwise, a workspace-level row (workspace_id, channel_id IS NULL).
 * 3. No row found at either level -> `null` (unrestricted — identical to the
 *    pre-existing, unscoped behavior; this feature is strictly additive).
 * 4. A row found at whichever level, with a `profile` value that is neither
 *    `'unrestricted'` nor a known `POLICY_PROFILES` key -> `[]` (deny all),
 *    logged as an error. There is no fallback to a less-specific level or to
 *    the unrestricted default in this case.
 */
export async function resolveAllowedTools(
  workspaceId: string,
  channelId: string | null
): Promise<readonly string[] | null> {
  let row: { profile: string; channel_id?: string | null } | null = null;

  if (channelId) {
    row = await agentStore.getChannelToolPolicy(workspaceId, channelId);
  }

  if (!row) {
    row = await agentStore.getWorkspaceToolPolicy(workspaceId);
  }

  if (!row) {
    return null;
  }

  if (row.profile === 'unrestricted') {
    return null;
  }

  if (!isKnownProfileValue(row.profile)) {
    slog('policy', 'resolveAllowedTools.corrupt_profile', {
      workspace_id: workspaceId,
      channel_id: row.channel_id ?? null,
      profile: row.profile
    });
    return [];
  }

  return getPolicyProfile(row.profile as PolicyProfile);
}
