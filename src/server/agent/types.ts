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
  dbAvailable?: boolean;
  // Pre-classified intent (W1 gap fix): routes.ts classifies once and passes the result
  // through so the orchestrator never re-runs the (LLM) classifier.
  intentResult?: IntentResult;
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
  // Set when the user has already approved the active plan. Lets the executor proceed with
  // external_write tools (but never destructive/privileged) without re-requesting approval.
  preApproved?: boolean;
}

/**
 * Context assembled for the planner (W2-B). Gives the model thread history, relevant memory,
 * prior step outputs and replan feedback so it plans with information rather than blind.
 */
export interface PlanningContext {
  threadHistory: { role: string; text: string }[];
  memorySnippets: string[];
  priorStepOutputs: { title: string; output: string }[];
  replanFeedback?: string;
}

export interface SemanticVerificationResult {
  satisfied: boolean;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  source: 'llm' | 'skipped';
}

export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  riskLevel: AgentRiskLevel;
  requiresApproval: boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export type IntentCategory = 
  | 'direct_reply'
  | 'durable_task'
  | 'status_query'
  | 'approval_response'
  | 'cancel_or_update'
  | 'unsafe_or_unsupported';

export interface IntentContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  hasPendingApproval?: boolean;
}

export interface IntentResult {
  intent: IntentCategory;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristic' | 'llm' | 'fallback';
}

