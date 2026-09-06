import { runSystemMaintenance } from '../../src/server/agent/maintenance.js';
import { requireDurableDependencies } from '../../src/server/storage/readiness.js';
import { DurableStateError } from '../../src/server/storage/errors.js';

function isCronAuthorized(authHeader: string | undefined): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (process.env.VERCEL === '1') {
    return !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  }

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return false;
  }

  return true;
}

export default async function handler(req: any, res: any) {
  const authHeader = req.headers.authorization;

  if (!isCronAuthorized(authHeader)) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }

  try {
    await requireDurableDependencies();
  } catch (err: any) {
    const isDurable = err instanceof DurableStateError || err.name === 'DurableStateError';
    return res.status(503).json({
      error: 'Service temporarily unavailable due to storage outage.'
    });
  }

  console.log('[Vercel Cron] Starting maintenance cycle...');

  try {
    await runSystemMaintenance('[Vercel Cron]');
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error(`[Vercel Cron] maintenance error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
