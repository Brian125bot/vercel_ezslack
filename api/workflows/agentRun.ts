
import { classifyIntent } from '../../src/server/agent/intent.js';
import { runAgentPipeline } from '../../src/server/agent/orchestrator.js';
import { isDbAvailable } from '../../src/server/storage/db.js';
import { agentStore } from '../../src/server/storage/agentStore.js';
import { Semaphore } from '../../src/server/agent/semaphore.js';
import { selectedModel, getSelectedModel, updateLog } from '../../src/server/state.js';

const DIRECT_REPLY_CONCURRENCY = parseInt(process.env.DIRECT_REPLY_CONCURRENCY || '5');
const directReplySemaphore = new Semaphore(DIRECT_REPLY_CONCURRENCY);

// Vercel Workflows endpoint for agent execution
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const startTime = Date.now();
  // Resolve the user's selected model from DB so cold starts use the correct model
  await getSelectedModel();
  // On-demand stale claim recovery (catches runs abandoned by terminated invocations)
  try {
    const recovered = await agentStore.recoverStaleClaims();
    if (recovered > 0) {
      console.log(`[Vercel Workflow] Recovered ${recovered} stale run(s) on startup`);
    }
  } catch { /* non-blocking */ }
  try {
    const body = req.body || {};
    const { event, eventId, signatureVerified, workspaceId, runId, logItemId } = body;

    // Handle deferred/subsequent runId triggers
    if (runId) {
      console.log(`[Vercel Workflow] Executing run ${runId}`);
      const run = await agentStore.getRun(runId);
      if (!run || run.status !== 'queued') {
        return res.status(200).json({ message: 'Run not found or already processing/finished' });
      }
      
      const { runLoop } = await import('../../src/server/agent/loop.js');
      const { finalizeRun } = await import('../../src/server/agent/finalize.js');
      const crypto = await import('crypto');
      const workerId = `vercel-workflow-${crypto.randomUUID()}`;
      await agentStore.updateRunStatus(runId, 'running', { claimed_by: workerId, claimed_at: new Date() });

      try {
        await runLoop(run, workerId);
      } catch (err: any) {
        console.error(`[Vercel Workflow] runLoop error: ${err.message}`);
        await finalizeRun(run, 'failed', err.message);
      }
      return res.status(200).json({ success: true });
    }

    // Otherwise, handle initial Slack event orchestration
    console.log(`[Vercel Workflow] Initiated background pipeline for ID: ${eventId}`);
    
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
      throw new Error('GEMINI_API_KEY is not configured or set to default example value.');
    }

    const promptText = (event.text || "").substring(0, 50000); 
    const threadTsTarget = event.thread_ts || event.ts;
    const dbAvailable = (process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME || process.env.SQL_HOST) ? await isDbAvailable() : false;

    const hasPendingApproval = dbAvailable ? await agentStore.hasPendingApproval(workspaceId, event.channel) : false;

    const intentResult = await classifyIntent(promptText, selectedModel, {
      context: {
        workspaceId,
        channelId: event.channel,
        userId: event.user,
        threadTs: threadTsTarget,
        hasPendingApproval
      }
    });
    
    const { intent, confidence, source } = intentResult;

    if (intent === 'direct_reply') {
      await directReplySemaphore.acquire();
    }
    
    let result;
    try {
      result = await runAgentPipeline({
        workspaceId,
        channelId: event.channel,
        userId: event.user,
        messageText: promptText,
        eventId: eventId,
        messageTs: event.ts,
        threadTs: threadTsTarget,
        selectedModel,
        signatureValid: signatureVerified,
        sourceType: 'slack',
        dbAvailable,
        intentResult
      });
    } finally {
      if (intent === 'direct_reply') {
        directReplySemaphore.release();
      }
    }

    if (logItemId) {
      const durationMs = Date.now() - startTime;
      await updateLog(logItemId, {
        status: result?.status === 'success' ? 'success' : 'error',
        intent: result?.intent || intent,
        confidence,
        source,
        processingTimeMs: durationMs,
        runId: result?.runId,
        error: (!dbAvailable && result?.intent === 'durable_task') ? 'Database unavailable, skipped durable run' : result?.message
      });
    }

    return res.status(200).json({ success: true, result });
  } catch (error: any) {
    console.error(`[Vercel Workflow] execution error: ${error.message}`);
    const errLogId = req.body?.logItemId;
    
    if (errLogId) {
      updateLog(errLogId, {
        status: 'error',
        error: error.message || String(error),
        processingTimeMs: Date.now() - startTime
      });
    }
    return res.status(500).json({ error: error.message });
  }
}
