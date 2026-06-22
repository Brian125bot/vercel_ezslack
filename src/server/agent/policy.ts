import type { AgentRiskLevel, PolicyDecision } from './types.js';

export function checkPolicy(riskLevel: AgentRiskLevel, requestedAction: string): PolicyDecision {
  switch (riskLevel) {
    case 'read':
    case 'draft':
      return { allowed: true, requiresApproval: false, reason: 'Safe read/draft operation' };
    
    case 'internal_write':
      return { allowed: true, requiresApproval: false, reason: 'Internal write permitted' };
      
    case 'external_write':
      // Allow execution but require explicit approval before proceeding
      return { allowed: true, requiresApproval: true, reason: 'External state modification requires explicit approval' };
      
    case 'destructive':
      return { allowed: false, requiresApproval: false, reason: 'Destructive actions are strictly blocked' };
      
    case 'privileged':
      return { allowed: false, requiresApproval: false, reason: 'Privileged operations are blocked' };
      
    default:
      return { allowed: false, requiresApproval: false, reason: 'Unknown risk level' };
  }
}
