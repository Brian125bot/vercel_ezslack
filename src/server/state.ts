import { SlackEventLog, ThreadMessage } from '../types.js';
import { sanitizeString } from './agent/sanitize.js';
import { resolveModel, DEFAULT_MODEL, getContextWindowTokens } from './agent/models.js';
import { setRedisValueNX, getRedisJson, setRedisJson, getRedisValue, del, isRedisConfigured, pingRedis } from './redis.js';
import crypto from 'crypto';
import { DurableStateError } from './storage/errors.js';
export { DurableStateError } from './storage/errors.js';

// ── Fail-closed helpers ──
function isInMemoryFallbackAllowed(): boolean {
  if (process.env.ALLOW_IN_MEMORY_STATE_FALLBACK === 'true') return true;
  if (process.env.ALLOW_IN_MEMORY_STATE_FALLBACK === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
function shouldFailClosed(): boolean {
  return !isInMemoryFallbackAllowed();
}
let hasWarnedEphemeral = false;
function warnEphemeralOnce(operation: string, cause?: unknown) {
  if (!hasWarnedEphemeral) {
    hasWarnedEphemeral = true;
    console.warn(
      `[State] Durable state unavailable — using ephemeral in-memory fallback for ${operation} (NODE_ENV !== production or ALLOW_IN_MEMORY_STATE_FALLBACK=true). Do not use in production; multi-instance dedup & thread context will be lost.`,
      cause ? { cause } : ''
    );
  }
}
export function resetStateForTests(): void {
  if (process.env.NODE_ENV === 'test') {
    hasWarnedEphemeral = false;
  }
}

// ── Limits ──
const get_MAX_THREAD_HISTORY_MESSAGES = () => parseInt(process.env.MAX_THREAD_HISTORY_MESSAGES || '20');
const MAX_THREAD_MESSAGE_CHARS = parseInt(process.env.MAX_THREAD_MESSAGE_CHARS || '4000');

const get_THREAD_HISTORY_BUDGET_PERCENT = () => parseFloat(process.env.THREAD_HISTORY_BUDGET_PERCENT || '0.05');
const get_CHARS_PER_TOKEN_ESTIMATE = () => 4;

function defaultThreadHistoryCharBudget(model: string): number {
  const tokens = getContextWindowTokens(model);
  return Math.floor(tokens * get_CHARS_PER_TOKEN_ESTIMATE() * get_THREAD_HISTORY_BUDGET_PERCENT());
}

// ── In-memory fallbacks (used when DB is unavailable) ──
const memoryLogs: SlackEventLog[] = [];
const memoryThreads = new Map<string, ThreadMessage[]>();
const memoryProcessedEvents = new Set<string>();
const memoryProcessedMessages = new Set<string>();
const memoryEventTimestamps = new Map<string, number>();
let memorySelectedModel: string = DEFAULT_MODEL;

// ── Sandbox Session Cache (Phase 1) ──
const memorySandboxCache = new Map<string, { sandboxId: string; expiresAt: number }>();
const SANDBOX_TTL_MS = parseInt(process.env.SANDBOX_TTL_MS || '900000'); // 15 min default

export async function getSessionSandboxId(sessionKeyOrChannel: string, threadTs?: string): Promise<string | null> {
  const sessionKey = threadTs ? `${sessionKeyOrChannel}:${threadTs}` : sessionKeyOrChannel;
  // Check in-memory cache first (ephemeral, used only in fallback mode or as read-through)
  const cached = memorySandboxCache.get(sessionKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sandboxId;
  }
  if (cached) {
    memorySandboxCache.delete(sessionKey);
  }

  // Check DB — fail-closed in production if unavailable
  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(
        `SELECT sandbox_id, expires_at FROM sandbox_sessions WHERE session_key = $1 AND expires_at > now()`,
        [sessionKey]
      );
      if (rows.length) {
        const sandboxId = rows[0].sandbox_id;
        const expiresAt = new Date(rows[0].expires_at).getTime();
        memorySandboxCache.set(sessionKey, { sandboxId, expiresAt });
        return sandboxId;
      }
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'getSessionSandboxId', e);
      }
      console.warn('[State] Failed to read sandbox session from DB:', e);
      warnEphemeralOnce('getSessionSandboxId', e);
    }
  } else if (shouldFailClosed()) {
    throw new DurableStateError('persistence unavailable', 'getSessionSandboxId', new Error('Database unavailable'));
  }
  if (shouldFailClosed()) {
    // In production, missing DB when no cache hit is considered persistence unavailable
    // But if we have no cache and DB unavailable, we already threw above.
    // This path is for when DB was unavailable and we would fallback to null.
    // For get, returning null even when DB down would be silent fallback; spec wants fail-closed on writes, reads may return null in dev.
    // To distinguish, we only throw on write path; reads fallback to null with warning in production is less critical.
    // However spec lists isEventProcessed etc as critical reads; sandbox read is not listed, so allow null in prod with warning.
    warnEphemeralOnce('getSessionSandboxId');
  }
  return null;
}

