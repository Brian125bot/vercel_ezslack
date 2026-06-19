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

import { sanitizePayload } from '../agent/sanitize.js';

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
    const completedAt = (['completed', 'failed', 'cancelled', 'blocked'].includes(status)) ? new Date() : null;
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
    let finishedAt = (['succeeded', 'failed', 'cancelled', 'blocked'].includes(status)) ? new Date() : undefined;
    
    const rows = await query<AgentRun>(
      `UPDATE agent_runs SET status = $1, updated_at = now(), 
        current_step_id = COALESCE($2, current_step_id),
        result_summary = COALESCE($3, result_summary),
        failure_reason = COALESCE($4, failure_reason),
        started_at = COALESCE($5, started_at),
        finished_at = COALESCE($6, finished_at),
        plan_id = COALESCE($7, plan_id)
       WHERE id = $8 RETURNING *`,
      [status, patch?.current_step_id || null, patch?.result_summary || null, patch?.failure_reason || null, startedAt || null, finishedAt || null, patch?.plan_id || null, id]
    );
    if (!rows.length) throw new Error(`Run ${id} not found`);
    return rows[0];
  },

  async createStep(input: CreateStepInput): Promise<AgentStep> {
    const id = crypto.randomUUID();
    const rows = await query<AgentStep>(
      `INSERT INTO agent_steps (id, run_id, plan_id, plan_step_id, order_index, title, status, tool_call_id, input, output, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [id, input.run_id, input.plan_id || null, input.plan_step_id || null, input.order_index, input.title, input.status, input.tool_call_id || null, JSON.stringify(input.input || {}), input.output ? JSON.stringify(input.output) : null, input.error || null]
    );
    return rows[0];
  },

  async updateStepStatus(id: string, status: StepStatus, patch?: UpdateStepInput): Promise<AgentStep> {
    let startedAt = status === 'running' ? new Date() : undefined;
    let finishedAt = (status === 'succeeded' || status === 'failed') ? new Date() : undefined;

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
    let finishedAt = (status === 'succeeded' || status === 'failed') ? new Date() : undefined;

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
    const sanitizedContent = sanitizePayload(input.content);
    const rows = await query<MemoryRecord>(
      `INSERT INTO memory_records (id, workspace_id, user_id, channel_id, kind, content, source, source_ref, confidence, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, input.workspace_id, input.user_id || null, input.channel_id || null, input.kind, sanitizedContent, input.source, input.source_ref ? JSON.stringify(input.source_ref) : null, input.confidence, input.visibility]
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
  },

  async listAuditEvents(runId: string): Promise<AuditEvent[]> {
    return query<AuditEvent>(`SELECT * FROM audit_events WHERE run_id = $1 ORDER BY created_at ASC`, [runId]);
  },

  async hasPendingApproval(workspaceId: string, channelId: string): Promise<boolean> {
    const rows = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 
         FROM approval_requests a
         JOIN agent_goals g ON a.goal_id = g.id
         WHERE g.workspace_id = $1 AND a.channel_id = $2 AND a.status = 'pending' AND a.expires_at > now()
       ) as exists`,
      [workspaceId, channelId]
    );
    return !!rows[0]?.exists;
  },

  async getPendingApprovals(workspaceId: string, channelId: string): Promise<ApprovalRequest[]> {
    return query<ApprovalRequest>(
      `SELECT a.* FROM approval_requests a
       JOIN agent_goals g ON a.goal_id = g.id
       WHERE g.workspace_id = $1 AND a.channel_id = $2 AND a.status = 'pending' AND a.expires_at > now()`,
      [workspaceId, channelId]
    );
  },

  async getActiveRunsByChannel(workspaceId: string, channelId: string): Promise<AgentRun[]> {
    return query<AgentRun>(
      `SELECT r.* FROM agent_runs r
       JOIN agent_goals g ON r.goal_id = g.id
       WHERE g.workspace_id = $1 AND g.source_channel_id = $2
         AND r.status NOT IN ('succeeded', 'failed', 'cancelled')`,
      [workspaceId, channelId]
    );
  },

  async getRun(id: string): Promise<AgentRun> {
    const rows = await query<AgentRun>(`SELECT * FROM agent_runs WHERE id = $1`, [id]);
    if (!rows.length) throw new Error(`Run ${id} not found`);
    return rows[0];
  },

  async getStep(id: string): Promise<AgentStep> {
    const rows = await query<AgentStep>(`SELECT * FROM agent_steps WHERE id = $1`, [id]);
    if (!rows.length) throw new Error(`Step ${id} not found`);
    return rows[0];
  },

  async getStepsForRun(runId: string): Promise<AgentStep[]> {
    return query<AgentStep>(`SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY order_index ASC`, [runId]);
  },

  async getStepsForPlan(planId: string): Promise<AgentStep[]> {
    return query<AgentStep>(`SELECT * FROM agent_steps WHERE plan_id = $1 ORDER BY order_index ASC`, [planId]);
  },

  async getApprovalsForRun(runId: string): Promise<ApprovalRequest[]> {
    return query<ApprovalRequest>(`SELECT * FROM approval_requests WHERE run_id = $1 ORDER BY created_at ASC`, [runId]);
  },

  async getAuditEventsForRun(runId: string): Promise<AuditEvent[]> {
    return query<AuditEvent>(`SELECT * FROM audit_events WHERE run_id = $1 ORDER BY created_at ASC`, [runId]);
  },

  async incrementRunIteration(runId: string): Promise<AgentRun> {
    const rows = await query<AgentRun>(
      `UPDATE agent_runs SET iteration_count = COALESCE(iteration_count, 0) + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [runId]
    );
    if (!rows.length) throw new Error(`Run ${runId} not found`);
    return rows[0];
  },

  async claimNextQueuedRun(workerId: string, leaseSeconds: number): Promise<AgentRun | null> {
    const rows = await query<AgentRun>(
      `UPDATE agent_runs 
       SET status = 'running', claimed_by = $1, claimed_at = now(), lease_expires_at = now() + interval '1 second' * $2, updated_at = now()
       WHERE id = (
         SELECT id FROM agent_runs 
         WHERE status = 'queued' 
         ORDER BY created_at ASC 
         FOR UPDATE SKIP LOCKED 
         LIMIT 1
       ) RETURNING *`,
      [workerId, leaseSeconds]
    );
    return rows.length ? rows[0] : null;
  },

  async renewLease(runId: string, leaseSeconds: number): Promise<void> {
    await query(
      `UPDATE agent_runs SET lease_expires_at = now() + interval '1 second' * $1, updated_at = now() WHERE id = $2`,
      [leaseSeconds, runId]
    );
  },

  async recoverStaleClaims(): Promise<number> {
    const rows = await query<AgentRun>(
      `UPDATE agent_runs 
       SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE status = 'running' AND lease_expires_at < now()
       RETURNING *`
    );
    for (const run of rows) {
      await this.appendAuditEvent({
        workspace_id: null,
        goal_id: run.goal_id,
        run_id: run.id,
        type: 'run.recovered',
        actor: 'system',
        summary: `Recovered stale run claim for ${run.id}`,
        payload: {}
      });
    }
    return rows.length;
  },

  async countRunningRuns(): Promise<number> {
    const rows = await query<{ count: number }>(`SELECT count(*) as count FROM agent_runs WHERE status = 'running'`);
    return Number(rows[0]?.count || 0);
  }
};
