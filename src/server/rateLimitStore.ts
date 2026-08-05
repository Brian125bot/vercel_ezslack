import type { Store } from 'express-rate-limit';
import { getRedisClient } from './redis.js';
import { slog } from './agent/log.js';

type Hit = { totalHits: number; resetTime: Date | undefined };

export class KvRateLimitStore implements Store {
  prefix = 'rl:';
  // Shared (non-local) store: tells express-rate-limit this counter is not
  // per-process, which suppresses false double-count warnings.
  localKeys = false;
  windowMs!: number;

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<Hit> {
    try {
      const client = await getRedisClient();
      if (!client) {
        slog('rate-limit', 'store_unreachable', {
          key,
          error: 'KV rate-limit store unavailable'
        });
        return {
          totalHits: 1,
          resetTime: new Date(Date.now() + (this.windowMs ?? 60_000))
        };
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
    } catch (error) {
      slog('rate-limit', 'store_unreachable', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        totalHits: 1,
        resetTime: new Date(Date.now() + (this.windowMs ?? 60_000))
      };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      const client = await getRedisClient();
      if (!client) {
        slog('rate-limit', 'decrement_failed', {
          key,
          error: 'KV store unavailable for decrement'
        });
        return;
      }
      await client.decr(this.prefix + key);
    } catch (error) {
      slog('rate-limit', 'decrement_failed', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      const client = await getRedisClient();
      if (!client) {
        slog('rate-limit', 'reset_failed', {
          key,
          error: 'KV store unavailable for resetKey'
        });
        return;
      }
      await client.del(this.prefix + key);
    } catch (error) {
      slog('rate-limit', 'reset_failed', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
