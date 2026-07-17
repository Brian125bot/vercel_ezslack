import type { Store } from 'express-rate-limit';
import { getRedisClient } from './redis.js';

type Hit = { totalHits: number; resetTime: Date | undefined };

// Degraded-mode fallback: when the KV/Redis client is unavailable, we keep a
// per-instance in-memory counter so requests still flow (rather than hard-failing)
// but explicitly log that distributed rate limiting is no longer active.
const fallbackHits = new Map<string, { count: number; resetTime: number }>();

export class KvRateLimitStore implements Store {
  prefix = 'rl:';
  // Shared (non-local) store: tells express-rate-limit this counter is not
  // per-process, which suppresses false double-count warnings.
  localKeys = false;
  windowMs!: number;
  // Tracks whether the store has degraded to the per-instance in-memory fallback
  // at runtime (e.g. Redis became unavailable). Used by /api/health reporting.
  degraded = false;

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  private sweepFallback(now: number): void {
    for (const [k, v] of fallbackHits) {
      if (v.resetTime <= now) fallbackHits.delete(k);
    }
  }

  private incrementFallback(key: string): Hit {
    const now = Date.now();
    this.sweepFallback(now);
    const existing = fallbackHits.get(key);
    if (existing && existing.resetTime > now) {
      existing.count += 1;
      return { totalHits: existing.count, resetTime: new Date(existing.resetTime) };
    }
    const resetTime = now + this.windowMs;
    fallbackHits.set(key, { count: 1, resetTime });
    return { totalHits: 1, resetTime: new Date(resetTime) };
  }

  async increment(key: string): Promise<Hit> {
    const client = await getRedisClient();
    if (!client) {
      if (!this.degraded) {
        console.warn('[RateLimit] KV unavailable: falling back to per-instance in-memory store (degraded mode)');
        this.degraded = true;
      }
      return this.incrementFallback(key);
    }
    if (this.degraded) {
      // Recovered: Redis is reachable again, leave degraded mode.
      this.degraded = false;
    }
    const redisKey = this.prefix + key;
    
    // Atomically create key with TTL for first hit using SET with NX and PX
    // This prevents race conditions between incr and pexpire
    const setResult = await client.set(redisKey, '1', { px: this.windowMs, nx: true });
    let total: number;
    
    if (setResult === 'OK') {
      // First hit - key created atomically with TTL
      total = 1;
    } else {
      // Key already exists, increment it
      total = await client.incr(redisKey);
    }
    
    // Get remaining TTL for resetTime calculation
    const pttl = await client.pttl(redisKey);
    
    // Handle unexpected state: key exists but has no TTL
    if (pttl === -1) {
      console.warn(`[RateLimit] Key ${redisKey} has no TTL - this is unexpected, resetting`);
      await client.pexpire(redisKey, this.windowMs);
    }
    
    // Compute resetTime from actual TTL or fallback to windowMs
    const resetTime = new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs));
    
    return { totalHits: total, resetTime };
  }

  async decrement(key: string): Promise<void> {
    const client = await getRedisClient();
    if (!client) {
      const entry = fallbackHits.get(key);
      if (entry) entry.count = Math.max(0, entry.count - 1);
      return;
    }
    await client.decr(this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    const client = await getRedisClient();
    if (!client) {
      fallbackHits.delete(key);
      return;
    }
    await client.del(this.prefix + key);
  }
}
