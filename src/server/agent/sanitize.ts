/**
 * Centralized secret detection & redaction (W1 file-change-map: agent/sanitize.ts).
 *
 * Previously this logic was duplicated in `state.ts` (sanitizeText) and `agentStore.ts`
 * (sanitizePayload). Both now delegate here so there is a single source of truth for what
 * counts as a secret and how it gets scrubbed before it is persisted or surfaced.
 */

// Patterns that indicate a value is (or contains) a credential/secret.
const SECRET_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /\btoken\b/i,
  /bearer/i,
  /credential/i,
  /\bpwd\b/i,
  /private[_-]?key/i,
  /xox[bpars]-[a-zA-Z0-9-]{10,}/i,
  /AIzaSy[a-zA-Z0-9_-]{33}/,
];

/** True when the text looks like it contains a secret/credential. Used to refuse memory writes. */
export function containsSecret(text: string | undefined | null): boolean {
  if (!text) return false;
  return SECRET_PATTERNS.some((p) => p.test(text));
}

/** Redact well-known secret token shapes from a string. */
export function sanitizeString(text: string | undefined): string | undefined {
  if (!text) return text;
  let s = text;
  s = s.replace(/xoxb-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_BOT_TOKEN]');
  s = s.replace(/xoxp-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_USER_TOKEN]');
  s = s.replace(/xox[ars]-[a-zA-Z0-9-]{10,}/gi, '[REDACTED_SLACK_TOKEN]');
  s = s.replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, '[REDACTED_GEMINI_API_KEY]');
  s = s.replace(/(password|secret|token|api[_-]?key|bearer)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\.]{8,}/gi, '$1=[REDACTED]');
  return s;
}

/**
 * Redact secrets from an arbitrary JSON-serializable payload. Strings are returned redacted;
 * objects are round-tripped through JSON so nested secrets are scrubbed too. Falls back to the
 * original value if it cannot be serialized (e.g. circular references).
 */
export function sanitizePayload(payload: any): any {
  if (payload === null || payload === undefined) return payload;
  let str: string;
  try {
    str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    return payload;
  }
  const sanitized = sanitizeString(str) ?? str;
  if (typeof payload === 'string') return sanitized;
  try {
    return JSON.parse(sanitized);
  } catch {
    return payload;
  }
}
