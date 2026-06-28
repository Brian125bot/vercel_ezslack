import { pollScheduledTriggers } from '../../src/server/agent/scheduler.js';

export default async function handler(req: any, res: any) {
  // Optional: check Authorization header if we only want Vercel Cron to hit this.
  // Vercel Cron sets the Authorization header to `Bearer ${process.env.CRON_SECRET}` 
  // if CRON_SECRET is configured in Vercel.
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
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
