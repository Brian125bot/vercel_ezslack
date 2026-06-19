/**
 * finalizeRun — the SINGLE terminal code path for a run (W2-C / W2-F11).
 *
 * Every terminal transition (succeeded / failed / cancelled / blocked) goes through here so
 * that run status, goal status, finished_at, the audit trail, and the Slack report are always
 * kept consistent. Nothing else in the codebase should set a terminal run status directly.
 */
import { agentStore } from '../storage/agentStore.js';
import { reportStatus } from './reporter.js';
import { slog } from './log.js';
import type { GoalStatus, RunStatus } from '../storage/types.js';
import type { ToolExecutionContext } from './types.js';

export type TerminalState = 'succeeded' | 'failed' | 'cancelled' | 'blocked';

const RUN_TO_GOAL: Record<TerminalState, GoalStatus> = {
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'blocked',
};

export interface FinalizeArgs {
  runId: string;
  goalId: string;
  workspaceId: string;
  state: TerminalState;
  summary?: string;
  failureReason?: string;
  context?: ToolExecutionContext;
}

export async function finalizeRun(args: FinalizeArgs): Promise<void> {
  const { runId, goalId, workspaceId, state, summary, failureReason, context } = args;

  // Run status. `blocked` is technically a holding state, but we treat it as a terminal exit of
  // the loop (awaiting user action) and finalize the goal status accordingly.
  const runStatus: RunStatus = state;
  await agentStore.updateRunStatus(runId, runStatus, {
    result_summary: summary || null,
    failure_reason: failureReason || null,
  } as any);
  await agentStore.updateGoalStatus(goalId, RUN_TO_GOAL[state]);

  await agentStore.appendAuditEvent({
    workspace_id: workspaceId,
    goal_id: goalId,
    run_id: runId,
    type: `run.${state}`,
    actor: 'system',
    summary: summary || failureReason || `Run ${state}`,
    payload: { state, summary, failureReason },
  });

  slog('finalize', `run.${state}`, { runId, goalId, summary, failureReason });

  // Slack report (best-effort).
  if (context) {
    try {
      if (state === 'succeeded') {
        await reportStatus('completed', summary || 'Goal completed.', context);
      } else if (state === 'blocked') {
        await reportStatus('blocked', failureReason || summary || 'Run is blocked awaiting action.', context);
      } else if (state === 'cancelled') {
        await reportStatus('blocked', failureReason || 'Run cancelled.', context);
      } else {
        await reportStatus('failed', failureReason || summary || 'Goal failed.', context);
      }
    } catch (err) {
      slog('finalize', 'report.error', { runId, error: String(err) });
    }
  }
}
