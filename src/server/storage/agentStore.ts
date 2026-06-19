import { query, withTransaction } from './db.js';
import crypto from 'crypto';
import type {
  AgentGoal, GoalStatus, UpdateGoalInput, CreateGoalInput,
  AgentPlan, CreatePlanInput,
  AgentRun, RunStatus, UpdateRunInput, CreateRunInput,
  AgentStep, StepStatus, UpdateStepInput, CreateStepInput,
  ToolCall, ToolCallStatus, UpdateToolCallInput, CreateToolCallInput,
  ApprovalRequest, CreateApprovalRequestInput,
  MemoryRecord, CreateMemoryInput, SearchMemoryInput,
  AuditEvent, CreateAuditEventInput,
  AgentRunTrace, ListRunsFilter
} from './types.js';

function sanitizePayload(payload: any): any {
  if (!payload) return payload;
  let str;
  try {
    str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch (e) {
    return payload; // if circular or un-stringifiable
  }
  let sanitized = str;
  sanitized = sanitized.replace(/xoxb-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_BOT_TOKEN]');
  sanitized = sanitized.replace(/xoxp-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_USER_TOKEN]');
  sanitized = sanitized.replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, '[REDACTED_GEMINI_API_KEY]');
  sanitized = sanitized.replace(/(password|secret|token)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{8,}/gi, '$1=[REDACTED]');
  return typeof payload === 'string' ? sanitized : JSON.parse(sanitized);
}

