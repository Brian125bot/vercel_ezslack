import type { Store } from 'express-rate-limit';
import { getRedisClient } from './redis.js';

type Hit = { totalHits: number; resetTime: Date | undefined };

export class KvRateLimitStore implements Store {
  prefix = 'rl:';
  windowMs!: number;

  async init(options: { windowMs: number }): Promise<void> {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<Hit> {
    const client = await getRedisClient();
    if (!client) throw new Error('KV rate-limit store unavailable');
    const redisKey = this.prefix + key;
    const ttlSec = Math.ceil(this.windowMs / 1000);
    const total = await client.incr(redisKey);
    if (total === 1) {
      await client.pexpire(redisKey, this.windowMs);
    }
    const pttl = await client.pttl(redisKey);
    const resetTime = new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs));
    return { totalHits: total, resetTime };
  }

  async decrement(key: string): Promise<void> {
    const client = await getRedisClient();
    if (!client) return;
    await client.decr(this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    const client = await getRedisClient();
    if (!client) return;
    await client.del(this.prefix + key);
  }
}
