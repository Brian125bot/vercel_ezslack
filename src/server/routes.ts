import express from 'express';
import crypto from 'crypto';
import { requireDashboardAuth } from './auth.js';
import { selectedModel, setSelectedModel, addLog, updateLog, getLogs, clearLogs, getSelectedModel, isEventDuplicate, isMessageDuplicate } from './state.js';
import { classifyIntent } from './agent/intent.js';

import { SlackEventLog } from '../types.js';
import { agentStore } from './storage/agentStore.js';
import { isDbAvailable } from './storage/db.js';
import { runAgentPipeline } from './agent/orchestrator.js';
import { Semaphore } from './agent/semaphore.js';
import { ALLOWED_MODELS } from './agent/models.js';

const DIRECT_REPLY_CONCURRENCY = parseInt(process.env.DIRECT_REPLY_CONCURRENCY || '5');
const directReplySemaphore = new Semaphore(DIRECT_REPLY_CONCURRENCY);

export const router = express.Router();

/**
 * Verify a Slack request signature (HMAC-SHA256).
 * Returns { valid: true } or { valid: false, error: string }.
 * Used by both /slack/events and /slack/interactivity.
 */
function verifySlackSignature(req: any): { valid: boolean; error?: string } {
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    if (process.env.NODE_ENV === 'production') {
      return { valid: false, error: 'SLACK_SIGNING_SECRET not configured (required in production)' };
    }
    console.warn('[Signature Warning] SLACK_SIGNING_SECRET not set. Skipping verification (dev mode only).');
    return { valid: true };
  }

  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

  if (!signature || !timestamp) {
    return { valid: false, error: 'Missing signature headers' };
  }

  const now = Math.floor(Date.now() / 1000);
  const reqTime = parseInt(timestamp, 10);
  if (isNaN(reqTime) || Math.abs(now - reqTime) > 300) {
    return { valid: false, error: `Replay attack: timestamp ${timestamp} is stale` };
  }

  const baseString = `v0:${timestamp}:`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(Buffer.from(baseString, 'utf8'));
  if (req.rawBody) {
    hmac.update(req.rawBody);
  }
  const calculatedSignature = 'v0=' + hmac.digest('hex');

  try {
    const sigHash = crypto.createHash('sha256').update(signature, 'utf8').digest();
    const calcHash = crypto.createHash('sha256').update(calculatedSignature, 'utf8').digest();
    if (!crypto.timingSafeEqual(sigHash, calcHash)) {
      return { valid: false, error: 'Cryptographic verification failed' };
    }
  } catch {
    return { valid: false, error: 'Cryptographic verification failed' };
  }

  return { valid: true };
}

router.get('/status', requireDashboardAuth, async (req, res) => {
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
  const dbConfigured = !!(process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME || process.env.SQL_HOST);
  const dbAvailable = dbConfigured ? await isDbAvailable() : false;
  const currentModel = await getSelectedModel();

  res.json({
    geminiApiKeyConfigured: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    slackBotTokenConfigured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN !== 'MY_SLACK_BOT_TOKEN'),
    slackSigningSecretConfigured: !!(process.env.SLACK_SIGNING_SECRET && process.env.SLACK_SIGNING_SECRET !== 'MY_SIGNING_SECRET'),
    databaseConfigured: dbConfigured,
    databaseAvailable: dbAvailable,
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    dashboardPasswordRequired: !!DASHBOARD_PASSWORD,
    selectedModel: currentModel,
    availableModels: [
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', description: 'Default. Extra fast, low latency, perfect for messaging workflows.' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'Ultimate intelligence/speed ratio. Incredible logic capabilities.' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Stable and responsive general-purpose logic automations.' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Next-gen experimental agentic and search capabilities.' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', description: 'Legacy 2M token context model with robust consistency.' }
    ]
  });
});

router.post('/model/select', requireDashboardAuth, (req, res) => {
  const { model } = req.body;
  const allowed = ALLOWED_MODELS as readonly string[];
  if (!allowed.includes(model)) {
    return res.status(400).json({ error: 'Unsupported or unreleased model selection ID.' });
  }
  setSelectedModel(model);
  console.log(`[Dashboard Admin] Switched active logic model to: ${selectedModel}`);
  res.json({ success: true, selectedModel });
});

router.get('/logs', requireDashboardAuth, async (req, res) => {
  const logData = await getLogs();
  res.json({ logs: logData });
});

router.post('/logs/clear', requireDashboardAuth, async (req, res) => {
  await clearLogs();
  res.json({ success: true });
});