export const agentStore = {
  async createGoal(input: CreateGoalInput): Promise<AgentGoal> {
    const id = crypto.randomUUID();
    const rows = await query<AgentGoal>(
      `INSERT INTO agent_goals (id, workspace_id, created_by_user_id, source, source_channel_id, source_thread_ts, source_message_ts, title, original_instruction, normalized_objective, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, input.workspace_id, input.created_by_user_id, input.source, input.source_channel_id || null, input.source_thread_ts || null, input.source_message_ts || null, input.title, input.original_instruction, input.normalized_objective || null, input.status, input.priority]
    );
    return rows[0];
  },

  async updateGoalStatus(id: string, status: GoalStatus, patch?: UpdateGoalInput): Promise<AgentGoal> {
    const completedAt = status === 'completed' ? new Date() : null;
    const rows = await query<AgentGoal>(
      `UPDATE agent_goals SET status = $1, updated_at = now(), completed_at = COALESCE($2, completed_at), title = COALESCE($3, title), normalized_objective = COALESCE($4, normalized_objective) WHERE id = $5 RETURNING *`,
      [status, completedAt, patch?.title || null, patch?.normalized_objective || null, id]
    );
    if (!rows.length) throw new Error(`Goal ${id} not found`);
    return rows[0];
  },

  async createPlan(input: CreatePlanInput): Promise<AgentPlan> {
    const id = crypto.randomUUID();
    const rows = await query<AgentPlan>(
      `INSERT INTO agent_plans (id, goal_id, version, summary, assumptions, risks, steps, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, input.goal_id, input.version, input.summary, JSON.stringify(input.assumptions), JSON.stringify(input.risks), JSON.stringify(input.steps), input.status]
    );
    return rows[0];
  },

  async createRun(input: CreateRunInput): Promise<AgentRun> {
    const id = crypto.randomUUID();
    const rows = await query<AgentRun>(
      `INSERT INTO agent_runs (id, goal_id, plan_id, status, model, current_step_id, result_summary, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, input.goal_id, input.plan_id || null, input.status, input.model, input.current_step_id || null, input.result_summary || null, input.failure_reason || null]
    );
    return rows[0];
  },

  async updateRunStatus(id: string, status: RunStatus, patch?: UpdateRunInput): Promise<AgentRun> {
    let startedAt = status === 'running' && patch?.started_at !== undefined ? patch.started_at : undefined;
    let finishedAt = (status === 'completed' || status === 'failed') ? new Date() : undefined;
    
    const rows = await query<AgentRun>(
      `UPDATE agent_runs SET status = $1, updated_at = now(), 
        current_step_id = COALESCE($2, current_step_id),
        result_summary = COALESCE($3, result_summary),
        failure_reason = COALESCE($4, failure_reason),
        started_at = COALESCE($5, started_at),
        finished_at = COALESCE($6, finished_at)
       WHERE id = $7 RETURNING *`,
      [status, patch?.current_step_id || null, patch?.result_summary || null, patch?.failure_reason || null, startedAt || null, finishedAt || null, id]
    );
    if (!rows.length) throw new Error(`Run ${id} not found`);
    return rows[0];
  },

  async createStep(input: CreateStepInput): Promise<AgentStep> {
    const id = crypto.randomUUID();
    const rows = await query<AgentStep>(
      `INSERT INTO agent_steps (id, run_id, plan_step_id, order_index, title, status, tool_call_id, input, output, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, input.run_id, input.plan_step_id || null, input.order_index, input.title, input.status, input.tool_call_id || null, JSON.stringify(input.input || {}), input.output ? JSON.stringify(input.output) : null, input.error || null]
    );
    return rows[0];
  },

  async updateStepStatus(id: string, status: StepStatus, patch?: UpdateStepInput): Promise<AgentStep> {
    let startedAt = status === 'running' ? new Date() : undefined;
    let finishedAt = (status === 'completed' || status === 'failed') ? new Date() : undefined;

    const rows = await query<AgentStep>(
      `UPDATE agent_steps SET status = $1, 
        tool_call_id = COALESCE($2, tool_call_id),
        output = COALESCE($3, output),
        error = COALESCE($4, error),
        started_at = COALESCE($5, started_at),
        finished_at = COALESCE($6, finished_at)
       WHERE id = $7 RETURNING *`,
      [status, patch?.tool_call_id || null, patch?.output ? JSON.stringify(patch.output) : null, patch?.error || null, startedAt || null, finishedAt || null, id]
    );
    if (!rows.length) throw new Error(`Step ${id} not found`);
    return rows[0];
  },

  async createToolCall(input: CreateToolCallInput): Promise<ToolCall> {
    const id = crypto.randomUUID();
    const rows = await query<ToolCall>(
      `INSERT INTO tool_calls (id, run_id, step_id, tool_name, input, output, status, risk_level, approval_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, input.run_id, input.step_id || null, input.tool_name, JSON.stringify(input.input || {}), input.output ? JSON.stringify(input.output) : null, input.status, input.risk_level, input.approval_id || null, input.error || null]
    );
    return rows[0];
  },

  async updateToolCallStatus(id: string, status: ToolCallStatus, patch?: UpdateToolCallInput): Promise<ToolCall> {
    let startedAt = status === 'running' ? new Date() : undefined;
    let finishedAt = (status === 'completed' || status === 'failed') ? new Date() : undefined;

    const rows = await query<ToolCall>(
      `UPDATE tool_calls SET status = $1, 
        output = COALESCE($2, output),
        error = COALESCE($3, error),
        approval_id = COALESCE($4, approval_id),
        started_at = COALESCE($5, started_at),
        finished_at = COALESCE($6, finished_at)
       WHERE id = $7 RETURNING *`,
      [status, patch?.output ? JSON.stringify(patch.output) : null, patch?.error || null, patch?.approval_id || null, startedAt || null, finishedAt || null, id]
    );
    if (!rows.length) throw new Error(`ToolCall ${id} not found`);
    return rows[0];
  },

  async createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
    const id = crypto.randomUUID();
    const rows = await query<ApprovalRequest>(
      `INSERT INTO approval_requests (id, goal_id, run_id, step_id, tool_call_id, requested_from_user_id, channel_id, message_ts, title, description, risk_level, proposed_action, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [id, input.goal_id || null, input.run_id || null, input.step_id || null, input.tool_call_id || null, input.requested_from_user_id, input.channel_id || null, input.message_ts || null, input.title, input.description, input.risk_level, JSON.stringify(input.proposed_action || {}), input.status, input.expires_at]
    );
    return rows[0];
  },

  async resolveApproval(id: string, status: 'approved' | 'rejected'): Promise<ApprovalRequest> {
    const rows = await query<ApprovalRequest>(
      `UPDATE approval_requests SET status = $1, resolved_at = now() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (!rows.length) throw new Error(`Approval ${id} not found`);
    return rows[0];
  },

  async writeMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    const id = crypto.randomUUID();
    const rows = await query<MemoryRecord>(
      `INSERT INTO memory_records (id, workspace_id, user_id, channel_id, kind, content, source, source_ref, confidence, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, input.workspace_id, input.user_id || null, input.channel_id || null, input.kind, input.content, input.source, input.source_ref ? JSON.stringify(input.source_ref) : null, input.confidence, input.visibility]
    );
    return rows[0];
  },

  async searchMemory(input: SearchMemoryInput): Promise<MemoryRecord[]> {
    let sql = `SELECT * FROM memory_records WHERE workspace_id = $1`;
    const params: any[] = [input.workspace_id];
    if (input.user_id) {
      params.push(input.user_id);
      sql += ` AND (user_id = $${params.length} OR visibility = 'workspace' OR visibility = 'public')`;
    }
    if (input.channel_id) {
      params.push(input.channel_id);
      sql += ` AND (channel_id = $${params.length} OR visibility = 'public')`;
    }
    if (input.kind) {
      params.push(input.kind);
      sql += ` AND kind = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ${input.limit || 50}`;
    return query<MemoryRecord>(sql, params);
  },

  async appendAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const id = crypto.randomUUID();
    const sanitizedPayload = sanitizePayload(input.payload);
    const rows = await query<AuditEvent>(
      `INSERT INTO audit_events (id, workspace_id, goal_id, run_id, step_id, type, actor, summary, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, input.workspace_id || null, input.goal_id || null, input.run_id || null, input.step_id || null, input.type, input.actor, input.summary, JSON.stringify(sanitizedPayload || {})]
    );
    return rows[0];
  },

  async getRunTrace(runId: string): Promise<AgentRunTrace> {
    const runs = await query<AgentRun>(`SELECT * FROM agent_runs WHERE id = $1`, [runId]);
    if (!runs.length) throw new Error(`Run ${runId} not found`);
    const run = runs[0];

    const goals = await query<AgentGoal>(`SELECT * FROM agent_goals WHERE id = $1`, [run.goal_id]);
    const plan = run.plan_id ? (await query<AgentPlan>(`SELECT * FROM agent_plans WHERE id = $1`, [run.plan_id]))[0] : undefined;
    const steps = await query<AgentStep>(`SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY order_index ASC`, [run.id]);
    const toolCalls = await query<ToolCall>(`SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY created_at ASC`, [run.id]);
    const approvals = await query<ApprovalRequest>(`SELECT * FROM approval_requests WHERE run_id = $1 ORDER BY created_at ASC`, [run.id]);
    const auditEvents = await query<AuditEvent>(`SELECT * FROM audit_events WHERE run_id = $1 ORDER BY created_at ASC`, [run.id]);

    return {
      run,
      goal: goals[0],
      plan,
      steps,
      toolCalls,
      approvals,
      auditEvents
    };
  },

  async listRuns(filter: ListRunsFilter): Promise<AgentRun[]> {
    let sql = `SELECT * FROM agent_runs WHERE 1=1`;
    const params: any[] = [];
    if (filter.goal_id) {
      params.push(filter.goal_id);
      sql += ` AND goal_id = $${params.length}`;
    }
    if (filter.status) {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ${filter.limit || 50} OFFSET ${filter.offset || 0}`;
    return query<AgentRun>(sql, params);
  },

  async getGoal(goalId: string): Promise<AgentGoal> {
    const rows = await query<AgentGoal>(`SELECT * FROM agent_goals WHERE id = $1`, [goalId]);
    if (!rows.length) throw new Error(`Goal ${goalId} not found`);
    return rows[0];
  }
};