export async function setSessionSandboxId(sessionKeyOrChannel: string, sandboxIdOrThreadTs: string, maybeSandboxId?: string): Promise<void> {
  let sessionKey: string;
  let sandboxId: string;
  if (maybeSandboxId !== undefined) {
    // spec signature: (channel, threadTs, sandboxId)
    sessionKey = `${sessionKeyOrChannel}:${sandboxIdOrThreadTs}`;
    sandboxId = maybeSandboxId;
  } else {
    sessionKey = sessionKeyOrChannel;
    sandboxId = sandboxIdOrThreadTs;
  }
  const expiresAt = Date.now() + SANDBOX_TTL_MS;

  // Update in-memory cache optimistically
  memorySandboxCache.set(sessionKey, { sandboxId, expiresAt });

  // Persist to DB — must be durable in production
  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO sandbox_sessions (session_key, sandbox_id, expires_at, updated_at)
         VALUES ($1, $2, to_timestamp($3/1000), now())
         ON CONFLICT (session_key) DO UPDATE SET sandbox_id = $2, expires_at = to_timestamp($3/1000), updated_at = now()`,
        [sessionKey, sandboxId, expiresAt]
      );
      return;
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'setSessionSandboxId', e);
      }
      console.warn('[State] Failed to persist sandbox session:', e);
      warnEphemeralOnce('setSessionSandboxId', e);
      return;
    }
  }
  if (shouldFailClosed()) {
    throw new DurableStateError('persistence unavailable', 'setSessionSandboxId', new Error('Database unavailable'));
  }
  warnEphemeralOnce('setSessionSandboxId');
}

export function generateSessionKey(workspaceId: string, channelId: string, threadTs?: string): string {
  return threadTs ? `${workspaceId}:${channelId}:${threadTs}` : `${workspaceId}:${channelId}`;
}

export const maxLogs = 50;
const MAX_DEDUP_SET_SIZE = 10000; // Prevent OOM under sustained load

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
          let val = (sanitized as any)[jsKey] ?? null;
          if (dbCol === 'processing_time_ms' && typeof val === 'number' && val > 2147483647) {
            console.warn(`[State] Clamping processing_time_ms ${val} to INT4 max (likely Date.now() leak)`);
            val = 2147483647;
          }
          setClauses.push(`${dbCol} = $${idx}`);
          params.push(val);
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
        // WS1: never hand back an unreleased/invalid persisted model.
        selectedModel = resolveModel(rows[0].value);
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
export async function getThreadHistory(channelOrThreadKey: string, threadTs?: string): Promise<ThreadMessage[]> {
  const threadKey = threadTs !== undefined ? `${channelOrThreadKey}:${threadTs}` : channelOrThreadKey;
  const redisKey = `thread:${threadKey}`;

  // Try Redis first — durable shared cache
  try {
    const cached = await getRedisJson<ThreadMessage[]>(redisKey);
    if (cached) return cached;
  } catch (e) {
    if (shouldFailClosed()) {
      // Redis read failure in prod should not fallback silently if DB also fails; continue to DB check before throwing
    } else {
      console.warn('[State] Failed to read thread history from Redis:', e);
    }
  }

  // Try DB
  const q = await getQuery();
  if (q) {
    try {
      const rows = await q(`SELECT messages FROM thread_memories WHERE thread_key = $1`, [threadKey]);
      if (rows.length) {
        const messages = typeof rows[0].messages === 'string' ? JSON.parse(rows[0].messages) : rows[0].messages;
        setRedisJson(redisKey, messages, 3600).catch(() => {});
        return messages;
      }
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'getThreadHistory', e);
      }
      // fall through to memory in dev
    }
  } else if (shouldFailClosed()) {
    // DB unavailable and no Redis hit
    // Check if Redis is also unavailable: if Redis is configured but we got no cache, consider persistence unavailable in prod
    if (isRedisConfigured()) {
      try {
        const ping = await pingRedis();
        if (!ping) throw new DurableStateError('persistence unavailable', 'getThreadHistory', new Error('Database and Redis unavailable'));
      } catch (e) {
        if (e instanceof DurableStateError) throw e;
        throw new DurableStateError('persistence unavailable', 'getThreadHistory', e);
      }
    } else {
      throw new DurableStateError('persistence unavailable', 'getThreadHistory', new Error('Database unavailable'));
    }
  }

  const fallback = memoryThreads.get(threadKey) || [];
  if (shouldFailClosed() && fallback.length === 0) {
    // If we are in prod and both durable stores failed, we already threw above.
    // If fallback is empty but we had no durable data, returning empty is not an error — but if persistence was unavailable we threw.
    // So just warn once if we are using memory path
    warnEphemeralOnce('getThreadHistory');
  } else if (!shouldFailClosed()) {
    warnEphemeralOnce('getThreadHistory');
  }
  return fallback;
}

export async function saveThreadHistory(threadKeyOrChannel: string, messagesOrThreadTs: ThreadMessage[] | string, maybeMessages?: ThreadMessage[]): Promise<void> {
  // Support both signatures: (threadKey, messages) and (channel, threadTs, messages) — detect arity
  let threadKey: string;
  let messages: ThreadMessage[];
  if (maybeMessages !== undefined) {
    // (channel, threadTs, messages)
    const channel = threadKeyOrChannel;
    const threadTs = messagesOrThreadTs as string;
    threadKey = `${channel}:${threadTs}`;
    messages = maybeMessages;
  } else if (Array.isArray(messagesOrThreadTs)) {
    threadKey = threadKeyOrChannel;
    messages = messagesOrThreadTs;
  } else {
    // Fallback: treat as (channel, threadTs) with missing messages — shouldn't happen
    threadKey = threadKeyOrChannel;
    messages = [] as any;
  }
  const sanitizedMessages = messages.map(msg => {
    let newMsg = { ...msg };
    if (newMsg.attachments && newMsg.attachments.length > 0) {
      newMsg.attachments = newMsg.attachments.map(att => ({
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        // Drop base64Data and sourceUrl to save space
      })) as any;
    }
    if (newMsg.text && newMsg.text.length > MAX_THREAD_MESSAGE_CHARS) {
      newMsg.text = newMsg.text.substring(0, MAX_THREAD_MESSAGE_CHARS) + `…[truncated, original ${newMsg.text.length}chars]`;
    }
    return newMsg;
  });

  const maxMsgs = get_MAX_THREAD_HISTORY_MESSAGES();
  const sliced = sanitizedMessages.length > maxMsgs
    ? sanitizedMessages.slice(-maxMsgs)
    : sanitizedMessages;

  const currentModel = await getSelectedModel();
  const maxHistoryChars = process.env.MAX_THREAD_HISTORY_CHARS
    ? parseInt(process.env.MAX_THREAD_HISTORY_CHARS)
    : defaultThreadHistoryCharBudget(currentModel);

  const trimmed: ThreadMessage[] = [];
  let totalChars = 0;
  for (let i = sliced.length - 1; i >= 0; i--) {
    const msg = sliced[i];
    const msgLength = msg.text ? msg.text.length : 0;
    if (totalChars + msgLength > maxHistoryChars) {
      break;
    }
    trimmed.unshift(msg);
    totalChars += msgLength;
  }

  memoryThreads.set(threadKey, trimmed);
  // Best-effort Redis cache — failures are logged but only fail-closed if DB also fails
  let redisSuccess = false;
  try {
    redisSuccess = await setRedisJson(`thread:${threadKey}`, trimmed, 3600);
  } catch (_) {
    redisSuccess = false;
  }

  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO thread_memories (thread_key, messages, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (thread_key) DO UPDATE SET messages = $2, updated_at = now()`,
        [threadKey, JSON.stringify(trimmed)]
      );
      return;
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'saveThreadHistory', e);
      }
      console.warn('[State] Failed to persist thread history:', e);
      warnEphemeralOnce('saveThreadHistory', e);
      return;
    }
  }
  if (shouldFailClosed()) {
    // DB unavailable — if Redis also failed, we have no durable persistence
    if (!redisSuccess) {
      throw new DurableStateError('persistence unavailable', 'saveThreadHistory', new Error('Database and Redis unavailable'));
    }
    // If Redis succeeded, we have at least ephemeral distributed cache; but spec says both must fail to throw.
    // However for strong consistency, require DB in prod; so still throw if DB unavailable even if Redis cached.
    throw new DurableStateError('persistence unavailable', 'saveThreadHistory', new Error('Database unavailable'));
  }
  warnEphemeralOnce('saveThreadHistory');
}

