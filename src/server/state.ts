import { SlackEventLog, ThreadMessage } from '../types.js';

// Stateful Conversation Thread Memory
export const threadMemory = new Map<string, ThreadMessage[]>();

// In-memory rolling logs buffer
export const logs: SlackEventLog[] = [];
export const maxLogs = 50;

export let selectedModel = 'gemini-3.1-flash-lite';

export function setSelectedModel(model: string) {
  selectedModel = model;
}

export function sanitizeText(text: string | undefined): string | undefined {
  if (!text) return text;
  let sanitized = text;
  sanitized = sanitized.replace(/xoxb-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_BOT_TOKEN]');
  sanitized = sanitized.replace(/xoxp-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_USER_TOKEN]');
  sanitized = sanitized.replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, '[REDACTED_GEMINI_API_KEY]');
  sanitized = sanitized.replace(/(password|secret|token)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{8,}/gi, '$1=[REDACTED]');
  return sanitized;
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
  if (sanitized.text !== undefined) {
    sanitized.text = sanitizeText(sanitized.text) || '';
  }
  if (sanitized.aiResponse !== undefined) {
    sanitized.aiResponse = sanitizeText(sanitized.aiResponse);
  }
  if (sanitized.error !== undefined) {
    sanitized.error = sanitizeText(sanitized.error);
  }
  return sanitized;
}

export function addLog(item: SlackEventLog) {
  logs.unshift(sanitizeLogItem(item)); // Latest first
  if (logs.length > maxLogs) {
    logs.pop();
  }
}

export function updateLog(id: string, updates: Partial<SlackEventLog>) {
  const index = logs.findIndex(log => log.id === id);
  if (index !== -1) {
    logs[index] = { ...logs[index], ...sanitizePartialLogItem(updates) };
  }
}

// Event deduplication storage
export const processedEventIds = new Set<string>();
export const processedMessageKeys = new Set<string>();
export const eventTimestamps = new Map<string, number>();

// Clean up events older than 10 minutes every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of eventTimestamps.entries()) {
    if (now - timestamp > 600 * 1000) {
      processedEventIds.delete(key);
      processedMessageKeys.delete(key);
      eventTimestamps.delete(key);
    }
  }
}, 60 * 1000);
