import { agentStore } from '../storage/agentStore.js';
import { slog } from './log.js';

let schedulerInterval: ReturnType<typeof setInterval> | undefined;
let isShuttingDown = false;

const POLL_INTERVAL_MS = 15_000; // 15 seconds

/**
 * Compute the next occurrence from a cron expression (simple subset).
 * Supports: "* * * * *" style with minute/hour/day-of-month/month/day-of-week.
 * For simplicity, this handles interval_seconds directly and delegates
 * cron to a basic next-minute calculation.  A full cron parser (e.g.
 * `cron-parser`) should be used in production.
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
    // Very basic: just schedule for 1 minute from now as a safe fallback.
    // In production, integrate `cron-parser` for proper cron evaluation.
    try {
      const parts = cron.trim().split(/\s+/);
      if (parts.length === 5) {
        // If all wildcards, run every minute
        const allWild = parts.every(p => p === '*');
        if (allWild) {
          return new Date(Date.now() + 60_000);
        }
        // If minute is a number, run at that minute in the next hour
        const minute = parseInt(parts[0], 10);
        if (!isNaN(minute)) {
          const next = new Date();
          next.setMinutes(minute, 0, 0);
          if (next <= new Date()) {
            next.setHours(next.getHours() + 1);
          }
          return next;
        }
      }
      // Fallback: 1 hour from now
      return new Date(Date.now() + 3600_000);
    } catch {
      return new Date(Date.now() + 3600_000);
    }
  }
  return null;
}

/**
 * Poll the `scheduled_triggers` table for due triggers, enqueue new runs.
 */
async function pollScheduledTriggers(): Promise<void> {
  if (isShuttingDown) return;

  try {
    const dueTriggers = await agentStore.getDueScheduledTriggers();
    
    for (const trigger of dueTriggers) {
      try {
        const goal = await agentStore.getGoal(trigger.goal_id);

        // Create a new run for this triggered goal
        const run = await agentStore.createRun({
          goal_id: trigger.goal_id,
          model: 'gemini-3.1-flash-lite', // default model for scheduled runs
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

        // Compute and set the next run time
        const nextRunAt = computeNextRunAt(trigger.cron, trigger.interval_seconds, trigger.timezone);
        if (nextRunAt) {
          await agentStore.updateScheduledTriggerAfterRun(trigger.id, nextRunAt);
        } else {
          // One-shot trigger: disable after firing
          await agentStore.disableScheduledTrigger(trigger.id);
        }

        // Reset goal status so the new run can process it
        await agentStore.updateGoalStatus(goal.id, 'running');

        slog('scheduler', 'trigger.fired', { trigger_id: trigger.id, run_id: run.id, next_run_at: nextRunAt?.toISOString() });
      } catch (err: any) {
        slog('scheduler', 'trigger.error', { trigger_id: trigger.id, error: err.message });
        // Disable broken triggers to prevent infinite error loops
        try {
          await agentStore.disableScheduledTrigger(trigger.id);
        } catch { /* best effort */ }
      }
    }
  } catch (err: any) {
    slog('scheduler', 'poll.error', { error: err.message });
  }
}

export function startScheduler(): void {
  if (schedulerInterval) return;
  isShuttingDown = false;
  slog('scheduler', 'started', { pollIntervalMs: POLL_INTERVAL_MS });
  pollScheduledTriggers(); // initial poll
  schedulerInterval = setInterval(pollScheduledTriggers, POLL_INTERVAL_MS);
}

export function stopScheduler(): void {
  isShuttingDown = true;
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = undefined;
  }
  slog('scheduler', 'stopped', {});
}
