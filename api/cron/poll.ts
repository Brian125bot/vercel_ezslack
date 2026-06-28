import { pollScheduledTriggers } from '../../src/server/agent/scheduler.js';
import { agentStore } from '../../src/server/storage/agentStore.js';

export default async function handler(req: any, res: any) {
  // Optional: check Authorization header if we only want Vercel Cron to hit this.
  // Vercel Cron sets the Authorization header to `Bearer ${process.env.CRON_SECRET}` 
  // if CRON_SECRET is configured in Vercel.
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }

  console.log(`[Vercel Cron] Starting maintenance cycle...`);

  // Reclaim stale run claims before polling triggers
  try {
    const recovered = await agentStore.recoverStaleClaims();
    if (recovered > 0) {
      console.log(`[Vercel Cron] Recovered ${recovered} stale run(s)`);
    }
  } catch (err: any) {
    console.error(`[Vercel Cron] recoverStaleClaims error: ${err.message}`);
  }

  // Expire stale pending approvals
  try {
    const expired = await agentStore.reapExpiredApprovals();
    if (expired.length > 0) {
      console.log(`[Vercel Cron] Expired ${expired.length} stale approval(s)`);
    }
  } catch (err: any) {
    console.error(`[Vercel Cron] reapExpiredApprovals error: ${err.message}`);
  }

  console.log(`[Vercel Cron] Polling for due triggers...`);
  try {
    await pollScheduledTriggers();
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error(`[Vercel Cron] poll error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
