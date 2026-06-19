import express from 'express';
import crypto from 'crypto';
import { requireDashboardAuth } from './auth.js';
import { logs, selectedModel, setSelectedModel, processedEventIds, processedMessageKeys, eventTimestamps, addLog, updateLog, threadMemory } from './state.js';
import { classifyIntent } from './ai.js';
import { GoogleGenAI } from '@google/genai';
import { SlackEventLog } from '../types.js';

export const router = express.Router();

router.get('/status', requireDashboardAuth, (req, res) => {
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
  res.json({
    geminiApiKeyConfigured: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    slackBotTokenConfigured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN !== 'MY_SLACK_BOT_TOKEN'),
    slackSigningSecretConfigured: !!(process.env.SLACK_SIGNING_SECRET && process.env.SLACK_SIGNING_SECRET !== 'MY_SIGNING_SECRET'),
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    dashboardPasswordRequired: !!DASHBOARD_PASSWORD,
    selectedModel,
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
  const allowed = ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  if (!allowed.includes(model)) {
    return res.status(400).json({ error: 'Unsupported or unreleased model selection ID.' });
  }
  setSelectedModel(model);
  console.log(`[Dashboard Admin] Switched active logic model to: ${selectedModel}`);
  res.json({ success: true, selectedModel });
});

router.get('/logs', requireDashboardAuth, (req, res) => {
  res.json({ logs });
});

router.post('/logs/clear', requireDashboardAuth, (req, res) => {
  logs.length = 0;
  res.json({ success: true });
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

router.post('/slack/events', (req: any, res: any) => {
  try {
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    const rawBody = req.rawBody || "";

    if (req.body && req.body.type === 'url_verification') {
      const challengeClient = req.body.challenge;
      console.log(`[Handshake] Received challenge token verification. Challenge: ${challengeClient}`);
      return res.status(200).json({ challenge: challengeClient });
    }

    const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
    let signatureVerified = false;
    let signatureError = '';

    if (signingSecret) {
      if (!signature || !timestamp) {
        signatureError = 'Missing signature headers';
      } else {
        const now = Math.floor(Date.now() / 1000);
        const reqTime = parseInt(timestamp as string, 10);
        if (isNaN(reqTime) || Math.abs(now - reqTime) > 300) {
          signatureError = `Replay attack warning: timestamp over 5 minutes old (${timestamp})`;
        } else {
          const baseString = `v0:${timestamp}:`;
          const hmac = crypto.createHmac('sha256', signingSecret);
          hmac.update(Buffer.from(baseString, 'utf8'));
          if (req.rawBody) {
             hmac.update(req.rawBody);
          }
          const calculatedSignature = 'v0=' + hmac.digest('hex');

          try {
            const signatureHash = crypto.createHash('sha256').update(signature as string, 'utf8').digest();
            const calculatedHash = crypto.createHash('sha256').update(calculatedSignature, 'utf8').digest();
            signatureVerified = crypto.timingSafeEqual(signatureHash, calculatedHash);
          } catch (err) {
            signatureVerified = false;
          }

          if (!signatureVerified) {
            signatureError = 'Cryptographic verification failed';
          }
        }
      }
      
      if (signatureError) {
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
    } else {
      console.warn(`[Signature Warning] SLACK_SIGNING_SECRET is not set. Skipping verify check for testing convenience.`);
    }

    const eventId = req.body.event_id;
    if (eventId) {
      if (processedEventIds.has(eventId)) {
        console.log(`[Deduplication] Dropping duplicate event: ${eventId}`);
        return res.status(200).send('OK (Duplicate event ignored)');
      }
      processedEventIds.add(eventId);
      eventTimestamps.set(eventId, Date.now());
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
      if (processedMessageKeys.has(msgKey)) {
        console.log(`[Deduplication] Dropping duplicate event message: ${msgKey}`);
        return res.status(200).send('OK (Duplicate event message ignored)');
      }
      processedMessageKeys.add(msgKey);
      eventTimestamps.set(msgKey, Date.now());
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
      signatureVerified: !!signingSecret && signatureVerified,
    };
    addLog(logItem);

    res.status(200).send('OK');

    setImmediate(async () => {
      const startTime = Date.now();
      try {
        console.log(`[Background Queue] Initiated background pipeline for ID: ${eventId}`);
        
        const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
        const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();

        if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
          throw new Error('GEMINI_API_KEY is not configured or set to default example value.');
        }

        const ai = new GoogleGenAI({
          apiKey: geminiApiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });

        const promptText = event.text || "";
        const threadTsTarget = event.thread_ts || event.ts;
        const threadKeyStr = threadTsTarget ? `chan-${event.channel}-thread-${threadTsTarget}` : `chan-${event.channel}-single`;

        console.log(`[Intent Analysis] Running dynamic classification for event text...`);
        const { intent, confidence } = await classifyIntent(promptText, selectedModel, ai);
        console.log(`[Intent Classification] Category: ${intent} | Confidence: ${confidence}`);

        const history = threadMemory.get(threadKeyStr) || [];
        console.log(`[Thread Memory] Resolved Key: ${threadKeyStr} | Pre-existing History turns: ${history.length}`);

        updateLog(logItem.id, {
          intent,
          confidence,
          threadKey: threadKeyStr,
          threadHistoryCount: history.length
        });

        const contents: any[] = [];
        for (const msg of history) {
          contents.push({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [{ text: msg.text }]
          });
        }
        contents.push({
          role: 'user',
          parts: [{ text: promptText }]
        });

        const systemInstruction = 
          "You are a helpful, context-aware, and precise Slack AI Agent backend. " +
          "You hold conversation thread memory to maintain context in nested messaging dialogues. " +
          "Your responses must be highly actionable, readable, and written in standard Slack-compatible markdown:\n" +
          "- Use *text* for bold (do NOT use standard markdown **text**)\n" +
          "- Use _text_ for italics (do NOT use standard markdown *text* or _text_)\n" +
          "- Use ~text~ for strikethrough\n" +
          "- Use `code` for inline code\n" +
          "- Use ``` with language label for multiline block code\n" +
          "- Rely on clear spacing and formatting. Answer the user prompt directly without meta-commentary.";

        console.log(`[Background Gemini] Prompting ${selectedModel} with conversation history count: ${contents.length}`);
        const aiResponse = await ai.models.generateContent({
          model: selectedModel,
          contents: contents,
          config: {
            systemInstruction: systemInstruction,
            tools: [{ googleSearch: {} }],
          }
        });

        const generatedText = aiResponse.text || "(Empty response returned)";
        console.log(`[Background Gemini] Succeeded: ${generatedText.substring(0, 50)}...`);

        const durationMs = Date.now() - startTime;

        const updatedHistory = [...history];
        updatedHistory.push({ role: 'user', text: promptText });
        updatedHistory.push({ role: 'model', text: generatedText });
        if (updatedHistory.length > 20) {
          threadMemory.set(threadKeyStr, updatedHistory.slice(-20));
        } else {
          threadMemory.set(threadKeyStr, updatedHistory);
        }

        const isMockToken = !slackBotToken || slackBotToken === 'MY_SLACK_BOT_TOKEN' || slackBotToken.startsWith('mock') || !slackBotToken.startsWith('xox');
        
        if (isMockToken) {
          console.log(`[Slack Simulated API] Saved simulated thread post to channel: ${event.channel}`);
          updateLog(logItem.id, {
            status: 'success',
            aiResponse: `${generatedText}\n\n_(Simulated Dispatch: SLACK_BOT_TOKEN is not configured or is mock)_`,
            processingTimeMs: durationMs
          });
        } else {
          const slackPayload = {
            channel: event.channel,
            text: generatedText,
            thread_ts: threadTsTarget
          };

          console.log(`[Slack API Dispatch] Posting to channel ${event.channel} inside thread ${threadTsTarget}`);
          
          const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Authorization': `Bearer ${slackBotToken}`
            },
            body: JSON.stringify(slackPayload)
          });

          const slackData: any = await slackRes.json();
          if (!slackRes.ok || !slackData.ok) {
            throw new Error(`Slack postMessage failed: ${slackData.error || JSON.stringify(slackData)}`);
          }

          console.log(`[Slack API Dispatch] Succeeded routing message to thread ${threadTsTarget}`);
          updateLog(logItem.id, {
            status: 'success',
            aiResponse: generatedText,
            processingTimeMs: durationMs
          });
        }

      } catch (bkErr: any) {
        console.error(`[Background Task Misfire] `, bkErr);
        const durationMs = Date.now() - startTime;
        updateLog(logItem.id, {
          status: 'error',
          error: bkErr.message || String(bkErr),
          processingTimeMs: durationMs
        });
      }
    });

  } catch (syncErr: any) {
    console.error(`[Synchronous Processing Crash] `, syncErr);
    res.status(400).send(`Exception caught: ${syncErr.message || String(syncErr)}`);
  }
});
