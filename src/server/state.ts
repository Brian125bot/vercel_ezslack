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

export function addLog(item: SlackEventLog) {
  logs.unshift(item); // Latest first
  if (logs.length > maxLogs) {
    logs.pop();
  }
}

export function updateLog(id: string, updates: Partial<SlackEventLog>) {
  const index = logs.findIndex(log => log.id === id);
  if (index !== -1) {
    logs[index] = { ...logs[index], ...updates };
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