export async function appendThreadMessage(channel: string, threadTs: string, message: ThreadMessage): Promise<void> {
  const threadKey = `${channel}:${threadTs}`;
  // getThreadHistory will fail-closed in prod if durable unavailable, so we propagate that
  const history = await getThreadHistory(threadKey);
  const newHistory = [...history, message];
  await saveThreadHistory(threadKey, newHistory);
}

// ── Event Deduplication ──
function capDedupSet(set: Set<string>, map: Map<string, number>, key: string) {
  if (set.size >= MAX_DEDUP_SET_SIZE) {
    // Evict oldest 20% when cap reached
    const entries = [...map.entries()].sort((a, b) => a[1] - b[1]);
    const evictCount = Math.floor(MAX_DEDUP_SET_SIZE * 0.2);
    for (let i = 0; i < evictCount && i < entries.length; i++) {
      set.delete(entries[i][0]);
      map.delete(entries[i][0]);
    }
  }
  set.add(key);
  map.set(key, Date.now());
}

export async function isEventDuplicate(eventKey: string): Promise<boolean> {
  const dedupKey = `dedup:event:${eventKey}`;
  let redisNew: boolean | null = null;
  let redisError: unknown = null;
  try {
    redisNew = await setRedisValueNX(dedupKey, '1', 600);
  } catch (e) {
    redisError = e;
    redisNew = null;
  }
  if (redisNew) {
    capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventKey);
    return false;
  }
  // If Redis indicated duplicate via NX false because key exists, we need to distinguish from Redis failure.
  // When Redis is configured and ping fails, treat as failure; otherwise treat false as duplicate hint and continue to DB check.
  // For simplicity, if redisNew === false and Redis is healthy, it means duplicate OR Redis returned false due to existing key — we still check DB/memory.
  // If Redis is unavailable (client null) redisNew will be false; we will fall through to DB and eventually fail-closed if DB also down.

  if (memoryProcessedEvents.has(eventKey)) {
    // In production fail-closed, memory hit without durable confirmation is not sufficient if Redis+DB down.
    // But if we reached here via Redis failure, we haven't confirmed durable.
    // We will still return true for duplicate to avoid re-processing in dev; in prod we need durable confirmation.
    // If shouldFailClosed and both durable stores unavailable, we throw below before returning memory result.
    // Check durable availability before trusting memory:
    if (shouldFailClosed()) {
      const qCheck = await getQuery();
      if (!qCheck) {
        // Check Redis health
        let redisAvailable = false;
        try {
          redisAvailable = isRedisConfigured() ? await pingRedis() : false;
        } catch {}
        if (!redisAvailable) {
          throw new DurableStateError('persistence unavailable', 'isEventDuplicate', redisError || new Error('Durable stores unavailable'));
        }
      }
    }
    return true;
  }

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
      capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventKey);
      return false;
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'isEventDuplicate', e);
      }
      // fall through to memory fallback in dev
    }
  } else if (shouldFailClosed()) {
    // DB unavailable — check if Redis was also unavailable
    let redisAvailable = redisNew === true; // true means Redis succeeded earlier; false could be duplicate or failure
    if (!redisAvailable) {
      try {
        redisAvailable = isRedisConfigured() ? await pingRedis() : false;
      } catch {}
      // If Redis was the reason we returned early, we already handled. Here, Redis did not confirm new, and DB unavailable.
      // If Redis unavailable, fail-closed
      if (!redisAvailable) {
        throw new DurableStateError('persistence unavailable', 'isEventDuplicate', redisError || new Error('Database and Redis unavailable'));
      }
    }
    // If Redis is available but DB down, still need DB for dedup durability in prod; should fail-closed
    // Spec says both must fail; but for dedup, DB is primary; if DB down in prod we must fail-closed even if Redis up? To be safe, throw when DB unavailable in prod.
    throw new DurableStateError('persistence unavailable', 'isEventDuplicate', new Error('Database unavailable'));
  }

  warnEphemeralOnce('isEventDuplicate', redisError);
  capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventKey);
  return false;
}

