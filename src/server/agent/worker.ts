import { agentStore } from '../storage/agentStore.js';
import { runLoop } from './loop.js';
import { slog } from './log.js';
import { finalizeRun } from './finalize.js';

let workerInterval: any;
let isShuttingDown = false;
const inFlightRuns = new Set<string>();
const MAX_CONCURRENT = 2;
const LEASE_SECONDS = 300; // 5 minutes

export async function processQueue() {
  if (isShuttingDown) return;
  
  try {
    await agentStore.recoverStaleClaims();
    await agentStore.reapExpiredApprovals();
    
    while (inFlightRuns.size < MAX_CONCURRENT) {
      if (isShuttingDown) break;

      const workerId = `worker-${process.pid}-${crypto.randomUUID()}`;
      const run = await agentStore.claimNextQueuedRun(workerId, LEASE_SECONDS);
      
      if (!run) {
        break; // No more queued runs
      }

      inFlightRuns.add(run.id);
      
      // Fire and forget, but handle errors
      runLoop(run).catch(async (err) => {
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
