import { slog } from './log.js';
import crypto from 'crypto';

/**
 * Triggers a run via the Vercel Workflow endpoint.
 */
export async function enqueueRunTask(runId: string, logItemId?: string): Promise<void> {
  const url = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (!url) {
    slog('taskClient', 'skip_enqueue', { runId, reason: 'Missing APP_URL configuration' });
    return;
  }

  const endpoint = `${url.replace(/\/$/, '')}/api/workflows/agentRun`;

  try {
    // Vercel workflow trigger expects the payload logic.
    // However, in routes.ts, the initial slack event sends the full event payload.
    // enqueueRunTask is used for subsequent steps or deferred runs.
    // We can just trigger the same endpoint with a runId, 
    // and we must update our Vercel workflow endpoint to handle just `runId` as well!
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ runId, logItemId })
    });
    
    if (!res.ok) {
       throw new Error(`Workflow HTTP error! status: ${res.status}`);
    }
    slog('taskClient', 'enqueued_run', { runId, endpoint });
  } catch (err: any) {
    slog('taskClient', 'enqueue_error', { runId, error: err.message });
  }
}

/**
 * Triggers the Vercel Cron endpoint manually if needed.
 */
export async function enqueueSchedulerPollTask(): Promise<void> {
  const url = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  const secret = process.env.CRON_SECRET;
  
  if (!url) {
    slog('taskClient', 'skip_enqueue_poll', { reason: 'Missing APP_URL configuration' });
    return;
  }

  const endpoint = `${url.replace(/\/$/, '')}/api/cron/poll`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (secret) {
     headers['Authorization'] = `Bearer ${secret}`;
  }

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers
    });
    slog('taskClient', 'enqueued_poll', { endpoint });
  } catch (err: any) {
    slog('taskClient', 'enqueue_poll_error', { error: err.message });
  }
}
