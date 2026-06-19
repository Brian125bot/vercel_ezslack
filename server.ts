import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Preserve raw buffer body for Slack signature verify using custom JSON parser verify hook
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

// Setup type for logs
interface SlackEventLog {
  id: string;
  timestamp: string;
  eventId: string;
  eventType: string;
  channel: string;
  user: string;
  text: string;
  status: 'ignored_bot' | 'ignored_duplicate' | 'error' | 'success' | 'processing';
  signatureVerified: boolean;
  aiResponse?: string;
  error?: string;
}

// In-memory rolling logs buffer
const logs: SlackEventLog[] = [];
const maxLogs = 50;

function addLog(item: SlackEventLog) {
  logs.unshift(item); // Latest first
  if (logs.length > maxLogs) {
    logs.pop();
  }
}

function updateLog(id: string, updates: Partial<SlackEventLog>) {
  const index = logs.findIndex(log => log.id === id);
  if (index !== -1) {
    logs[index] = { ...logs[index], ...updates };
  }
}

// Event deduplication storage
const processedEventIds = new Set<string>();
const eventTimestamps = new Map<string, number>();

// Clean up events older than 10 minutes every minute
setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of eventTimestamps.entries()) {
    if (now - timestamp > 600 * 1000) {
      processedEventIds.delete(eventId);
      eventTimestamps.delete(eventId);
    }
  }
}, 60 * 1000);

// Authentication middleware for administrative views (Option A: Password protection)
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();

const requireDashboardAuth = (req: any, res: any, next: any) => {
  if (!DASHBOARD_PASSWORD) {
    // If DASHBOARD_PASSWORD is not set in env, allow open access
    return next();
  }
  
  const authHeader = req.headers['authorization'];
  let receivedPassword = '';
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    receivedPassword = authHeader.substring(7).trim();
  } else {
    const headerPass = req.headers['x-dashboard-password'];
    if (headerPass) {
       receivedPassword = (Array.isArray(headerPass) ? headerPass[0] : headerPass).trim();
    }
  }

  if (receivedPassword === DASHBOARD_PASSWORD) {
    return next();
  }

  return res.status(401).json({ 
    error: 'Unauthorized',
    dashboardPasswordRequired: true
  });
};

// API Status endpoint
app.get('/api/status', requireDashboardAuth, (req, res) => {
  res.json({
    geminiApiKeyConfigured: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    slackBotTokenConfigured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN !== 'MY_SLACK_BOT_TOKEN'),
    slackSigningSecretConfigured: !!(process.env.SLACK_SIGNING_SECRET && process.env.SLACK_SIGNING_SECRET !== 'MY_SIGNING_SECRET'),
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    dashboardPasswordRequired: !!DASHBOARD_PASSWORD
  });
});

// Retrieve latest logs
app.get('/api/logs', requireDashboardAuth, (req, res) => {
  res.json({ logs });
});

// Clear logs
app.post('/api/logs/clear', requireDashboardAuth, (req, res) => {
  logs.length = 0;
  res.json({ success: true });
});

