import { describe, it, expect } from 'vitest';
import { detectDeferral } from '../src/server/agent/deferral.js';

describe('Time-Deferred Detection (W4-F1)', () => {
  describe('remind me patterns', () => {
    it('detects "remind me tomorrow"', () => {
      const r = detectDeferral('remind me tomorrow to check the deploy');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBeGreaterThan(0);
      // Should be less than 24h + a small buffer
      expect(r.delayMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
      expect(r.label).toContain('tomorrow');
    });

    it('detects "remind me in 30 minutes"', () => {
      const r = detectDeferral('remind me in 30 minutes');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(30 * 60 * 1000);
      expect(r.label).toContain('30');
    });

    it('detects "remind me in 2 hours"', () => {
      const r = detectDeferral('remind me in 2 hours to review the PR');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(2 * 60 * 60 * 1000);
    });

    it('detects "remind me in 3 days"', () => {
      const r = detectDeferral('remind me in 3 days about the release');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(3 * 24 * 60 * 60 * 1000);
    });

    it('detects "remind me in 1 week"', () => {
      const r = detectDeferral('remind me in 1 week');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('follow up patterns', () => {
    it('detects "follow up in 2 hours"', () => {
      const r = detectDeferral('follow up in 2 hours on the PR');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(2 * 60 * 60 * 1000);
    });

    it('detects "follow up tomorrow"', () => {
      const r = detectDeferral('follow up tomorrow on the deployment');
      expect(r.deferred).toBe(true);
      expect(r.label).toContain('tomorrow');
    });

    it('detects "follow up next week"', () => {
      const r = detectDeferral('follow up next week');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(7 * 24 * 60 * 60 * 1000);
      expect(r.label).toContain('next week');
    });
  });

  describe('schedule patterns', () => {
    it('detects "schedule this for tomorrow"', () => {
      const r = detectDeferral('schedule this for tomorrow');
      expect(r.deferred).toBe(true);
      expect(r.label).toContain('tomorrow');
    });

    it('detects "schedule it for next week"', () => {
      const r = detectDeferral('schedule it for next week');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('non-deferred messages (no false positives)', () => {
    it('does NOT flag normal durable tasks', () => {
      const r = detectDeferral('summarize this thread');
      expect(r.deferred).toBe(false);
    });

    it('does NOT flag past-time references', () => {
      const r = detectDeferral('what happened yesterday');
      expect(r.deferred).toBe(false);
    });

    it('does NOT flag "in" without action context', () => {
      const r = detectDeferral('I am interested in 3 days of vacation');
      expect(r.deferred).toBe(false);
    });

    it('does NOT flag questions about time', () => {
      const r = detectDeferral('how long will this take in hours');
      expect(r.deferred).toBe(false);
    });

    it('does NOT flag "cancel my task"', () => {
      const r = detectDeferral('cancel my task');
      expect(r.deferred).toBe(false);
    });
  });

  describe('unit normalization', () => {
    it('handles "mins" shorthand', () => {
      const r = detectDeferral('remind me in 15 mins');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(15 * 60 * 1000);
    });

    it('handles "hrs" shorthand', () => {
      const r = detectDeferral('remind me in 4 hrs');
      expect(r.deferred).toBe(true);
      expect(r.delayMs).toBe(4 * 60 * 60 * 1000);
    });
  });
});
