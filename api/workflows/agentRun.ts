import { classifyIntent } from '../../src/server/agent/intent.js';
import { runSystemMaintenance } from '../../src/server/agent/maintenance.js';
import { runAgentPipeline } from '../../src/server/agent/orchestrator.js';
import { isDbAvailable } from '../../src/server/storage/db.js';
import { requireDurableDependencies, isDurableStateRequired, isRedisRequired } from '../../src/server/storage/readiness.js';
import { DurableStateError } from '../../src/server/storage/errors.js';
import { agentStore } from '../../src/server/storage/agentStore.js';
import { Semaphore, Permit } from '../../src/server/agent/semaphore.js';
import { createIntentHash, selectedModel, getSelectedModel, updateLog, setIntentDedup, markIntentComplete } from '../../src/server/state.js';
import { processSlackFiles } from '../../src/server/agent/attachments.js';
import { isRedisConfigured } from '../../src/server/redis.js';
import crypto from 'crypto';

const DIRECT_REPLY_CONCURRENCY = parseInt(process.env.DIRECT_REPLY_CONCURRENCY || '5');
const directReplySemaphore = new Semaphore(DIRECT_REPLY_CONCURRENCY);

function confidenceToNumber(c: string): number {
  if (c === 'high') return 1.0;
  if (c === 'medium') return 0.5;
  if (c === 'low') return 0.0;
  return 0.5;
}

// Vercel Workflows endpoint for agent execution
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const startTime = Date.now();

  try {
    await requireDurableDependencies();
  } catch (err: any) {
    const isDurable = err instanceof DurableStateError || err?.name === 'DurableStateError';
    console.error(`[Vercel Workflow] Durable dependency gate failed: ${err.message}`);
    return res.status(isDurable ? (err.status || 503) : 503).json({
      error: 'Service temporarily unavailable due to storage outage.'
    });
  }

  try {
    // Resolve the user's selected model from DB so cold starts use the correct model
    await getSelectedModel();

    // On-demand maintenance (stale claims, approvals, dedup, scheduled triggers)
    try {
      await runSystemMaintenance('[Vercel Workflow]');
    } catch { /* non-blocking */ }

    const body = req.body || {};
    const { event, eventId, signatureVerified, workspaceId, runId, logItemId } = body;

    // Handle deferred/subsequent runId triggers
    if (runId) {
      console.log(`[Vercel Workflow] Executing run ${runId}`);
      const workerId = `vercel-workflow-${crypto.randomUUID()}`;
      const LEASE_SECONDS = parseInt(process.env.WORKER_LEASE_SECONDS || '300');

      const claimedRun = await agentStore.claimQueuedRunById(runId, workerId, LEASE_SECONDS);
      if (!claimedRun) {
        return res.status(200).json({ message: 'Run not found or already claimed by another worker' });
      }

      const { runLoop } = await import('../../src/server/agent/loop.js');
      const { finalizeRun } = await import('../../src/server/agent/finalize.js');

      try {
        await runLoop(claimedRun, workerId);
      } catch (err: any) {
        console.error(`[Vercel Workflow] runLoop error: ${err.message}`);
        await finalizeRun(claimedRun, 'failed', err.message);
      }
      return res.status(200).json({ success: true });
    }

    // Otherwise, handle initial Slack event orchestration
    console.log(`[Vercel Workflow] Initiated background pipeline for ID: ${eventId}`);

    // Intent-based deduplication
    const shouldDedup = isRedisRequired() || isRedisConfigured();
    const intentHash = shouldDedup && event
      ? createIntentHash(event.text || '', event.channel || '', event.user || '', event.thread_ts || event.ts)
      : undefined;

    if (intentHash) {
      const setSuccess = await setIntentDedup(intentHash);
      if (!setSuccess) {
        console.log(`[Vercel Workflow] Skipping intent due to deduplication: ${intentHash.substring(0, 16)}...`);
        return res.status(200).json({ message: 'Similar intent already being processed, skipping duplicate execution' });
      }
    }

    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
      throw new Error('GEMINI_API_KEY is not configured or set to default example value.');
    }

    let promptText = (event?.text || "").substring(0, 50000);

    if (event?.type === 'app_mention') {
      promptText = promptText.replace(/^<@[A-Z0-9]+>\s*/, '');
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    const { attachments, skipped } = await processSlackFiles(event?.files, botToken);
    if (skipped.length > 0) {
      console.log(`[Vercel Workflow] Skipped ${skipped.length} attachment(s): ${skipped.map(s => `${s.filename} (${s.reason})`).join(', ')}`);
    }

    const threadTsTarget = event?.thread_ts || event?.ts;
    const dbAvailable = await isDbAvailable();
    if (!dbAvailable && isDurableStateRequired()) {
      throw new DurableStateError('Database unavailable during workflow execution', 'DATABASE_UNAVAILABLE', 'database', 503);
    }

    const hasPendingApproval = dbAvailable ? await agentStore.hasPendingApproval(workspaceId, event?.channel) : false;

    const intentResult = await classifyIntent(promptText, selectedModel, {
      context: {
        workspaceId,
        channelId: event?.channel,
        userId: event?.user,
        threadTs: threadTsTarget,
        hasPendingApproval
      }
    });
    
    const { intent, confidence, source } = intentResult;

    let permit: Permit | null = null;

    if (intent === 'direct_reply') {
      permit = await directReplySemaphore.acquirePermit(10_000);
      if (!permit.acquired) {
        console.warn(`[Vercel Workflow] Direct reply concurrency limit reached (${DIRECT_REPLY_CONCURRENCY}). Request rejected.`);
        if (logItemId) {
          await updateLog(logItemId, {
            status: 'error',
            intent,
            confidence: confidenceToNumber(confidence),
            source,
            processingTimeMs: Date.now() - startTime,
            error: 'Direct reply capacity exceeded (429)'
          });
        }
        if (intentHash) {
          try {
            await markIntentComplete(intentHash);
          } catch { /* ignore */ }
        }
        return res.status(429).json({ error: 'Direct reply capacity exceeded, please retry later' });
      }
    }
    
    let result;
    try {
      result = await runAgentPipeline({
        workspaceId,
        channelId: event?.channel,
        userId: event?.user,
        messageText: promptText,
        eventId: eventId,
        messageTs: event?.ts,
        threadTs: threadTsTarget,
        selectedModel,
        signatureValid: signatureVerified,
        sourceType: 'slack',
        dbAvailable,
        intentResult,
        attachments
      });
    } finally {
      if (permit && permit.acquired) {
        permit.release();
      }
    }

    if (logItemId) {
      const durationMs = Date.now() - startTime;
      await updateLog(logItemId, {
        status: result?.status === 'success' ? 'success' : 'error',
        intent: result?.intent || intent,
        confidence: confidenceToNumber(confidence),
        source,
        processingTimeMs: durationMs,
        runId: result?.runId,
        error: (!dbAvailable && result?.intent === 'durable_task') ? 'Database unavailable, skipped durable run' : result?.message
      });

      if (intentHash) {
        try {
          await markIntentComplete(intentHash);
        } catch (e) {
          console.warn(`[Vercel Workflow] Failed to clean up intent dedup for ${intentHash}:`, e);
        }
      }

      return res.status(200).json({ success: true, result });
    }
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

    if (error instanceof DurableStateError || error?.name === 'DurableStateError') {
      return res.status(error.status || 503).json({
        error: 'Service temporarily unavailable due to storage outage.'
      });
    }

    return res.status(500).json({ error: error.message });
  }
}