router.get('/agent/runs', requireDashboardAuth, async (req, res) => {
  try {
    const runs = await agentStore.listRuns({
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      status: req.query.status as string | undefined
    });
    res.json(runs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent/runs/:id', requireDashboardAuth, async (req, res) => {
  try {
    const trace = await agentStore.getRunTrace(req.params.id);
    res.json(trace);
  } catch (error: any) {
    if (error.message.includes('not found')) return res.status(404).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent/goals/:id', requireDashboardAuth, async (req, res) => {
  try {
    const goal = await agentStore.getGoal(req.params.id);
    res.json(goal);
  } catch (error: any) {
    if (error.message.includes('not found')) return res.status(404).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent/memory', requireDashboardAuth, async (req, res) => {
  try {
    if (!req.query.workspace_id) {
       return res.status(400).json({ error: 'workspace_id query parameteter is required' });
    }
    const mem = await agentStore.searchMemory({
      workspace_id: req.query.workspace_id as string,
      limit: Number(req.query.limit) || 50
    });
    res.json(mem);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent/audit', requireDashboardAuth, async (req, res) => {
  try {
    if (!req.query.runId) {
       return res.status(400).json({ error: 'runId query parameter is required' });
    }
    const auditEvents = await agentStore.listAuditEvents(req.query.runId as string);
    res.json(auditEvents);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/agent/approvals/:id/resolve', requireDashboardAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }
    const approval = await agentStore.resolveApproval(req.params.id, status);
    
    // Create an audit event
    const trace = await agentStore.getRunTrace(approval.run_id!);
    await agentStore.appendAuditEvent({
      workspace_id: trace.goal.workspace_id,
      goal_id: approval.goal_id!,
      run_id: approval.run_id!,
      type: 'approval.resolved',
      actor: 'user',
      summary: `User resolved approval request with status: ${status}`,
      payload: { approvalId: approval.id, status, title: approval.title }
    });
    
    // Background execution based on approval outcome
    if (status === 'approved') {
      import('./agent/orchestrator.js').then(({ resumeAgentPipeline }) => {
        resumeAgentPipeline(approval.run_id!).catch((e) => console.error("Failed to resume pipeline", e));
      });
    } else {
      await agentStore.updateRunStatus(approval.run_id!, 'cancelled', { failure_reason: 'User rejected the plan.' });
      await agentStore.updateGoalStatus(approval.goal_id!, 'cancelled');
      await agentStore.appendAuditEvent({
        workspace_id: trace.goal.workspace_id,
        goal_id: approval.goal_id!,
        run_id: approval.run_id!,
        type: 'run.cancelled',
        actor: 'system',
        summary: 'Run cancelled due to approval rejection',
        payload: {}
      });
    }

    res.json({ success: true, approval });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/slack/test', requireDashboardAuth, async (req: any, res: any) => {
  try {
    const { text, channel, user, generateInvalidSignature, timestampOffsetSeconds } = req.body;
    
    const eventId = `ev-sim-${Math.random().toString(36).substring(2, 9)}`;
    const timestampVal = Math.floor(Date.now() / 1000 + (timestampOffsetSeconds || 0));
    
    const payload = {
      token: "test-token-handshake",
      team_id: "T_SIMULATOR",
      api_app_id: "A_SIMULATOR",
      event: {
        type: "message",
        channel: channel || "C_SIMULATED_CHANNEL",
        user: user || "U_SIMULATED_USER",
        text: text || "Hello Slack Agent! What is the capital of Japan?",
        ts: `${timestampVal}.000001`,
        event_ts: `${timestampVal}.000001`
      },
      type: "event_callback",
      event_id: eventId,
      event_time: timestampVal
    };

    const payloadStr = JSON.stringify(payload);
    const signingSecret = process.env.SLACK_SIGNING_SECRET || "test-signing-secret-placeholder";
    
    let signature = "v0=invalid-format-for-testing";
    if (!generateInvalidSignature) {
      const baseString = `v0:${timestampVal}:${payloadStr}`;
      const hmac = crypto.createHmac('sha256', signingSecret);
      hmac.update(baseString);
      signature = 'v0=' + hmac.digest('hex');
    }

    const headers: any = {
      'Content-Type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestampVal.toString()
    };

    const localUrl = `http://127.0.0.1:3000/api/slack/events`;
    
    console.log(`[Simulator] Sending test webhook event to ${localUrl}...`);
    const simResponse = await fetch(localUrl, {
      method: "POST",
      headers: headers,
      body: payloadStr
    });

    const status = simResponse.status;
    const bodyText = await simResponse.text();

    res.json({
      success: status === 200,
      statusCode: status,
      responseBody: bodyText,
      simulatedEventId: eventId,
      timestamp: timestampVal.toString(),
      signature: signature
    });
  } catch (error: any) {
    console.error(`[Simulator Error]`, error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

// ── W4-D: Health check endpoint (no auth) ──
router.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ── W3-C: Slack interactivity endpoint (Block Kit button callbacks) ──
router.post('/slack/interactivity', async (req: any, res: any) => {
  try {
    // W3-F7: Verify Slack signature before processing interactivity payloads
    const sigResult = verifySlackSignature(req);
    if (!sigResult.valid) {
      console.log(`[Interactivity Signature Error] ${sigResult.error}`);
      return res.status(401).send(`Unauthorized: ${sigResult.error}`);
    }

    // Slack sends the payload as a URL-encoded `payload` field
    const rawPayload = req.body?.payload || req.body;
    const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    
    if (!payload || !payload.actions || payload.actions.length === 0) {
      return res.status(200).send('OK');
    }

    // ACK immediately
    res.status(200).send('');

    const action = payload.actions[0];
    const actionId: string = action.action_id || '';
    const approvalId: string = action.value || '';
    const userId: string = payload.user?.id || '';
    const channelId: string = payload.channel?.id || '';

    if (!approvalId || (!actionId.startsWith('approval_approve') && !actionId.startsWith('approval_reject'))) {
      return;
    }

    const newStatus: 'approved' | 'rejected' = actionId.includes('approve') ? 'approved' : 'rejected';

    const approval = await agentStore.resolveApproval(approvalId, newStatus);

    // Update the original Block Kit message to remove buttons
    const { updateApprovalMessage } = await import('./tools/slack.js');
    await updateApprovalMessage(approval, newStatus, channelId);

    // Create audit event
    if (approval.run_id) {
      const trace = await agentStore.getRunTrace(approval.run_id);
      await agentStore.appendAuditEvent({
        workspace_id: trace.goal.workspace_id,
        goal_id: approval.goal_id!,
        run_id: approval.run_id,
        type: `approval.${newStatus}`,
        actor: userId,
        summary: `User ${newStatus} execution via Block Kit button`,
        payload: { approvalId: approval.id }
      });
    }

    // Resume or cancel based on outcome
    if (newStatus === 'approved' && approval.run_id) {
      const { resumeAgentPipeline } = await import('./agent/orchestrator.js');
      resumeAgentPipeline(approval.run_id).catch(e => console.error('Failed to resume pipeline', e));
    } else if (newStatus === 'rejected' && approval.run_id) {
      await agentStore.updateRunStatus(approval.run_id, 'cancelled', { failure_reason: 'User rejected via Slack button.' });
      if (approval.goal_id) {
        await agentStore.updateGoalStatus(approval.goal_id, 'cancelled');
      }
    }
  } catch (err: any) {
    console.error('[Interactivity Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.post('/slack/events', async (req: any, res: any) => {
  try {
    if (req.body && req.body.type === 'url_verification') {
      const challengeClient = req.body.challenge;
      console.log(`[Handshake] Received challenge token verification. Challenge: ${challengeClient}`);
      return res.status(200).json({ challenge: challengeClient });
    }

    // Verify Slack signature using the shared helper
    const sigResult = verifySlackSignature(req);
    const signatureVerified = sigResult.valid;

    if (!signatureVerified) {
      const signatureError = sigResult.error || 'Unknown verification failure';
      console.log(`[Signature Error] ${signatureError}`);
      const logItem: SlackEventLog = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toISOString(),
        eventId: req.body?.event_id || 'unknown-id',
        eventType: req.body?.event?.type || 'unknown-type',
        channel: req.body?.event?.channel || 'unknown',
        user: req.body?.event?.user || 'unknown',
        text: req.body?.event?.text || '',
        status: 'error',
        signatureVerified: false,
        error: `Unauthorized: ${signatureError}`
      };
      addLog(logItem);
      return res.status(401).send(`Unauthorized: ${signatureError}`);
    }

    const eventId = req.body.event_id;
    if (eventId) {
      const isDup = await isEventDuplicate(eventId);
      if (isDup) {
        console.log(`[Deduplication] Dropping duplicate event: ${eventId}`);
        return res.status(200).send('OK (Duplicate event ignored)');
      }
    }

    const { event } = req.body;
    if (!event) {
      return res.status(400).send('Bad Request: Missing event container');
    }

    if (event.bot_id || event.user === undefined) {
      console.log(`[Loop Prevention] Ignoring bot-originated message (bot_id: ${event.bot_id || 'unspecified'})`);
      return res.status(200).send('OK (Self-event and bot-events skipped)');
    }

    // Message-level deduplication: Slack can fire both `app_mention` and `message.channels` for the same user message.
    // They have different event_id values but identical event.client_msg_id and/or event.channel + event.ts
    const msgKey = event.client_msg_id ? `msgid-${event.client_msg_id}` : (event.channel && event.ts ? `msgts-${event.channel}-${event.ts}` : null);
    if (msgKey) {
      const isMsgDup = await isMessageDuplicate(msgKey);
      if (isMsgDup) {
        console.log(`[Deduplication] Dropping duplicate event message: ${msgKey}`);
        return res.status(200).send('OK (Duplicate event message ignored)');
      }
    }

    const logItem: SlackEventLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      eventId: eventId || 'test-event-id',
      eventType: event.type || 'message',
      channel: event.channel || 'unknown',
      user: event.user || 'unknown',
      text: event.text || '',
      status: 'processing',
      signatureVerified: signatureVerified,
    };
    addLog(logItem);

    res.status(200).send('OK');

    // Instead of setImmediate (which freezes on Vercel Serverless), we trigger the Workflow.
    // In a real Vercel Workflow setup, this might use a specific SDK client.
    // For now, we'll asynchronously invoke our own workflow endpoint.
    const runPayload = {
      event,
      eventId,
      signatureVerified,
      workspaceId: req.body?.team_id || 'T_UNKNOWN',
      logItemId: logItem.id,
    };

    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = process.env.VERCEL_URL || process.env.APP_URL?.replace(/^https?:\/\//, '') || req.get('host');
    const workflowUrl = `${protocol}://${host}/api/workflows/agentRun`;

    console.log(`[Slack Event] Triggering Vercel Workflow at ${workflowUrl}`);
    
    // We use a fire-and-forget fetch to the workflow endpoint.
    // Note: On Vercel, this may require integration with Upstash QStash or Vercel Workflows SDK
    // to guarantee execution beyond the request lifecycle.
    fetch(workflowUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runPayload)
    }).catch(err => console.error('Failed to trigger workflow:', err));

  } catch (syncErr: any) {
    console.error(`[Synchronous Processing Crash] `, syncErr);
    res.status(400).send(`Exception caught: ${syncErr.message || String(syncErr)}`);
  }
});

// ── W3-D: Cloud Tasks internal endpoints ──
function requireInternalAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return res.status(500).json({ error: 'INTERNAL_API_SECRET is not configured' });
  
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized internal request' });
  }
  next();
}

router.post('/internal/worker/execute', requireInternalAuth, async (req, res) => {
  const { runId } = req.body;
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  console.log(`[Cloud Tasks Worker] Executing run ${runId}`);
  try {
    const run = await agentStore.getRun(runId);
    if (!run || run.status !== 'queued') {
      return res.status(200).json({ message: 'Run not found or already processing/finished' });
    }
    
    // We do NOT claimNextQueuedRun here because the queue manages concurrency
    // Just run it. We might still want to mark it running.
    const { runLoop } = await import('./agent/loop.js');
    const { finalizeRun } = await import('./agent/finalize.js');
    
    // Attempt to mark it as running via a worker ID so we know it's being worked on
    const workerId = `cloudtasks-${crypto.randomUUID()}`;
    await agentStore.updateRunStatus(runId, 'running', { claimed_by: workerId, claimed_at: new Date() });

    try {
      await runLoop(run, workerId);
    } catch (err: any) {
      console.error(`[Cloud Tasks Worker] runLoop error: ${err.message}`);
      await finalizeRun(run, 'failed', err.message);
    }

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error(`[Cloud Tasks Worker] execution error: ${error.message}`);
    // Return 500 so Cloud Tasks retries
    res.status(500).json({ error: error.message });
  }
});

router.post('/internal/scheduler/poll', requireInternalAuth, async (req, res) => {
  console.log(`[Cloud Tasks Scheduler] Polling for due triggers`);
  try {
    const { pollScheduledTriggers } = await import('./agent/scheduler.js');
    await pollScheduledTriggers();
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error(`[Cloud Tasks Scheduler] poll error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});
