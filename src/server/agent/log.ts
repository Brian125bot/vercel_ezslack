/**
 * Lightweight structured logging for the agent loop / worker (W2-E observability).
 *
 * Emits single-line JSON so Cloud Run / log aggregators can index fields (scope, runId,
 * iteration, event) instead of parsing free-form strings. Secrets are scrubbed via sanitize.
 */
import { sanitizePayload } from './sanitize.js';

export function slog(scope: string, event: string, fields: Record<string, any> = {}): void {
  const record = {
    ts: new Date().toISOString(),
    scope,
    event,
    ...sanitizePayload(fields),
  };
  try {
    console.log(`[agent] ${JSON.stringify(record)}`);
  } catch {
    console.log(`[agent] ${scope} ${event}`);
  }
}
