export function containsSecret(text: string): boolean {
  if (typeof text !== 'string') return false;
  const secretPatterns = [
    /(?:xox[bpoasr]-[a-zA-Z0-9-]{10,})/i, // Slack tokens
    /(?:sk-[a-zA-Z0-9]{20,})/i, // OpenAI-like
    /(?:AIza[0-9A-Za-z-_]{35})/i, // Google API Key
    /(?:AKIA[0-9A-Z]{16})/i, // AWS Access Key
    /password\s*=\s*['"]?[a-zA-Z0-9!@#$%^&*()_+]{8,}['"]?/i,
    /bearer\s+[a-zA-Z0-9\-\._~+\/]+=*/i,
    /-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/,
    /(?:\b(?:secret|api[_|]?[0-9a-z]?key|token|pwd)[:=]\s*['"]?[A-Za-z0-9\-\._~+\/]{8,}={0,2})/i
  ];
  return secretPatterns.some(pattern => pattern.test(text));
}

/**
 * Each rule pairs a global regex with a string replacement template.
 *
 * Using string templates (instead of a function replacer) is deliberate: a
 * function replacer receives `(match, p1, p2, …, offset, string)`, so patterns
 * WITHOUT capture groups would expose `offset`/`string` as `p1`/`p2` and could
 * accidentally re-emit the original (secret-bearing) text. String templates with
 * `$1`/`$2` backreferences only substitute real capture groups, so a pattern with
 * no groups always collapses to a literal `[REDACTED]`.
 */
const SANITIZE_RULES: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // Opaque token formats — no capture groups, redact the whole match.
  { re: /xox[bpoasr]-[a-zA-Z0-9-]{10,}/gi, replacement: '[REDACTED]' }, // Slack
  { re: /sk-[a-zA-Z0-9]{20,}/gi, replacement: '[REDACTED]' }, // OpenAI
  { re: /AIza[0-9A-Za-z-_]{35}/gi, replacement: '[REDACTED]' }, // Google
  { re: /AKIA[0-9A-Z]{16}/gi, replacement: '[REDACTED]' }, // AWS
  // Keyed assignments — keep the descriptive prefix ($1)/suffix ($2), redact the value.
  { re: /(password\s*=\s*['"]?)[a-zA-Z0-9!@#$%^&*()_+]{8,}(['"]?)/gi, replacement: '$1[REDACTED]$2' },
  { re: /(bearer\s+)[a-zA-Z0-9\-\._~+\/]+={0,2}/gi, replacement: '$1[REDACTED]' },
  { re: /-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----[\s\S]+?-----END (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/g, replacement: '[REDACTED]' },
  { re: /(\b(?:secret|api[_|]?[0-9a-z]?key|token|pwd)[:=]\s*['"]?)[A-Za-z0-9\-\._~+\/]{8,}={0,2}/gi, replacement: '$1[REDACTED]' }
];

export function sanitizeString(text: string): string {
  if (typeof text !== 'string') return text;
  let sanitized = text;
  for (const { re, replacement } of SANITIZE_RULES) {
    sanitized = sanitized.replace(re, replacement);
  }
  return sanitized;
}

export function sanitizePayload(payload: any): any {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'string') return sanitizeString(payload);
  if (Array.isArray(payload)) return payload.map(sanitizePayload);
  if (typeof payload === 'object') {
    const safe: any = {};
    for (const [key, value] of Object.entries(payload)) {
      if (containsSecret(key)) {
        safe['[REDACTED_KEY]'] = sanitizePayload(value);
      } else {
        safe[key] = sanitizePayload(value);
      }
    }
    return safe;
  }
  return payload;
}
