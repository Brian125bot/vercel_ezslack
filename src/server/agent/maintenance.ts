import { pollScheduledTriggers } from './scheduler.js';
import { agentStore } from '../storage/agentStore.js';
import { query } from '../storage/db.js';

export interface SystemMaintenanceResult {
  recovered: number;
  expiredApprovals: number;
}

/**
 * Idempotent maintenance cycle: stale claim recovery, approval expiry,
 * dedup cleanup, and scheduled trigger polling. Safe to run from daily
 * Vercel Cron and on every workflow bootstrap.
 */
export async function runSystemMaintenance(logPrefix = '[SystemMaintenance]'): Promise<SystemMaintenanceResult> {
  let recovered = 0;
  let expiredApprovals = 0;

  try {
    recovered = await agentStore.recoverStaleClaims();
    if (recovered > 0) {
      console.log(`${logPrefix} Recovered ${recovered} stale run(s)`);
    }
  } catch (err: any) {
    console.error(`${logPrefix} recoverStaleClaims error: ${err.message}`);
  }

  try {
    const expired = await agentStore.reapExpiredApprovals();
    expiredApprovals = expired.length;
    if (expiredApprovals > 0) {
      console.log(`${logPrefix} Expired ${expiredApprovals} stale approval(s)`);
    }
  } catch (err: any) {
    console.error(`${logPrefix} reapExpiredApprovals error: ${err.message}`);
  }

  try {
    await query(`DELETE FROM processed_events WHERE created_at < now() - interval '10 minutes'`);
  } catch { /* ignore */ }

  try {
    await pollScheduledTriggers();
  } catch (err: any) {
    console.error(`${logPrefix} pollScheduledTriggers error: ${err.message}`);
  }

  return { recovered, expiredApprovals };
}
