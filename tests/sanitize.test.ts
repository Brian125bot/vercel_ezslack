import { describe, it, expect } from 'vitest';
import { containsSecret, sanitizeString, sanitizePayload } from '../src/server/agent/sanitize.js';

describe('Secret Detection', () => {
  it('detects OpenAI-style API keys', () => {
    expect(containsSecret('sk-abcdefghijklmnopqrstuvwx')).toBe(true);
  });

  it('detects AWS access keys', () => {
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('detects password assignments', () => {
    expect(containsSecret('password = "mysecretpassword123"')).toBe(true);
  });

  it('detects bearer tokens', () => {
    expect(containsSecret('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(true);
  });

  it('does not flag normal text', () => {
    expect(containsSecret('Hello, how are you?')).toBe(false);
  });

  it('does not flag short passwords', () => {
    expect(containsSecret('password = "short"')).toBe(false);
  });
});

describe('String Sanitization', () => {
  it('redacts Slack bot tokens', () => {
    const result = sanitizeString('token is xoxb-1234567890-abcdefghijk');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('xoxb-1234567890');
  });

  it('preserves normal text', () => {
    const input = 'This is a normal message';
    expect(sanitizeString(input)).toBe(input);
  });
});

describe('Payload Sanitization', () => {
  it('sanitizes nested objects', () => {
    const payload = {
      message: 'Hello',
      nested: {
        secret: 'xoxb-1234567890-abcdefghijk'
      }
    };
    const result = sanitizePayload(payload);
    expect(result.message).toBe('Hello');
    expect(result.nested.secret).toContain('[REDACTED]');
  });

  it('sanitizes arrays', () => {
    const payload = ['normal', 'sk-abcdefghijklmnopqrstuvwx'];
    const result = sanitizePayload(payload);
    expect(result[0]).toBe('normal');
    expect(result[1]).toContain('[REDACTED]');
  });

  it('handles null/undefined gracefully', () => {
    expect(sanitizePayload(null)).toBe(null);
    expect(sanitizePayload(undefined)).toBe(undefined);
  });
});
