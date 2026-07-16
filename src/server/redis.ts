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
    return result;
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