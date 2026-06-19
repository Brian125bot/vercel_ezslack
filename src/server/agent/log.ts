import { sanitizePayload } from './sanitize.js';

/**
 * Structured logger. All field values are run through `sanitizePayload`
 * before emission — secrets are never written to stdout.
 */
export function slog(scope: string, event: string, fields: any = {}) {
  const sanitized = sanitizePayload(fields);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    scope,
    event,
    ...sanitized
  }));
}