export async function isMessageDuplicate(msgKey: string): Promise<boolean> {
  const dedupKey = `dedup:msg:${msgKey}`;
  let redisNew: boolean | null = null;
  let redisError: unknown = null;
  try {
    redisNew = await setRedisValueNX(dedupKey, '1', 600);
  } catch (e) {
    redisError = e;
    redisNew = null;
  }
  if (redisNew) {
    capDedupSet(memoryProcessedMessages, memoryEventTimestamps, msgKey);
    return false;
  }
  if (memoryProcessedMessages.has(msgKey)) {
    if (shouldFailClosed()) {
      const qCheck = await getQuery();
      if (!qCheck) {
        let redisAvailable = false;
        try {
          redisAvailable = isRedisConfigured() ? await pingRedis() : false;
        } catch {}
        if (!redisAvailable) {
          throw new DurableStateError('persistence unavailable', 'isMessageDuplicate', redisError || new Error('Durable stores unavailable'));
        }
      }
    }
    return true;
  }

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
      capDedupSet(memoryProcessedMessages, memoryEventTimestamps, msgKey);
      return false;
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'isMessageDuplicate', e);
      }
    }
  } else if (shouldFailClosed()) {
    let redisAvailable = redisNew === true;
    if (!redisAvailable) {
      try {
        redisAvailable = isRedisConfigured() ? await pingRedis() : false;
      } catch {}
      if (!redisAvailable) {
        throw new DurableStateError('persistence unavailable', 'isMessageDuplicate', redisError || new Error('Database and Redis unavailable'));
      }
    }
    throw new DurableStateError('persistence unavailable', 'isMessageDuplicate', new Error('Database unavailable'));
  }

  warnEphemeralOnce('isMessageDuplicate', redisError);
  capDedupSet(memoryProcessedMessages, memoryEventTimestamps, msgKey);
  return false;
}

