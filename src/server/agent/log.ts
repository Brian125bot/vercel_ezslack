import { sanitizePayload } from './sanitize.js';

export function slog(scope: string, event: string, fields: any = {}) {
  const sanitized = sanitizePayload(fields);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    scope,
    event,
    ...sanitized
  }));
}
