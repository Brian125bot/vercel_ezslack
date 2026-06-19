export type GoalStatus = 'created' | 'planning' | 'running' | 'awaiting_approval' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'planning' | 'running' | 'awaiting_approval' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked';
export type ToolCallStatus = 'created' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'requires_approval';
export type RiskLevel = 'low' | 'medium' | 'high';
export type MemoryVisibility = 'private' | 'workspace' | 'public';

export interface AgentGoal {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  source: string;
  source_channel_id?: string | null;
  source_thread_ts?: string | null;
  source_message_ts?: string | null;
  title: string;
  original_instruction: string;
  normalized_objective?: string | null;
  status: GoalStatus;
  priority: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date | null;
}

export interface AgentPlan {
  id: string;
  goal_id: string;
  version: number;
  summary: string;
  assumptions: any;
  risks: any;
  steps: any;
  status: string;
  created_at: Date;
}

export interface AgentRun {
  id: string;
  goal_id: string;
  plan_id?: string | null;
  status: RunStatus;
  model: string;
  current_step_id?: string | null;
  result_summary?: string | null;
  failure_reason?: string | null;
  iteration_count?: number;
  claimed_by?: string | null;
  claimed_at?: Date | null;
  lease_expires_at?: Date | null;
  started_at?: Date | null;
  finished_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentStep {
  id: string;
  run_id: string;
  plan_id?: string | null;
  plan_step_id?: string | null;
  order_index: number;
  title: string;
  status: StepStatus;
  tool_call_id?: string | null;
  input: any;
  output?: any;
  error?: string | null;
  started_at?: Date | null;
  finished_at?: Date | null;
  created_at: Date;
}

export interface ToolCall {
  id: string;
  run_id: string;
  step_id?: string | null;
  tool_name: string;
  input: any;
  output?: any;
  status: ToolCallStatus;
  risk_level: string;
  approval_id?: string | null;
  error?: string | null;
  started_at?: Date | null;
  finished_at?: Date | null;
  created_at: Date;
}

export interface ApprovalRequest {
  id: string;
  goal_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  tool_call_id?: string | null;
  requested_from_user_id: string;
  channel_id?: string | null;
  message_ts?: string | null;
  title: string;
  description: string;
  risk_level: string;
  proposed_action: any;
  status: string;
  expires_at: Date;
  created_at: Date;
  resolved_at?: Date | null;
}

export interface MemoryRecord {
  id: string;
  workspace_id: string;
  user_id?: string | null;
  channel_id?: string | null;
  kind: string;
  content: string;
  source: string;
  source_ref?: any;
  confidence: number;
  visibility: string;
  created_at: Date;
  updated_at: Date;
  expires_at?: Date | null;
}

export interface AuditEvent {
  id: string;
  workspace_id?: string | null;
  goal_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  type: string;
  actor: string;
  summary: string;
  payload: any;
  created_at: Date;
}

export interface ScheduledTrigger {
  id: string;
  goal_id: string;
  cron?: string | null;
  interval_seconds?: number | null;
  timezone: string;
  enabled: boolean;
  next_run_at?: Date | null;
  last_run_at?: Date | null;
  created_at: Date;
}

export interface CreateGoalInput extends Omit<AgentGoal, 'id' | 'created_at' | 'updated_at' | 'completed_at'> {}
export type UpdateGoalInput = Partial<Omit<AgentGoal, 'id' | 'created_at' | 'updated_at'>>;

export interface CreatePlanInput extends Omit<AgentPlan, 'id' | 'created_at'> {}
export interface CreateRunInput extends Omit<AgentRun, 'id' | 'created_at' | 'updated_at' | 'started_at' | 'finished_at'> {}
export type UpdateRunInput = Partial<Omit<AgentRun, 'id' | 'created_at' | 'updated_at'>>;

export interface CreateStepInput extends Omit<AgentStep, 'id' | 'created_at' | 'started_at' | 'finished_at'> {}
export type UpdateStepInput = Partial<Omit<AgentStep, 'id' | 'created_at'>>;

export interface CreateToolCallInput extends Omit<ToolCall, 'id' | 'created_at' | 'started_at' | 'finished_at'> {}
export type UpdateToolCallInput = Partial<Omit<ToolCall, 'id' | 'created_at'>>;

export interface CreateApprovalRequestInput extends Omit<ApprovalRequest, 'id' | 'created_at' | 'resolved_at'> {}
export interface CreateMemoryInput extends Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at' | 'expires_at'> {}
export interface SearchMemoryInput {
  workspace_id: string;
  user_id?: string;
  channel_id?: string;
  kind?: string;
  limit?: number;
}
export interface CreateAuditEventInput extends Omit<AuditEvent, 'id' | 'created_at'> {}

export interface AgentRunTrace {
  run: AgentRun;
  goal: AgentGoal;
  plan?: AgentPlan;
  steps: AgentStep[];
  toolCalls: ToolCall[];
  approvals: ApprovalRequest[];
  auditEvents: AuditEvent[];
}

export interface ListRunsFilter {
  workspace_id?: string;
  goal_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}