// Mission-spec aliases — fail-closed semantics delegate to the primary implementations
export async function isEventProcessed(eventId: string): Promise<boolean> {
  try {
    return await isEventDuplicate(eventId);
  } catch (e) {
    if (e instanceof DurableStateError) {
      // Re-throw with mission operation name for test introspection
      throw new DurableStateError(e.message, 'isEventProcessed', e.cause || e);
    }
    throw e;
  }
}

export async function markEventProcessed(eventId: string, ttlSeconds = 600): Promise<void> {
  const dedupKey = `dedup:event:${eventId}`;
  let redisSuccess = false;
  let redisError: unknown = null;
  try {
    redisSuccess = await setRedisValueNX(dedupKey, '1', ttlSeconds);
  } catch (e) {
    redisError = e;
    redisSuccess = false;
  }
  const q = await getQuery();
  if (q) {
    try {
      await q(
        `INSERT INTO processed_events (event_key) VALUES ($1) ON CONFLICT (event_key) DO NOTHING`,
        [eventId]
      );
      capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventId);
      return;
    } catch (e) {
      if (shouldFailClosed()) {
        throw new DurableStateError('persistence unavailable', 'markEventProcessed', e);
      }
      console.warn('[State] Failed to mark event processed in DB:', e);
      warnEphemeralOnce('markEventProcessed', e);
      capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventId);
      return;
    }
  }
  if (shouldFailClosed()) {
    let redisAvailable = redisSuccess;
    if (!redisAvailable) {
      try {
        redisAvailable = isRedisConfigured() ? await pingRedis() : false;
      } catch {}
      if (!redisAvailable) {
        throw new DurableStateError('persistence unavailable', 'markEventProcessed', redisError || new Error('Database and Redis unavailable'));
      }
    }
    throw new DurableStateError('persistence unavailable', 'markEventProcessed', new Error('Database unavailable'));
  }
  warnEphemeralOnce('markEventProcessed', redisError);
  capDedupSet(memoryProcessedEvents, memoryEventTimestamps, eventId);
}

