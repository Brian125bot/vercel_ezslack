import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRedisClient } from '../src/server/redis.js';
import { KvRateLimitStore } from '../src/server/rateLimitStore.js';

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

  // Task 13: Update tests for synchronous init
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

  // Task 10: Verify atomic set with nx+px
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

  // Task 11: Edge case for pttl === -1
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

  // Task 12: KV unavailable test - increment must throw when getRedisClient() returns null (fail-closed)
  it('increment should throw when KV client is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../src/server/redis.js', () => ({
      getRedisClient: vi.fn().mockResolvedValue(null),
    }));
    const { KvRateLimitStore: KvRateLimitStoreNull } = await import('../src/server/rateLimitStore.js');
    const nullStore = new KvRateLimitStoreNull();
    nullStore.init({ windowMs });
    await expect(nullStore.increment('192.168.1.1')).rejects.toThrow('KV rate-limit store unavailable');
  });

  // Task 14: Concurrency test
  // Verifies the first-hit-then-incr path never loses counts. A single-threaded
  // mock cannot truly simulate Redis SET NX atomicity, so we assert the resulting
  // totals cover 1..N (proving no double-count and no lost increment). The actual
  // atomicity guarantee comes from the real Redis `SET key 1 NX PX` command.
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