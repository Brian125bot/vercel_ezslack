export const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_goals (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL,
        created_by_user_id text NOT NULL,
        source text NOT NULL,
        source_channel_id text,
        source_thread_ts text,
        source_message_ts text,
        title text NOT NULL,
        original_instruction text NOT NULL,
        normalized_objective text,
        status text NOT NULL,
        priority text NOT NULL DEFAULT 'normal',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS agent_plans (
        id uuid PRIMARY KEY,
        goal_id uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
        version integer NOT NULL,
        summary text NOT NULL,
        assumptions jsonb NOT NULL DEFAULT '[]',
        risks jsonb NOT NULL DEFAULT '[]',
        steps jsonb NOT NULL DEFAULT '[]',
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id uuid PRIMARY KEY,
        goal_id uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
        plan_id uuid REFERENCES agent_plans(id),
        status text NOT NULL,
        model text NOT NULL,
        current_step_id uuid,
        result_summary text,
        failure_reason text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS agent_steps (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        plan_step_id text,
        order_index integer NOT NULL,
        title text NOT NULL,
        status text NOT NULL,
        tool_call_id uuid,
        input jsonb NOT NULL DEFAULT '{}',
        output jsonb,
        error text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        step_id uuid REFERENCES agent_steps(id),
        tool_name text NOT NULL,
        input jsonb NOT NULL DEFAULT '{}',
        output jsonb,
        status text NOT NULL,
        risk_level text NOT NULL,
        approval_id uuid,
        error text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id uuid PRIMARY KEY,
        goal_id uuid REFERENCES agent_goals(id) ON DELETE CASCADE,
        run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
        step_id uuid REFERENCES agent_steps(id),
        tool_call_id uuid REFERENCES tool_calls(id),
        requested_from_user_id text NOT NULL,
        channel_id text,
        message_ts text,
        title text NOT NULL,
        description text NOT NULL,
        risk_level text NOT NULL,
        proposed_action jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS memory_records (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL,
        user_id text,
        channel_id text,
        kind text NOT NULL,
        content text NOT NULL,
        source text NOT NULL,
        source_ref jsonb,
        confidence numeric NOT NULL DEFAULT 1,
        visibility text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id uuid PRIMARY KEY,
        workspace_id text,
        goal_id uuid REFERENCES agent_goals(id) ON DELETE SET NULL,
        run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
        step_id uuid REFERENCES agent_steps(id) ON DELETE SET NULL,
        type text NOT NULL,
        actor text NOT NULL,
        summary text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS scheduled_triggers (
        id uuid PRIMARY KEY,
        goal_id uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
        cron text,
        interval_seconds integer,
        timezone text NOT NULL DEFAULT 'UTC',
        enabled boolean NOT NULL DEFAULT true,
        next_run_at timestamptz,
        last_run_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- Add useful indexes
      CREATE INDEX IF NOT EXISTS idx_goals_workspace_status_created ON agent_goals(workspace_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_goal_status_created ON agent_runs(goal_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_steps_run_order ON agent_steps(run_id, order_index);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run_status ON tool_calls(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_approvals_status_expires ON approval_requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_memory_workspace_user_channel_kind ON memory_records(workspace_id, user_id, channel_id, kind);
      CREATE INDEX IF NOT EXISTS idx_audit_run_created ON audit_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_enabled_next_run ON scheduled_triggers(enabled, next_run_at);
    `
  },
  {
    version: 2,
    name: 'worker_queue_and_loop',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS iteration_count INT DEFAULT 0;
      ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS claimed_by text;
      ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
      ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
      ALTER TABLE agent_steps ADD COLUMN IF NOT EXISTS plan_id uuid;

      CREATE INDEX IF NOT EXISTS idx_runs_queued ON agent_runs(status) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS idx_runs_lease ON agent_runs(lease_expires_at) WHERE status='running' OR claimed_by IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_steps_plan_id ON agent_steps(plan_id);
    `
  }
];
