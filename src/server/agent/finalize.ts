import { agentStore } from '../storage/agentStore.js';
import type { AgentRun } from '../storage/types.js';
import { slackReplyInThreadTool } from '../tools/slack.js';
import { slog } from './log.js';

export async function finalizeRun(run: AgentRun, finalState: 'succeeded' | 'failed' | 'cancelled' | 'blocked', reason?: string): Promise<void> {
  let resultSummary = reason || undefined;
  let failureReason = finalState === 'failed' ? reason : undefined;
  
  // Terminal transitions: goal mappings
  // succeeded -> completed
  // failed -> failed
  // cancelled -> cancelled
  // blocked -> blocked
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

  try {
    const goal = await agentStore.getGoal(run.goal_id);
    let msg = `Task finished with status: ${finalState}.`;
    if (reason) msg += ` Reason: ${reason}`;
    
    if (goal.source_channel_id) {
      await slackReplyInThreadTool.execute({
        text: msg
      }, {
        runId: run.id,
        stepId: 'final',
        workspaceId: goal.workspace_id,
        channelId: goal.source_channel_id,
        userId: goal.created_by_user_id,
        messageTs: goal.source_message_ts || '',
        threadTs: goal.source_thread_ts || ''
      });
    }
  } catch (err: any) {
    slog('finalize', 'log', { err: err.message, run_id: run.id });
  }
}
