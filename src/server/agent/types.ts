export type AgentRiskLevel = 'read' | 'draft' | 'internal_write' | 'external_write' | 'destructive' | 'privileged';

// Keep in sync with AgentAttachment in attachments.ts
export interface AgentAttachment {
  filename: string;
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
  sourceUrl?: string;
}


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
  intentResult?: IntentResult;
  attachments?: AgentAttachment[];
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

export type StepKind = 'tool' | 'generate' | 'note';

export interface PlannedAgentStep {
  title: string;
  kind?: StepKind;
  toolName?: string;
  input?: any;
  injectInto?: string; // for "generate" steps: the field name on the NEXT tool step's input that should receive this step's generated output. Omit to use default behavior (slack.replyInThread's "text" field).
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
  preApproved?: boolean;
  planApprovalId?: string | null;
  allowedTools?: readonly string[] | null;
}

export interface PlanningContext {
  threadHistory: any[];
  memoryRecords: any[];
  priorSteps: any[];
  feedback?: string;
  goal: string;
  attachments?: AgentAttachment[];
}

export interface SemanticVerificationResult {
  satisfied: boolean;
  confidence: number;
  reasoning: string;
  source: 'llm' | 'skipped';
}

export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  riskLevel: AgentRiskLevel;
  requiresApproval: boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  /**
   * Optional JSON-Schema-style declaration of the tool's input parameters.
   * When present it is emitted to the model as a Gemini FunctionDeclaration
   * (native tool-calling) and used to validate `injectInto` fields. Omitted on
   * tools that pre-date this field for backward compatibility.
   */
  parameters?: ToolParameterSchema;
}

/**
 * Enhanced AgentTool interface for the ReAct loop with better type safety
 * and parameter validation support.
 */
export interface AgentToolEnhanced<TInput = any, TOutput = any> extends AgentTool<TInput, TOutput> {
  name: string;
  description: string;
  riskLevel: AgentRiskLevel;
  requiresApproval: boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  parameters: ToolParameterSchema;  // Required for ReAct loop tools
  validation?: (input: TInput) => ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * A minimal, JSON-Schema-flavoured parameter declaration. We intentionally keep
 * this as plain data (no @google/genai enum imports) so it stays portable and
 * easy to assert against in tests; {@link toFunctionDeclarations} adapts it to
 * the SDK's `FunctionDeclaration.parameters` shape.
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
  minimum?: number;
  maximum?: number;
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
