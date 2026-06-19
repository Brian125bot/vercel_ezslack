/**
 * Run Worker & Queue (W2-A).
 *
 * Decouples enqueue (handlers create a `queued` run and ACK immediately) from processing.
 * The worker polls for queued runs, claims them atomically (FOR UPDATE SKIP LOCKED), and runs
 * the closed loop in the background — so the Slack webhook never blocks on planning/execution.
 *
 * Also recovers stale claims (runs whose worker died mid-flight) on every tick (W2-F10) and
 * caps concurrency at maxConcurrent: 2 (a Weeks 1-2 non-goal to exceed).
 */
import crypto from 'crypto';
import { agentStore } from '../storage/agentStore.js';
import { runLoop } from './loop.js';
import { finalizeRun } from './finalize.js';
import { slog } from './log.js';
import type { AgentRun } from '../storage/types.js';

const MAX_CONCURRENT = 2;
const LEASE_SECONDS = 120;
const POLL_INTERVAL_MS = 2000;

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
let inFlight = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startWorker(): void {
  if (timer) return;
  slog('worker', 'start', { workerId, maxConcurrent: MAX_CONCURRENT, leaseSeconds: LEASE_SECONDS });
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for the poller.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (ticking) return; // serialize the recover+claim section; processing runs concurrently
  ticking = true;
  try {
    const recovered = await agentStore.recoverStaleClaims();
    if (recovered.length) slog('worker', 'recovered_stale', { count: recovered.length, runIds: recovered });

    while (inFlight < MAX_CONCURRENT) {
      const run = await agentStore.claimNextQueuedRun(workerId, LEASE_SECONDS);
      if (!run) break;
      inFlight++;
      slog('worker', 'claimed', { runId: run.id, inFlight });
      void processRun(run).finally(() => {
        inFlight--;
      });
    }
  } catch (err) {
    slog('worker', 'tick_error', { error: String(err) });
  } finally {
    ticking = false;
  }
}

async function processRun(run: AgentRun): Promise<void> {
  // Renew the lease periodically so a long-running loop isn't considered stale.
  const renew = setInterval(() => {
    agentStore.renewLease(run.id, LEASE_SECONDS).catch(() => {});
  }, (LEASE_SECONDS * 1000) / 2);
  if (typeof (renew as any).unref === 'function') (renew as any).unref();

  try {
    await runLoop(run);
  } catch (err) {
    slog('worker', 'run_error', { runId: run.id, error: String(err) });
    try {
      const goal = await agentStore.getGoal(run.goal_id);
      await finalizeRun({
        runId: run.id,
        goalId: run.goal_id,
        workspaceId: goal.workspace_id,
        state: 'failed',
        failureReason: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch (finErr) {
      slog('worker', 'finalize_error', { runId: run.id, error: String(finErr) });
    }
  } finally {
    clearInterval(renew);
  }
}

// Exposed for tests / manual triggering.
export const __worker = { tick, processRun, workerId };
