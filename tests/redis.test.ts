import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedisInstance = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
  incr: vi.fn(),
  ttl: vi.fn(),
  del: vi.fn(),
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

const KV_ENV = () => {
  process.env.KV_REST_API_URL = 'https://example.com';
  process.env.KV_REST_API_TOKEN = 'token123';
};

describe('recordAuthFailure', () => {
  it('creates the counter with a 15min TTL on the first failure and returns 1', async () => {
    KV_ENV();
    mockRedisInstance.set.mockResolvedValue('OK');
    const { recordAuthFailure } = await import('../src/server/redis.js');
    const count = await recordAuthFailure('1.2.3.4');
    expect(count).toBe(1);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('auth:failures:1.2.3.4', '1', {
      ex: 15 * 60,
      nx: true,
    });
    expect(mockRedisInstance.incr).not.toHaveBeenCalled();
  });

  it('increments an existing counter and returns the new count', async () => {
    KV_ENV();
    mockRedisInstance.set.mockResolvedValue(null); // NX failed, key exists
    mockRedisInstance.incr.mockResolvedValue(4);
    const { recordAuthFailure } = await import('../src/server/redis.js');
    const count = await recordAuthFailure('1.2.3.4');
    expect(count).toBe(4);
    expect(mockRedisInstance.incr).toHaveBeenCalledWith('auth:failures:1.2.3.4');
  });

  it('returns 0 when Redis is not configured', async () => {
    const { recordAuthFailure } = await import('../src/server/redis.js');
    expect(await recordAuthFailure('1.2.3.4')).toBe(0);
  });

  it('returns 0 and warns on error', async () => {
    KV_ENV();
    mockRedisInstance.set.mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recordAuthFailure } = await import('../src/server/redis.js');
    expect(await recordAuthFailure('1.2.3.4')).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('isAuthLockedOut', () => {
  it('returns true when the lockout key has a positive TTL', async () => {
    KV_ENV();
    mockRedisInstance.ttl.mockResolvedValue(600);
    const { isAuthLockedOut } = await import('../src/server/redis.js');
    expect(await isAuthLockedOut('1.2.3.4')).toBe(true);
    expect(mockRedisInstance.ttl).toHaveBeenCalledWith('auth:lockout:1.2.3.4');
  });

  it('returns false when the key is missing (ttl -2)', async () => {
    KV_ENV();
    mockRedisInstance.ttl.mockResolvedValue(-2);
    const { isAuthLockedOut } = await import('../src/server/redis.js');
    expect(await isAuthLockedOut('1.2.3.4')).toBe(false);
  });

  it('returns false when Redis is not configured', async () => {
    const { isAuthLockedOut } = await import('../src/server/redis.js');
    expect(await isAuthLockedOut('1.2.3.4')).toBe(false);
  });

  it('returns false and warns on error', async () => {
    KV_ENV();
    mockRedisInstance.ttl.mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { isAuthLockedOut } = await import('../src/server/redis.js');
    expect(await isAuthLockedOut('1.2.3.4')).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('lockoutAuth', () => {
  it('sets the lockout key with the default 15min PX TTL', async () => {
    KV_ENV();
    mockRedisInstance.set.mockResolvedValue('OK');
    const { lockoutAuth } = await import('../src/server/redis.js');
    await lockoutAuth('1.2.3.4');
    expect(mockRedisInstance.set).toHaveBeenCalledWith('auth:lockout:1.2.3.4', '1', {
      px: 15 * 60 * 1000,
    });
  });

  it('honors a custom duration', async () => {
    KV_ENV();
    mockRedisInstance.set.mockResolvedValue('OK');
    const { lockoutAuth } = await import('../src/server/redis.js');
    await lockoutAuth('1.2.3.4', 1000);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('auth:lockout:1.2.3.4', '1', { px: 1000 });
  });

  it('no-ops when Redis is not configured', async () => {
    const { lockoutAuth } = await import('../src/server/redis.js');
    await lockoutAuth('1.2.3.4');
    expect(mockRedisInstance.set).not.toHaveBeenCalled();
  });
});

describe('resetAuthFailures', () => {
  it('deletes both the failures and lockout keys', async () => {
    KV_ENV();
    mockRedisInstance.del.mockResolvedValue(2);
    const { resetAuthFailures } = await import('../src/server/redis.js');
    await resetAuthFailures('1.2.3.4');
    expect(mockRedisInstance.del).toHaveBeenCalledWith(
      'auth:failures:1.2.3.4',
      'auth:lockout:1.2.3.4'
    );
  });

  it('no-ops when Redis is not configured', async () => {
    const { resetAuthFailures } = await import('../src/server/redis.js');
    await resetAuthFailures('1.2.3.4');
    expect(mockRedisInstance.del).not.toHaveBeenCalled();
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