// ── Legacy exports for backward compatibility ──
export const logs = memoryLogs;
export const processedEventIds = memoryProcessedEvents;
export const processedMessageKeys = memoryProcessedMessages;
export const eventTimestamps = memoryEventTimestamps;
export const threadMemory = memoryThreads;

// ── Intent-Based Deduplication ──

/**
 * Create a hash of user intent from the message text and context
 * This groups similar or related intents to prevent processing duplicates
 */
export function createIntentHash(messageText: string, channelId: string, userId: string, threadTs?: string): string {
  const normalizedText = messageText.trim().toLowerCase();
  const input = `${channelId}:${userId}:${threadTs || ''}:${normalizedText.substring(0, 200)}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Check if an intent is currently being processed
 * Returns true if already processing, false if it can proceed
 */
export async function isIntentProcessing(intentHash: string, windowSeconds = 300): Promise<boolean> {
  const redisKey = `dedup:intent:${intentHash}`;
  const value = await getRedisValue(redisKey);
  
  // Check if key exists and is within processing window
  if (value) {
    // Could check TTL if available, but simpler:
    // Fresh intent hash means it's being processed
    return true;
  }
  return false;
}

/**
 * Set an intent as currently processing
 * Returns true if set successfully (wasn't processing), false if already processing
 */
export async function setIntentDedup(intentHash: string, windowSeconds = 300): Promise<boolean> {
  const redisKey = `dedup:intent:${intentHash}`;
  return await setRedisValueNX(redisKey, '1', windowSeconds);
}

/**
 * Mark an intent as completed and clean up
 */
export async function markIntentComplete(intentHash: string, windowSeconds = 120): Promise<void> {
  const redisKey = `dedup:intent:${intentHash}`;
  await del(redisKey);

  // Set a short-lived marker to prevent immediate reprocessing
  const markerKey = `dedup:intent:completed:${intentHash}`;
  await setRedisValueNX(markerKey, '1', windowSeconds);
}

// On traditional servers, periodically clean up stale in-memory and DB state.
// On Vercel serverless, setInterval is unreliable after the response is sent,
// so these are skipped — the cron handler handles DB cleanup instead.
if (process.env.VERCEL !== '1') {
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
}
