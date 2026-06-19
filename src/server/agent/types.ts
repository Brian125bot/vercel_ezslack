export type AgentRiskLevel = 'read' | 'draft' | 'internal_write' | 'external_write' | 'destructive' | 'privileged';

export interface AgentPipelineInput {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  eventId: string;
  messageTs: string;
  threadTs?: string;
  selectedModel: string;
  signatureValid: boolean;
  sourceType: string;
}

export interface AgentPipelineResult {
  runId?: string;
  status: string;
  message?: string;
  intent?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export interface PlannedAgentStep {
  title: string;
  toolName?: string;
  input?: any;
}

export interface AgentPlanDraft {
  summary: string;
  assumptions: string[];
  steps: PlannedAgentStep[];
  riskLevel: AgentRiskLevel;
  requiresApproval: boolean;
}

export interface VerificationResult {
  status: 'satisfied' | 'partially_satisfied' | 'not_satisfied' | 'blocked';
  confidence: number;
  reasons: string[];
  recommendedNextAction: 'complete' | 'retry' | 'replan' | 'ask_user' | 'block';
}

export interface ToolExecutionContext {
  runId: string;
  stepId: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  messageTs: string;
  threadTs?: string;
}

export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  riskLevel: AgentRiskLevel;
  requiresApproval: boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}
