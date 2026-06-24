import { agentStore } from '../storage/agentStore.js';
import type { AgentRun } from '../storage/types.js';
import { reportRunResult } from './reporter.js';
import { slog } from './log.js';

export async function finalizeRun(run: AgentRun, finalState: 'succeeded' | 'failed' | 'cancelled' | 'blocked', reason?: string): Promise<void> {
  let resultSummary = reason || undefined;
  let failureReason = finalState === 'failed' ? reason : undefined;
  
  // Terminal transitions: goal mappings
  let goalState: 'completed' | 'failed' | 'cancelled' | 'blocked' = 'completed';
  if (finalState === 'failed') goalState = 'failed';
  if (finalState === 'cancelled') goalState = 'cancelled';
  if (finalState === 'blocked') goalState = 'blocked';

  await agentStore.updateRunStatus(run.id, finalState, { 
    result_summary: resultSummary, 
    failure_reason: failureReason 
  });
  
  await agentStore.updateGoalStatus(run.goal_id, goalState);

  await agentStore.appendAuditEvent({
    workspace_id: null,
    goal_id: run.goal_id,
    run_id: run.id,
    type: `run.${finalState}`,
    actor: 'system',
    summary: `Run finalized as ${finalState}${reason ? ': ' + reason : ''}`,
    payload: { failure_reason: failureReason, result_summary: resultSummary }
  });

  // W3-D: Post an action-aware run report instead of a generic message
  try {
    const goal = await agentStore.getGoal(run.goal_id);
    
    if (goal.source_channel_id) {
      const trace = await agentStore.getRunTrace(run.id);
      const executionContext = {
        runId: run.id,
        stepId: 'final',
        workspaceId: goal.workspace_id,
        channelId: goal.source_channel_id,
        userId: goal.created_by_user_id,
        messageTs: goal.source_message_ts || '',
        threadTs: goal.source_thread_ts || ''
      };

      try {
        await reportRunResult(trace, executionContext);
      } catch (reportErr: any) {
        slog('finalize', 'reportRunResult.error', { err: reportErr.message, run_id: run.id });
        
        // Fallback to simpler status report if rich report fails
        try {
          const { reportStatus } = await import('./reporter.js');
          await reportStatus(
            finalState === 'succeeded' ? 'completed' : finalState as any, 
            `Run finished with status: ${finalState}. (Detailed report failed to send)`, 
            executionContext
          );
        } catch (fallbackErr: any) {
          slog('finalize', 'reportStatus.fallback.error', { err: fallbackErr.message, run_id: run.id });
          await agentStore.updateRunStatus(run.id, finalState, { 
            failure_reason: `Completed but failed to report to Slack: ${fallbackErr.message}` 
          });
        }
      }
    }
  } catch (err: any) {
    slog('finalize', 'fatal.error', { err: err.message, run_id: run.id });
  }
}
