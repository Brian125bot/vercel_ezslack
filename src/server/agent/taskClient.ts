import { slog } from './log.js';

const ENQUEUE_MAX_RETRIES = 3;
const ENQUEUE_RETRY_BASE_MS = 1000;

/**
 * Triggers a run via the Vercel Workflow endpoint with exponential-backoff retry.
 */
export async function enqueueRunTask(runId: string, logItemId?: string): Promise<boolean> {
  const url = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (!url) {
    slog('taskClient', 'skip_enqueue', { runId, reason: 'Missing APP_URL configuration' });
    return false;
  }

  const endpoint = `${url.replace(/\/$/, '')}/api/workflows/agentRun`;

  for (let attempt = 0; attempt <= ENQUEUE_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, logItemId })
      });

      if (res.ok) {
        slog('taskClient', 'enqueued_run', { runId, endpoint, attempt });
        return true;
      }

      // Client errors (4xx) won't resolve by retrying — give up immediately
      if (res.status >= 400 && res.status < 500) {
        slog('taskClient', 'enqueue_error', { runId, error: `HTTP ${res.status}`, endpoint });
        return false;
      }

      // Server errors (5xx) — retry with backoff
      if (attempt < ENQUEUE_MAX_RETRIES) {
        const delay = ENQUEUE_RETRY_BASE_MS * Math.pow(2, attempt);
        slog('taskClient', 'enqueue_retry', { runId, attempt: attempt + 1, delay, status: res.status });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      slog('taskClient', 'enqueue_error', { runId, error: `HTTP ${res.status} after ${ENQUEUE_MAX_RETRIES} retries`, endpoint });
    } catch (err: any) {
      // Network/connection errors — retry with backoff
      if (attempt < ENQUEUE_MAX_RETRIES) {
        const delay = ENQUEUE_RETRY_BASE_MS * Math.pow(2, attempt);
        slog('taskClient', 'enqueue_retry', { runId, attempt: attempt + 1, delay, error: err.message });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      slog('taskClient', 'enqueue_error', { runId, error: err.message, attempt });
    }
  }
  return false;
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
