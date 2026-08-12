import type { AgentRiskLevel, PolicyDecision } from './types.js';

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