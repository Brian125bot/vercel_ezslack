import { SlackEventLog, ThreadMessage } from '../types.js';
import { sanitizeString } from './agent/sanitize.js';

// ── In-memory fallbacks (used when DB is unavailable) ──
const memoryLogs: SlackEventLog[] = [];
const memoryThreads = new Map<string, ThreadMessage[]>();
const memoryProcessedEvents = new Set<string>();
const memoryProcessedMessages = new Set<string>();
const memoryEventTimestamps = new Map<string, number>();
let memorySelectedModel = 'gemini-3.1-flash-lite';

export const maxLogs = 50;

// ── DB availability check ──
let dbModule: any = null;
async function getQuery(): Promise<((sql: string, params?: any[]) => Promise<any[]>) | null> {
  try {
    if (!dbModule) {
      dbModule = await import('./storage/db.js');
    }
    const available = await dbModule.isDbAvailable();
    if (!available) return null;
    return dbModule.query;
  } catch {
    return null;
  }
}

// ── Sanitization helpers ──
export function sanitizeText(text: string | undefined): string | undefined {
  if (!text) return text;
  return sanitizeString(text);
}

export function sanitizeLogItem(item: SlackEventLog): SlackEventLog {
  return {
    ...item,
    text: sanitizeText(item.text) || '',
    aiResponse: sanitizeText(item.aiResponse),
    error: sanitizeText(item.error)
  };
}

export function sanitizePartialLogItem(item: Partial<SlackEventLog>): Partial<SlackEventLog> {
  const sanitized = { ...item };
  if (sanitized.text !== undefined) sanitized.text = sanitizeText(sanitized.text) || '';
  if (sanitized.aiResponse !== undefined) sanitized.aiResponse = sanitizeText(sanitized.aiResponse);
  if (sanitized.error !== undefined) sanitized.error = sanitizeText(sanitized.error);
  return sanitized;
}

// ── Logs ──
export async function addLog(item: SlackEventLog) {
  const sanitized = sanitizeLogItem(item);
  memoryLogs.unshift(sanitized);
  if (memoryLogs.length > maxLogs) memoryLogs.pop();

  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO slack_event_logs (id, event_id, event_type, channel, "user", text, status, signature_verified, ai_response, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [sanitized.id, sanitized.eventId, sanitized.eventType, sanitized.channel, sanitized.user, sanitized.text, sanitized.status, sanitized.signatureVerified, sanitized.aiResponse || null, sanitized.error || null]
      );
    } catch (e) {
      console.warn('[State] Failed to persist log to DB:', e);
    }
  }
}

export async function updateLog(id: string, updates: Partial<SlackEventLog>) {
  const sanitized = sanitizePartialLogItem(updates);
  const index = memoryLogs.findIndex(log => log.id === id);
  if (index !== -1) {
    memoryLogs[index] = { ...memoryLogs[index], ...sanitized };
  }

  const q = await getQuery();
  if (q) {
    try {
      const setClauses: string[] = [];
      const params: any[] = [];
      let idx = 1;
      const fieldMap: Record<string, string> = {
        status: 'status', aiResponse: 'ai_response', error: 'error',
        intent: 'intent', confidence: 'confidence', source: 'source',
        processingTimeMs: 'processing_time_ms', runId: 'run_id'
      };
      for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if ((sanitized as any)[jsKey] !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`);
          params.push((sanitized as any)[jsKey] ?? null);
          idx++;
        }
      }
      if (setClauses.length > 0) {
        params.push(id);
        await q(`UPDATE slack_event_logs SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
      }
    } catch (e) {
      console.warn('[State] Failed to update log in DB:', e);
    }
  }
}

export async function getLogs(): Promise<SlackEventLog[]> {
  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(
        `SELECT id, timestamp, event_id as "eventId", event_type as "eventType", channel, "user", text, status,
                signature_verified as "signatureVerified", ai_response as "aiResponse", error,
                intent, confidence, source, processing_time_ms as "processingTimeMs", run_id as "runId"
         FROM slack_event_logs ORDER BY created_at DESC LIMIT $1`,
        [maxLogs]
      );
      return rows;
    } catch (e) {
      console.warn('[State] Failed to read logs from DB, falling back to memory:', e);
    }
  }
  return memoryLogs;
}