// Webhook simulation handler
app.post('/api/slack/test', requireDashboardAuth, async (req: any, res: any) => {
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
    
    // Generate signature header values
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

    // Forward Post internally
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

// Precise Slack Webhook Events endpoint
app.post('/api/slack/events', (req: any, res: any) => {
  try {
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    const rawBody = req.rawBody || "";

    // 1. URL Verification handshake
    if (req.body && req.body.type === 'url_verification') {
      const challengeClient = req.body.challenge;
      console.log(`[Handshake] Received challenge token verification. Challenge: ${challengeClient}`);
      return res.status(200).json({ challenge: challengeClient });
    }

    // 2. Cryptographic signature check
    const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
    let signatureVerified = false;
    let signatureError = '';

    if (signingSecret) {
      if (!signature || !timestamp) {
        signatureError = 'Missing signature headers';
      } else {
        // Replay attack prevention: reject if over 5 minutes old
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
            signatureVerified = crypto.timingSafeEqual(
              Buffer.from(signature as string, 'utf8'),
              Buffer.from(calculatedSignature, 'utf8')
            );
          } catch (err) {
            signatureVerified = false;
          }

          if (!signatureVerified) {
            signatureError = `Cryptographic verification failed! Target: ${calculatedSignature}, Header: ${signature}`;
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

    // 3. Event Loop & Deduplication check
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

    // Ensure bot ignores itself or undefined user event senders to prevent infinite loops
    if (event.bot_id || event.user === undefined) {
      console.log(`[Loop Prevention] Ignoring bot-originated message (bot_id: ${event.bot_id || 'unspecified'})`);
      return res.status(200).send('OK (Self-event and bot-events skipped)');
    }

    // Record initial log
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

    // 4. Respond 200 OK within 3 seconds parameter
    res.status(200).send('OK');

    // 5. Asynchronous Background task processing using setImmediate
    setImmediate(async () => {
      try {
        console.log(`[Background Queue] Initiated background pipeline for ID: ${eventId}`);
        
        const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
        const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();

        if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
          throw new Error('GEMINI_API_KEY is not configured or set to default example value.');
        }

        // Initialize Gemini SDK with custom agent telemetry
        const ai = new GoogleGenAI({
          apiKey: geminiApiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });

        const promptText = event.text;
        const systemInstruction = 
          "You are a helpful and precise Slack AI Agent backend. " +
          "Your responses must be highly actionable, readable, and written in standard Slack-compatible markdown:\n" +
          "- Use *text* for bold (do NOT use standard markdown **text**)\n" +
          "- Use _text_ for italics (do NOT use standard markdown *text* or _text_)\n" +
          "- Use ~text~ for strikethrough\n" +
          "- Use `code` for inline code\n" +
          "- Use ``` with language label for multiline block code\n" +
          "- Rely on clear spacing and formatting. Answer the user prompt directly without meta-commentary.";

        console.log(`[Background Gemini] Prompting gemini-3.5-flash with message text length: ${promptText ? promptText.length : 0}`);
        const aiResponse = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: promptText || "Hello! Who are you?",
          config: {
            systemInstruction: systemInstruction,
          }
        });

        const generatedText = aiResponse.text || "(Empty response returned)";
        console.log(`[Background Gemini] Succeeded: ${generatedText.substring(0, 50)}...`);

        // Check if Slack Bot Token is configured (if not, we simulate success for convenient preview testing)
        const isMockToken = !slackBotToken || slackBotToken === 'MY_SLACK_BOT_TOKEN' || slackBotToken.startsWith('mock') || !slackBotToken.startsWith('xox');
        
        if (isMockToken) {
          console.log(`[Slack Simulated API] Saved simulated thread post to channel: ${event.channel}`);
          updateLog(logItem.id, {
            status: 'success',
            aiResponse: `${generatedText}\n\n_(Simulated Dispatch: SLACK_BOT_TOKEN is not configured or is mock)_`
          });
        } else {
          // Thread-grouped Slack API dispatch
          const threadTsTarget = event.thread_ts || event.ts;
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
            aiResponse: generatedText
          });
        }

      } catch (bkErr: any) {
        console.error(`[Background Task Misfire] `, bkErr);
        updateLog(logItem.id, {
          status: 'error',
          error: bkErr.message || String(bkErr)
        });
      }
    });

  } catch (syncErr: any) {
    console.error(`[Synchronous Processing Crash] `, syncErr);
    res.status(400).send(`Exception caught: ${syncErr.message || String(syncErr)}`);
  }
});

// Configure Vite middleware or static paths based on environment
async function initServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[Vite Dev] Hosting express full-stack server with Vite middleware mode...`);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log(`[Express Prod] Hosting statically compiled UI bundle...`);
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Bind to port 3000 and 0.0.0.0 exclusively
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Fullstack Server Ready] Slack backend API serving on http://0.0.0.0:${PORT}`);
  });
}

initServer();
