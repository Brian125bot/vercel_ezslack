import { agentStore } from '../storage/agentStore.js';
import { runLoop } from './loop.js';
import { slog } from './log.js';
import { finalizeRun } from './finalize.js';

const inFlightRuns = new Set<string>();
export const MAX_CONCURRENT = parseInt(process.env.WORKER_MAX_CONCURRENT || '2');

export async function processQueue() {
  try {
    const expiredApprovals = await agentStore.reapExpiredApprovals();

    // Notify users about expired approvals
    for (const approval of expiredApprovals) {
      if (approval.channel_id && approval.requested_from_user_id) {
        try {
          const { slackReplyInThreadTool } = await import('../tools/slack.js');
          await slackReplyInThreadTool.execute({
            text: `⏱️ The approval request "${approval.title}" has expired (30 minute timeout). The associated task has been cancelled.`
          }, {
            workspaceId: '',
            channelId: approval.channel_id,
            userId: approval.requested_from_user_id,
            runId: approval.run_id || '',
            stepId: '',
            messageTs: '',
            threadTs: ''
          });
        } catch { /* notification failure is non-fatal */ }
      }
    }
    
    // Process up to MAX_CONCURRENT runs (usually 1 if triggered by a single task)
    while (inFlightRuns.size < MAX_CONCURRENT) {
      const workerId = `worker-${process.pid}-${crypto.randomUUID()}`;
      
      // We don't use LEASE_SECONDS anymore for lock expiry, but we pass an arbitrary time 
      // since Cloud Tasks handles the timeout and retries now.
      const run = await agentStore.claimNextQueuedRun(workerId, 3600);
      
      if (!run) {
        break; // No more queued runs
      }

      inFlightRuns.add(run.id);
      
      // Execute synchronously or in background, but we need to await it for Cloud Tasks
      try {
        await runLoop(run, workerId);
      } catch (err: any) {
        slog('worker', 'runLoop.error', { run_id: run.id, error: err.message });
        try {
          await finalizeRun(run, 'failed', err.message);
        } catch (finalizeErr: any) {
          slog('worker', 'finalizeRun.error', { run_id: run.id, error: finalizeErr.message });
        }
      } finally {
        inFlightRuns.delete(run.id);
      }
    }
  } catch (err: any) {
    slog('worker', 'processQueue.error', { error: err.message });
  }
}

// Stubs to avoid breaking imports in server.ts
export function startWorker() {
  slog('worker', 'started', { mode: 'cloud-tasks' });
}

export function stopWorker() {
  slog('worker', 'stopped', { mode: 'cloud-tasks' });
}

