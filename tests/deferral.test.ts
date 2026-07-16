import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectDeferral } from '../src/server/agent/deferral.js';

describe('deferral.ts - detectDeferral', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes unit shorthand to full names', () => {
    const fixedDate = new Date('2026-06-01T12:00:00.000Z');
    vi.setSystemTime(fixedDate);

    let res = detectDeferral('remind me in 5 m');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(5 * 60_000);
    expect(res.label).toBe('remind you in 5 minutes');

    res = detectDeferral('remind me in 2 h');
    expect(res.delayMs).toBe(2 * 60 * 60_000);
    expect(res.label).toBe('remind you in 2 hours');

    res = detectDeferral('remind me in 3 d');
    expect(res.delayMs).toBe(3 * 24 * 60 * 60_000);
    expect(res.label).toBe('remind you in 3 days');

    res = detectDeferral('remind me in 4 w');
    expect(res.delayMs).toBe(4 * 7 * 24 * 60 * 60_000);
    expect(res.label).toBe('remind you in 4 weeks');
  });

  it('detects remind me tomorrow and calculates tomorrow 9am correctly', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    vi.setSystemTime(now);

    const res = detectDeferral('remind me tomorrow');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(21 * 60 * 60_000);
    expect(res.label).toBe('remind you tomorrow');
  });

  it('detects follow up in X units', () => {
    const res = detectDeferral('follow up in 10 minutes');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(10 * 60_000);
    expect(res.label).toBe('follow up in 10 minutes');
  });

  it('detects follow up tomorrow', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    vi.setSystemTime(now);

    const res = detectDeferral('follow up tomorrow');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(21 * 60 * 60_000);
    expect(res.label).toBe('follow up tomorrow');
  });

  it('detects follow up next week', () => {
    const res = detectDeferral('follow up next week');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(7 * 24 * 60 * 60_000);
    expect(res.label).toBe('follow up next week');
  });

  it('detects schedule in X units', () => {
    const res = detectDeferral('schedule this in 1 hour');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(60 * 60_000);
    expect(res.label).toBe('scheduled in 1 hours');
  });

  it('detects schedule for tomorrow', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    vi.setSystemTime(now);

    const res = detectDeferral('schedule it for tomorrow');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(21 * 60 * 60_000);
    expect(res.label).toBe('scheduled for tomorrow');
  });

  it('detects schedule for next week', () => {
    const res = detectDeferral('schedule it for next week');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(7 * 24 * 60 * 60_000);
    expect(res.label).toBe('scheduled for next week');
  });

  it('detects bare in X units with action context', () => {
    const res = detectDeferral('ping me in 15 mins');
    expect(res.deferred).toBe(true);
    expect(res.delayMs).toBe(15 * 60_000);
    expect(res.label).toBe('deferred 15 minutes');
  });

  it('ignores bare in X units without action context', () => {
    const res = detectDeferral('I was born in 15 minutes of fame');
    expect(res.deferred).toBe(false);
  });
});
