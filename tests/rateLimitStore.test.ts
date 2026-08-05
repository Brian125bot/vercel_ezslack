import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRedisClient } from '../src/server/redis.js';
import { KvRateLimitStore } from '../src/server/rateLimitStore.js';
import { slog } from '../src/server/agent/log.js';

// Mock log module to spy on slog
vi.mock('../src/server/agent/log.js', () => ({
  slog: vi.fn(),
}));

// Use vi.hoisted to define mock client before vi.mock runs
const { mockStore, mockClient } = vi.hoisted(() => {
  const store = new Map<string, { value: number; ttl: number | null }>();

  const client = {
    incr: vi.fn(async (key: string) => {
      const entry = store.get(key) || { value: 0, ttl: null };
      entry.value += 1;
      store.set(key, entry);
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string, options?: { nx: boolean; px?: number }) => {
      const entry = store.get(key);
      if (options?.nx && entry) return null;
      const entryValue = { value: parseInt(value, 10), ttl: options?.px ?? null };
      store.set(key, entryValue);
      return 'OK';
    }),
    pexpire: vi.fn(async (key: string, ms: number) => {
      const entry = store.get(key);
      if (entry) entry.ttl = ms;
    }),
    pttl: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return -2;
      if (entry.ttl === null) return -1;
      return entry.ttl;
    }),
    decr: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (entry) entry.value = Math.max(0, entry.value - 1);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  return { mockStore: store, mockClient: client };
});

// Mock the redis module
vi.mock('../src/server/redis.js', () => ({
  getRedisClient: vi.fn().mockResolvedValue(mockClient),
}));

describe('KvRateLimitStore', () => {
  let store: KvRateLimitStore;
  const windowMs = 15 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
    store = new KvRateLimitStore();
    store.init({ windowMs });
  });

  it('init should store windowMs synchronously', () => {
    const result = store.init({ windowMs });
    expect(result).toBeUndefined();
    expect(store.windowMs).toBe(windowMs);
  });

  it('increment should return totalHits: 1 on first hit', async () => {
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it('increment should increment totalHits on subsequent hits', async () => {
    await store.increment('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(2);
  });

  it('increment should set key atomically with TTL on first hit', async () => {
    await store.increment('192.168.1.1');
    expect(mockClient.set).toHaveBeenCalledWith('rl:192.168.1.1', '1', {
      px: windowMs,
      nx: true,
    });
  });

  it('increment should call incr for subsequent hits', async () => {
    await store.increment('192.168.1.1');
    await store.increment('192.168.1.1');
    expect(mockClient.incr).toHaveBeenCalledWith('rl:192.168.1.1');
  });

  it('increment should handle pttl === -1 by resetting TTL', async () => {
    let callCount = 0;
    const originalPttl = mockClient.pttl;
    mockClient.pttl = vi.fn(async (key: string) => {
      callCount++;
      return callCount === 1 ? -1 : windowMs;
    });

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    await store.increment('192.168.1.1');
    
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has no TTL')
    );
    expect(mockClient.pexpire).toHaveBeenCalledWith('rl:192.168.1.1', windowMs);
    
    mockClient.pttl = originalPttl;
  });

  it('decrement should decrease the counter', async () => {
    await store.increment('192.168.1.1');
    await store.increment('192.168.1.1');
    await store.decrement('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(2);
  });

  it('resetKey should clear the counter', async () => {
    await store.increment('192.168.1.1');
    await store.resetKey('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(1);
  });

  // Updated Task 12: KV unavailable test - increment must NOT throw but fail-open gracefully with slog and safe default
  it('increment should fail-open when KV client is unavailable (null)', async () => {
    const getRedisClientMock = vi.mocked(getRedisClient);
    getRedisClientMock.mockResolvedValueOnce(null);

    const result = await store.increment('192.168.1.1');

    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(result.resetTime!.getTime()).toBeGreaterThanOrEqual(Date.now() + windowMs - 1000);

    expect(slog).toHaveBeenCalledWith('rate-limit', 'store_unreachable', {
      key: '192.168.1.1',
      error: 'KV rate-limit store unavailable'
    });
  });

  // New fail-open on network/runtime errors test
  it('increment should fail-open when Redis operation throws a network exception', async () => {
    mockClient.set.mockRejectedValueOnce(new Error('Connection timed out'));

    const result = await store.increment('192.168.1.1');

    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(result.resetTime!.getTime()).toBeGreaterThanOrEqual(Date.now() + windowMs - 1000);

    expect(slog).toHaveBeenCalledWith('rate-limit', 'store_unreachable', {
      key: '192.168.1.1',
      error: 'Connection timed out'
    });
  });

  // New fail-safe on decrement() test
  it('decrement should fail gracefully without bubbling rejections when exception is thrown', async () => {
    mockClient.decr.mockRejectedValueOnce(new Error('Redis connection lost'));

    await expect(store.decrement('192.168.1.1')).resolves.toBeUndefined();

    expect(slog).toHaveBeenCalledWith('rate-limit', 'decrement_failed', {
      key: '192.168.1.1',
      error: 'Redis connection lost'
    });
  });

  // New fail-safe on resetKey() test
  it('resetKey should fail gracefully without bubbling rejections when exception is thrown', async () => {
    mockClient.del.mockRejectedValueOnce(new Error('Redis server error'));

    await expect(store.resetKey('192.168.1.1')).resolves.toBeUndefined();

    expect(slog).toHaveBeenCalledWith('rate-limit', 'reset_failed', {
      key: '192.168.1.1',
      error: 'Redis server error'
    });
  });

  it('increment should produce distinct totals across concurrent first hits', async () => {
    mockStore.clear();

    const results = await Promise.all([
      store.increment('concurrent-key'),
      store.increment('concurrent-key'),
      store.increment('concurrent-key'),
    ]);

    const totalHitsValues = results.map(r => r.totalHits).sort((a, b) => a - b);
    expect(totalHitsValues).toEqual([1, 2, 3]);
  });
});
