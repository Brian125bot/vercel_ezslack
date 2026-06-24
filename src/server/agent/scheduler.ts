import { agentStore } from '../storage/agentStore.js';
import { slog } from './log.js';

let schedulerInterval: ReturnType<typeof setInterval> | undefined;
let isShuttingDown = false;

const POLL_INTERVAL_MS = 15_000; // 15 seconds

/**
 * Compute the next occurrence from a cron expression using `cron-parser`,
 * or from a fixed interval in seconds. Falls back gracefully if the cron
 * library is unavailable or the expression is invalid.
 */
function computeNextRunAt(
  cron: string | null | undefined,
  intervalSeconds: number | null | undefined,
  timezone: string
): Date | null {
  if (intervalSeconds && intervalSeconds > 0) {
    return new Date(Date.now() + intervalSeconds * 1000);
  }
  if (cron) {
    try {
      // Dynamic import guard — cron-parser may not be installed in all environments
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CronExpressionParser } = require('cron-parser');
      const interval = CronExpressionParser.parse(cron, {
        tz: timezone || 'UTC',
        currentDate: new Date(),
      });
      return interval.next().toDate();
    } catch (err: any) {
      slog('scheduler', 'cron.parse.error', { cron, error: err.message });
      // Fallback: basic parsing for simple cases
      try {
        const parts = cron.trim().split(/\s+/);
        if (parts.length === 5) {
          const allWild = parts.every(p => p === '*');
          if (allWild) return new Date(Date.now() + 60_000);
          const minute = parseInt(parts[0], 10);
          if (!isNaN(minute)) {
            const next = new Date();
            next.setMinutes(minute, 0, 0);
            if (next <= new Date()) next.setHours(next.getHours() + 1);
            return next;
          }
        }
      } catch { /* fall through */ }
      return new Date(Date.now() + 3600_000); // ultimate fallback: 1 hour
    }
  }
  return null; // one-shot, no recurrence
}

/**
 * Poll the `scheduled_triggers` table for due triggers, enqueue new runs.
 */
export async function pollScheduledTriggers(): Promise<void> {
  try {
    const dueTriggers = await agentStore.getDueScheduledTriggers();
    
    // getDueScheduledTriggers atomically claims (DELETE + RETURNING) so
    // concurrent pollers on multiple Cloud Run instances never double-fire.
    for (const trigger of dueTriggers) {
      try {
        const goal = await agentStore.getGoal(trigger.goal_id);

        // Inherit model from the goal's most recent run, or use a default
        let model = 'gemini-2.5-flash';
        const previousRuns = await agentStore.getRunsForGoal(trigger.goal_id);
        if (previousRuns.length > 0) {
          model = previousRuns[previousRuns.length - 1].model;
        }

        // Create a new run for this triggered goal
        const run = await agentStore.createRun({
          goal_id: trigger.goal_id,
          model,
          status: 'queued'
        });

        await agentStore.appendAuditEvent({
          workspace_id: goal.workspace_id,
          goal_id: trigger.goal_id,
          run_id: run.id,
          type: 'scheduled.triggered',
          actor: 'scheduler',
          summary: `Scheduled trigger ${trigger.id} fired, run ${run.id} enqueued`,
          payload: { triggerId: trigger.id, cron: trigger.cron, interval_seconds: trigger.interval_seconds }
        });

        // Compute the next run time and re-insert for recurring triggers
        const nextRunAt = computeNextRunAt(trigger.cron, trigger.interval_seconds, trigger.timezone);
        await agentStore.reinsertScheduledTrigger(trigger, nextRunAt);
        // One-shot triggers (nextRunAt === null) are not re-inserted → effectively disabled

        // Reset goal status so the new run can process it
        await agentStore.updateGoalStatus(goal.id, 'running');

        slog('scheduler', 'trigger.fired', { trigger_id: trigger.id, run_id: run.id, next_run_at: nextRunAt?.toISOString() });
        
        // IMPORTANT: Enqueue the task immediately to Cloud Tasks
        const { enqueueRunTask } = await import('./taskClient.js');
        await enqueueRunTask(run.id);
        
      } catch (err: any) {
        slog('scheduler', 'trigger.error', { trigger_id: trigger.id, error: err.message });
        // Trigger was already deleted by the atomic claim, so broken triggers
        // won't loop — they simply won't be re-inserted.
      }
    }
  } catch (err: any) {
    slog('scheduler', 'poll.error', { error: err.message });
  }
}

// Stubs to avoid breaking server.ts
export function startScheduler(): void {
  slog('scheduler', 'started', { mode: 'cloud-tasks' });
}

export function stopScheduler(): void {
  slog('scheduler', 'stopped', { mode: 'cloud-tasks' });
}
