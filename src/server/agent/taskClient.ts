import { slog } from './log.js';

const ENQUEUE_MAX_RETRIES = 3;
const ENQUEUE_RETRY_BASE_MS = 1000;
const ENQUEUE_FETCH_TIMEOUT_MS = parseInt(process.env.ENQUEUE_FETCH_TIMEOUT_MS || '5000');

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

  // The timeout guard only fires when the run has already exceeded its
  // logical deadline. We fail-fast to avoid spending 20+ seconds retrying
  // when the function's hard deadline is near. The database row is already
  // atomically marked 'queued', so the cron poller will pick it up if this
  // fails — no permanent data loss.
  const ENQUEUE_RUN_MAX_RETRIES = 2; // timeout-guard context: fail fast

  for (let attempt = 0; attempt <= ENQUEUE_RUN_MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      if (bypassSecret) {
        headers['x-vercel-protection-bypass'] = bypassSecret;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, logItemId }),
        signal: AbortSignal.timeout(ENQUEUE_FETCH_TIMEOUT_MS)
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

      // 508 Loop Detected: Vercel's platform identified this as part of a
      // recursive function-invocation chain. Another invocation already owns
      // this run — retrying only adds another request to the same loop, so
      // this is terminal, not transient.
      if (res.status === 508) {
        slog('taskClient', 'enqueue_error', { runId, error: 'HTTP 508 Loop Detected — not retrying', endpoint });
        return false;
      }

      // Server errors (5xx) — retry with backoff
      if (attempt < ENQUEUE_RUN_MAX_RETRIES) {
        const delay = ENQUEUE_RETRY_BASE_MS * Math.pow(2, attempt);
        slog('taskClient', 'enqueue_retry', { runId, attempt: attempt + 1, delay, status: res.status });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      slog('taskClient', 'enqueue_error', { runId, error: `HTTP ${res.status} after ${ENQUEUE_RUN_MAX_RETRIES} retries`, endpoint });
    } catch (err: any) {
      const errorMsg = err.name === 'TimeoutError' ? 'fetch timed out' : err.message;
      // Network/connection errors — retry with backoff
      if (attempt < ENQUEUE_RUN_MAX_RETRIES) {
        const delay = ENQUEUE_RETRY_BASE_MS * Math.pow(2, attempt);
        slog('taskClient', 'enqueue_retry', { runId, attempt: attempt + 1, delay, error: errorMsg });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      slog('taskClient', 'enqueue_error', { runId, error: errorMsg, attempt });
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
      headers,
      signal: AbortSignal.timeout(ENQUEUE_FETCH_TIMEOUT_MS)
    });
    slog('taskClient', 'enqueued_poll', { endpoint });
  } catch (err: any) {
    const errorMsg = err.name === 'TimeoutError' ? 'fetch timed out' : err.message;
    slog('taskClient', 'enqueue_poll_error', { error: errorMsg });
  }
}
