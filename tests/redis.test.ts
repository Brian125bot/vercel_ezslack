import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedisInstance = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => mockRedisInstance),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isRedisConfigured', () => {
  it('returns true when Vercel KV env vars are set', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    const { isRedisConfigured } = await import('../src/server/redis.js');
    expect(isRedisConfigured()).toBe(true);
  });

  it('returns true when Upstash env vars are set', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token123';
    const { isRedisConfigured } = await import('../src/server/redis.js');
    expect(isRedisConfigured()).toBe(true);
  });

  it('returns false when URL is missing', async () => {
    process.env.KV_REST_API_TOKEN = 'token123';
    const { isRedisConfigured } = await import('../src/server/redis.js');
    expect(isRedisConfigured()).toBe(false);
  });

  it('returns false when token is missing', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    const { isRedisConfigured } = await import('../src/server/redis.js');
    expect(isRedisConfigured()).toBe(false);
  });

  it('returns false when no env vars are set', async () => {
    const { isRedisConfigured } = await import('../src/server/redis.js');
    expect(isRedisConfigured()).toBe(false);
  });
});

describe('getRedisClient', () => {
  it('returns a Redis client when configured', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    const { getRedisClient } = await import('../src/server/redis.js');
    const client = await getRedisClient();
    expect(client).not.toBeNull();
  });

  it('returns null when not configured', async () => {
    const { getRedisClient } = await import('../src/server/redis.js');
    const client = await getRedisClient();
    expect(client).toBeNull();
  });

  it('returns singleton on repeated calls', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    const { getRedisClient } = await import('../src/server/redis.js');
    const a = await getRedisClient();
    const b = await getRedisClient();
    expect(a).toBe(b);
  });
});

describe('getRedisValue', () => {
  it('returns value when key exists', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockResolvedValue('hello');
    const { getRedisValue } = await import('../src/server/redis.js');
    const result = await getRedisValue('mykey');
    expect(result).toBe('hello');
    expect(mockRedisInstance.get).toHaveBeenCalledWith('mykey');
  });

  it('returns null when key is missing', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockResolvedValue(null);
    const { getRedisValue } = await import('../src/server/redis.js');
    const result = await getRedisValue('missing');
    expect(result).toBeNull();
  });

  it('returns null when Redis is not configured', async () => {
    const { getRedisValue } = await import('../src/server/redis.js');
    const result = await getRedisValue('any');
    expect(result).toBeNull();
  });

  it('returns null and warns on error', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockRejectedValue(new Error('timeout'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getRedisValue } = await import('../src/server/redis.js');
    const result = await getRedisValue('err');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('setRedisValue', () => {
  it('calls setex when TTL is provided', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.setex.mockResolvedValue('OK');
    const { setRedisValue } = await import('../src/server/redis.js');
    const result = await setRedisValue('k', 'v', 600);
    expect(result).toBe(true);
    expect(mockRedisInstance.setex).toHaveBeenCalledWith('k', 600, 'v');
  });

  it('calls set when no TTL', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockResolvedValue('OK');
    const { setRedisValue } = await import('../src/server/redis.js');
    const result = await setRedisValue('k', 'v');
    expect(result).toBe(true);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('k', 'v');
  });

  it('returns false on error', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockRejectedValue(new Error('fail'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setRedisValue } = await import('../src/server/redis.js');
    const result = await setRedisValue('k', 'v');
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  it('returns false when Redis is not configured', async () => {
    const { setRedisValue } = await import('../src/server/redis.js');
    const result = await setRedisValue('k', 'v');
    expect(result).toBe(false);
  });
});

describe('setRedisValueNX', () => {
  it('returns true when key was set (NX success)', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockResolvedValue('OK');
    const { setRedisValueNX } = await import('../src/server/redis.js');
    const result = await setRedisValueNX('lock', '1', 300);
    expect(result).toBe(true);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('lock', '1', { ex: 300, nx: true });
  });

  it('returns false when key already exists (NX fail)', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockResolvedValue(null);
    const { setRedisValueNX } = await import('../src/server/redis.js');
    const result = await setRedisValueNX('lock', '1', 300);
    expect(result).toBe(false);
  });

  it('returns false when Redis is not configured', async () => {
    const { setRedisValueNX } = await import('../src/server/redis.js');
    const result = await setRedisValueNX('lock', '1', 300);
    expect(result).toBe(false);
  });

  it('returns false on error', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockRejectedValue(new Error('fail'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setRedisValueNX } = await import('../src/server/redis.js');
    const result = await setRedisValueNX('lock', '1', 300);
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('getRedisJson', () => {
  it('returns parsed JSON when key exists', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockResolvedValue(JSON.stringify({ foo: [1, 2, 3] }));
    const { getRedisJson } = await import('../src/server/redis.js');
    const result = await getRedisJson<{ foo: number[] }>('obj');
    expect(result).toEqual({ foo: [1, 2, 3] });
  });

  it('returns null when raw value is null', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockResolvedValue(null);
    const { getRedisJson } = await import('../src/server/redis.js');
    const result = await getRedisJson('missing');
    expect(result).toBeNull();
  });

  it('returns null and warns on invalid JSON', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.get.mockResolvedValue('not-json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getRedisJson } = await import('../src/server/redis.js');
    const result = await getRedisJson('bad');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('setRedisJson', () => {
  it('serializes and stores with TTL', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.setex.mockResolvedValue('OK');
    const { setRedisJson } = await import('../src/server/redis.js');
    const data = { a: 1, b: [2, 3] };
    const result = await setRedisJson('k', data, 3600);
    expect(result).toBe(true);
    expect(mockRedisInstance.setex).toHaveBeenCalledWith('k', 3600, JSON.stringify(data));
  });

  it('serializes and stores without TTL', async () => {
    process.env.KV_REST_API_URL = 'https://example.com';
    process.env.KV_REST_API_TOKEN = 'token123';
    mockRedisInstance.set.mockResolvedValue('OK');
    const { setRedisJson } = await import('../src/server/redis.js');
    const result = await setRedisJson('k', { x: 'y' });
    expect(result).toBe(true);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('k', JSON.stringify({ x: 'y' }));
  });

  it('returns false when Redis is not configured', async () => {
    const { setRedisJson } = await import('../src/server/redis.js');
    const result = await setRedisJson('k', { x: 1 });
    expect(result).toBe(false);
  });
});

describe('environment variable priority', () => {
  it('uses KV_REST_API_* over UPSTASH_REDIS_REST_*', async () => {
    process.env.KV_REST_API_URL = 'https://kv.example.com';
    process.env.KV_REST_API_TOKEN = 'kv-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    const { getRedisClient } = await import('../src/server/redis.js');
    const client = await getRedisClient();
    expect(client).not.toBeNull();
  });
});
