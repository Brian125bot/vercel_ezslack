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

import { sanitizeString } from './agent/sanitize.js';

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
