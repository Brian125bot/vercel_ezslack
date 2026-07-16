import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KvRateLimitStore } from '../src/server/rateLimitStore.js';

const createMockClient = () => {
  const store = new Map<string, { value: number; ttl: number | null }>();

  return {
    incr: vi.fn(async (key: string) => {
      const entry = store.get(key) || { value: 0, ttl: null };
      entry.value += 1;
      store.set(key, entry);
      return entry.value;
    }),
    pexpire: vi.fn(async (key: string, ms: number) => {
      const entry = store.get(key);
      if (entry) entry.ttl = ms;
    }),
    pttl: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry?.ttl ?? -2;
    }),
    decr: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (entry) entry.value = Math.max(0, entry.value - 1);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
};

let mockClient: ReturnType<typeof createMockClient>;

vi.mock('../src/server/redis.js', () => ({
  getRedisClient: vi.fn().mockImplementation(() => Promise.resolve(mockClient)),
}));

describe('KvRateLimitStore', () => {
  let store: KvRateLimitStore;

  const windowMs = 15 * 60 * 1000;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockClient = createMockClient();
    store = new KvRateLimitStore();
  });

  it('init should store windowMs', async () => {
    await store.init({ windowMs });
    expect(store.windowMs).toBe(windowMs);
  });

  it('increment should return totalHits: 1 on first hit', async () => {
    await store.init({ windowMs });
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it('increment should increment totalHits on subsequent hits', async () => {
    await store.init({ windowMs });
    await store.increment('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(2);
  });

  it('increment should set pexpire on first hit', async () => {
    await store.init({ windowMs });
    await store.increment('192.168.1.1');
    expect(mockClient.pexpire).toHaveBeenCalledWith('rl:192.168.1.1', windowMs);
  });

  it('decrement should decrease the counter', async () => {
    await store.init({ windowMs });
    await store.increment('192.168.1.1');
    await store.increment('192.168.1.1');
    await store.decrement('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(2);
  });

  it('resetKey should clear the counter', async () => {
    await store.init({ windowMs });
    await store.increment('192.168.1.1');
    await store.resetKey('192.168.1.1');
    const result = await store.increment('192.168.1.1');
    expect(result.totalHits).toBe(1);
  });

  it('increment should throw when KV client is unavailable', async () => {
    vi.doMock('../src/server/redis.js', () => ({
      getRedisClient: vi.fn().mockResolvedValue(null),
    }));
    const { KvRateLimitStore: KvRateLimitStore2 } = await import('../src/server/rateLimitStore.js');
    const noKvStore = new KvRateLimitStore2();
    await noKvStore.init({ windowMs });
    await expect(noKvStore.increment('192.168.1.1')).rejects.toThrow('KV rate-limit store unavailable');
  });
});
