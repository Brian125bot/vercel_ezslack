export function containsSecret(text: string): boolean {
  if (typeof text !== 'string') return false;
  const secretPatterns = [
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

export function sanitizeString(text: string): string {
  if (typeof text !== 'string') return text;
  let sanitized = text;
  const secretPatterns = [
    /(xox[bp])(-[a-zA-Z0-9-]{10,})/gi,
    /(sk-[a-zA-Z0-9]{20,})/gi,
    /(AIza[0-9A-Za-z-_]{35})/gi,
    /(AKIA[0-9A-Z]{16})/gi,
    /(password\s*=\s*['"]?)[a-zA-Z0-9!@#$%^&*()_+]{8,}(['"]?)/gi,
    /(bearer\s+)[a-zA-Z0-9\-\._~+\/]+={0,2}/gi,
    /(-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----[\s\S]+?-----END (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----)/g,
    /(\b(?:secret|api[_|]?[0-9a-z]?key|token|pwd)[:=]\s*['"]?)[A-Za-z0-9\-\._~+\/]{8,}={0,2}/gi
  ];
  
  secretPatterns.forEach(pattern => {
    sanitized = sanitized.replace(pattern, (match, p1, p2) => {
      // If we have capture groups, we want to keep the prefixes/suffixes
      if (p1 !== undefined && p2 !== undefined && typeof p1 === 'string' && typeof p2 === 'string') {
        // This handles cases like password="...", keep password=" and "
        return `${p1}[REDACTED]${p2}`;
      }
      if (p1 !== undefined && typeof p1 === 'string') {
        // This handles cases like bearer ..., keep bearer
        return `${p1}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  });
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
