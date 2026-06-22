import { agentStore } from '../storage/agentStore.js';
import { runLoop } from './loop.js';
import { slog } from './log.js';
import { finalizeRun } from './finalize.js';

let workerInterval: any;
let isShuttingDown = false;
const inFlightRuns = new Set<string>();
export const MAX_CONCURRENT = parseInt(process.env.WORKER_MAX_CONCURRENT || '2');
export const LEASE_SECONDS = parseInt(process.env.WORKER_LEASE_SECONDS || '300');

const STUCK_GRACE_SECONDS = LEASE_SECONDS + 300; // 5 min lease + 5 min grace = 10 min total

async function detectAndRecoverStuckRuns(): Promise<void> {
  try {
    const stuckRuns = await agentStore.detectStuckRuns(STUCK_GRACE_SECONDS);
    for (const run of stuckRuns) {
      // Skip runs that are currently being processed by this worker instance
      if (inFlightRuns.has(run.id)) continue;

      slog('worker', 'stuck_run_detected', { run_id: run.id, claimed_by: run.claimed_by });
      try {
        await finalizeRun(run, 'failed', 'Run exceeded lease and was not renewed — likely crashed.');
      } catch (err: any) {
        slog('worker', 'stuck_run_finalize_failed', { run_id: run.id, error: err.message });
      }
    }
  } catch (err: any) {
    slog('worker', 'stuck_run_detection_failed', { error: err.message });
  }
}

export async function processQueue() {
  if (isShuttingDown) return;
  
  try {
    await agentStore.recoverStaleClaims();
    const expiredApprovals = await agentStore.reapExpiredApprovals();
    await detectAndRecoverStuckRuns();

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
    
    while (inFlightRuns.size < MAX_CONCURRENT) {
      if (isShuttingDown) break;

      const workerId = `worker-${process.pid}-${crypto.randomUUID()}`;
      const run = await agentStore.claimNextQueuedRun(workerId, LEASE_SECONDS);
      
      if (!run) {
        break; // No more queued runs
      }

      inFlightRuns.add(run.id);
      
      // Fire and forget, but handle errors
      runLoop(run, workerId).catch(async (err) => {
        slog('worker', 'runLoop.error', { run_id: run.id, error: err.message });
        try {
          await finalizeRun(run, 'failed', err.message);
        } catch (finalizeErr: any) {
          slog('worker', 'finalizeRun.error', { run_id: run.id, error: finalizeErr.message });
        }
      }).finally(() => {
        inFlightRuns.delete(run.id);
      });
    }
  } catch (err: any) {
    slog('worker', 'processQueue.error', { error: err.message });
  }
}

export function startWorker() {
  if (workerInterval) return;
  slog('worker', 'started', { maxConcurrent: MAX_CONCURRENT });
  processQueue(); // initial run
  workerInterval = setInterval(processQueue, 2000); // Check every 2 seconds
}

export function stopWorker() {
  isShuttingDown = true;
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = undefined;
  }
  slog('worker', 'stopped', {});
}
