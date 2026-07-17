import { Redis } from '@upstash/redis';

type RedisClient = InstanceType<typeof Redis>;

let redisClient: RedisClient | null = null;

export function isRedisConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
         !!(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
}

export async function getRedisClient(): Promise<RedisClient | null> {
  if (redisClient) return redisClient;
  
  if (!isRedisConfigured()) {
    return null;
  }
  
  try {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!url || !token) {
      return null;
    }
    
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (error) {
    console.warn('[Redis] Failed to initialize Redis client:', error);
    return null;
  }
}

export async function getRedisValue(key: string): Promise<string | null> {
  const client = await getRedisClient();
  if (!client) return null;
  
  try {
    const result = await client.get(key);
    return result as string | null;
  } catch (error) {
    console.warn('[Redis] Failed to get value:', error);
    return null;
  }
}

export async function setRedisValue(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;
  
  try {
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, value);
    } else {
      await client.set(key, value);
    }
    return true;
  } catch (error) {
    console.warn('[Redis] Failed to set value:', error);
    return false;
  }
}

export async function setRedisValueNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const result = await client.set(key, value, { ex: ttlSeconds, nx: true });
    return result === 'OK';
  } catch (error) {
    console.warn('[Redis] Failed to set NX value:', error);
    return false;
  }
}

export async function getRedisJson<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const raw = await client.get(key);
    if (raw == null) return null;
    return JSON.parse(raw as string) as T;
  } catch (error) {
    console.warn('[Redis] Failed to get JSON:', error);
    return null;
  }
}

export async function setRedisJson(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, serialized);
    } else {
      await client.set(key, serialized);
    }
    return true;
  } catch (error) {
    console.warn('[Redis] Failed to set JSON:', error);
    return false;
  }
}

export async function del(key: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  try {
    await client.del(key);
  } catch (error) {
    console.warn('[Redis] Failed to delete key:', error);
  }
}

const AUTH_FAILURE_TTL_SECONDS = 15 * 60;

function authFailuresKey(ip: string): string {
  return `auth:failures:${ip}`;
}

function authLockoutKey(ip: string): string {
  return `auth:lockout:${ip}`;
}

export async function recordAuthFailure(ip: string): Promise<number> {
  const client = await getRedisClient();
  if (!client) return 0;

  const key = authFailuresKey(ip);
  try {
    // Atomically create the counter with a TTL on the first failure so the
    // 15-minute window is anchored to when failures began (not reset on each
    // failure). Subsequent failures within the window increment the counter.
    const setResult = await client.set(key, '1', { ex: AUTH_FAILURE_TTL_SECONDS, nx: true });
    if (setResult === 'OK') {
      return 1;
    }
    return await client.incr(key);
  } catch (error) {
    console.warn('[Redis] Failed to record auth failure:', error);
    return 0;
  }
}

export async function isAuthLockedOut(ip: string): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const ttl = await client.ttl(authLockoutKey(ip));
    return ttl > 0;
  } catch (error) {
    console.warn('[Redis] Failed to check auth lockout:', error);
    return false;
  }
}

export async function lockoutAuth(ip: string, durationMs: number = 15 * 60 * 1000): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(authLockoutKey(ip), '1', { px: durationMs });
  } catch (error) {
    console.warn('[Redis] Failed to set auth lockout:', error);
  }
}

export async function resetAuthFailures(ip: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.del(authFailuresKey(ip), authLockoutKey(ip));
  } catch (error) {
    console.warn('[Redis] Failed to reset auth failures:', error);
  }
}
