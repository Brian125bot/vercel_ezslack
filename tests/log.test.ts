import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slog } from '../src/server/agent/log.js';

describe('slog', () => {
  let consoleSpy: any;

  beforeEach(() => {
    // Spy on console.log
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the spy
    consoleSpy.mockRestore();
  });

  it('logs structured data with timestamp, scope, and event', () => {
    slog('test-scope', 'test-event');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const loggedString = consoleSpy.mock.calls[0][0];
    const loggedData = JSON.parse(loggedString);

    expect(loggedData).toHaveProperty('timestamp');
    expect(loggedData.scope).toBe('test-scope');
    expect(loggedData.event).toBe('test-event');
  });

  it('includes additional fields and sanitizes them', () => {
    slog('test-scope', 'test-event', {
      user: 'alice',
      token: 'xoxb-1234567890-abcdefghijk'
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const loggedString = consoleSpy.mock.calls[0][0];
    const loggedData = JSON.parse(loggedString);

    expect(loggedData.user).toBe('alice');
    // Verify the secret was sanitized based on sanitizePayload behavior
    expect(loggedData['[REDACTED_KEY]']).toBeUndefined();
    expect(loggedData.token).toContain('[REDACTED]');
    expect(loggedData.token).not.toContain('xoxb-1234567890');
  });

  it('handles empty fields gracefully', () => {
    slog('test-scope', 'test-event', null);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const loggedString = consoleSpy.mock.calls[0][0];
    const loggedData = JSON.parse(loggedString);

    expect(loggedData.scope).toBe('test-scope');
    expect(loggedData.event).toBe('test-event');
  });

  it('handles non-object fields gracefully', () => {
    // Note: while fields are usually objects, it's possible strings are passed.
    // The implementation uses the spread operator (`...sanitized`), which
    // spreads the characters into numbered keys if it's a string, or does nothing if it's primitive.
    // This test ensures it doesn't crash.
    slog('test-scope', 'test-event', 'some string message');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});