export async function clearLogs(): Promise<void> {
  memoryLogs.length = 0;
  const q = await getQuery();
  if (q) {
    try { await q('DELETE FROM slack_event_logs'); } catch { /* ignore */ }
  }
}

// ── Selected Model ──
export let selectedModel = memorySelectedModel;

export async function getSelectedModel(): Promise<string> {
  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(`SELECT value FROM system_settings WHERE key = 'selected_model'`);
      if (rows.length) {
        selectedModel = rows[0].value;
        return selectedModel;
      }
    } catch { /* fall through to memory */ }
  }
  return selectedModel;
}

export async function setSelectedModel(model: string) {
  selectedModel = model;
  memorySelectedModel = model;
  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ('selected_model', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [model]
      );
    } catch (e) {
      console.warn('[State] Failed to persist model selection:', e);
    }
  }
}

// ── Thread Memory ──
export async function getThreadHistory(threadKey: string): Promise<ThreadMessage[]> {
  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(`SELECT messages FROM thread_memories WHERE thread_key = $1`, [threadKey]);
      if (rows.length) {
        const messages = typeof rows[0].messages === 'string' ? JSON.parse(rows[0].messages) : rows[0].messages;
        return messages;
      }
    } catch { /* fall through */ }
  }
  return memoryThreads.get(threadKey) || [];
}

export async function saveThreadHistory(threadKey: string, messages: ThreadMessage[]) {
  const trimmed = messages.length > 20 ? messages.slice(-20) : messages;
  memoryThreads.set(threadKey, trimmed);
  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO thread_memories (thread_key, messages, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (thread_key) DO UPDATE SET messages = $2, updated_at = now()`,
        [threadKey, JSON.stringify(trimmed)]
      );
    } catch (e) {
      console.warn('[State] Failed to persist thread history:', e);
    }
  }
}

// ── Event Deduplication ──
export async function isEventDuplicate(eventKey: string): Promise<boolean> {
  if (memoryProcessedEvents.has(eventKey)) return true;

  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(
        `INSERT INTO processed_events (event_key) VALUES ($1)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING event_key`,
        [eventKey]
      );
      if (rows.length === 0) return true;
      memoryProcessedEvents.add(eventKey);
      memoryEventTimestamps.set(eventKey, Date.now());
      return false;
    } catch { /* fall through */ }
  }

  memoryProcessedEvents.add(eventKey);
  memoryEventTimestamps.set(eventKey, Date.now());
  return false;
}

export async function isMessageDuplicate(msgKey: string): Promise<boolean> {
  if (memoryProcessedMessages.has(msgKey)) return true;

  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(
        `INSERT INTO processed_events (event_key) VALUES ($1)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING event_key`,
        [msgKey]
      );
      if (rows.length === 0) return true;
      memoryProcessedMessages.add(msgKey);
      memoryEventTimestamps.set(msgKey, Date.now());
      return false;
    } catch { /* fall through */ }
  }

  memoryProcessedMessages.add(msgKey);
  memoryEventTimestamps.set(msgKey, Date.now());
  return false;
}

// ── Legacy exports for backward compatibility ──
export const logs = memoryLogs;
export const processedEventIds = memoryProcessedEvents;
export const processedMessageKeys = memoryProcessedMessages;
export const eventTimestamps = memoryEventTimestamps;
export const threadMemory = memoryThreads;

// Clean up in-memory events older than 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of memoryEventTimestamps.entries()) {
    if (now - timestamp > 600 * 1000) {
      memoryProcessedEvents.delete(key);
      memoryProcessedMessages.delete(key);
      memoryEventTimestamps.delete(key);
    }
  }
}, 60 * 1000);

// Clean up old processed_events from DB periodically (every 10 minutes)
setInterval(async () => {
  const q = await getQuery();
  if (q) {
    try {
      await q(`DELETE FROM processed_events WHERE created_at < now() - interval '10 minutes'`);
    } catch { /* ignore */ }
  }
}, 600 * 1000);
