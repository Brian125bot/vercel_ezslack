import { createIntentHash, isIntentProcessing, setIntentDedup, markIntentComplete } from '../src/server/state.js';

vi.mock('../src/server/redis.js', () => ({
  getRedisValue: vi.fn(),
  setRedisValueNX: vi.fn(),
  del: vi.fn(),
}));

import { getRedisValue, setRedisValueNX, del } from '../src/server/redis.js';

describe('Intent-based deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createIntentHash', () => {
    it('should create a consistent hash from message context', () => {
      const result1 = createIntentHash('Hello world', 'C123', 'U456', '1234567890.001');
      const result2 = createIntentHash('Hello world', 'C123', 'U456', '1234567890.001');

      expect(result1).toBe(result2);
      expect(result1).toHaveLength(64);
    });

    it('should create different hashes for different inputs', () => {
      const result1 = createIntentHash('Hello world', 'C123', 'U456');
      const result2 = createIntentHash('Hello there', 'C123', 'U456');

      expect(result1).not.toBe(result2);
    });

    it('should trim and lowercase input for consistency', () => {
      const result1 = createIntentHash('  Hello World  ', 'C123', 'U456');
      const result2 = createIntentHash('hello world', 'C123', 'U456');

      expect(result1).toBe(result2);
    });

    it('should truncate long messages consistently', () => {
      const longMessage = 'a'.repeat(1000);
      const result1 = createIntentHash(longMessage, 'C123', 'U456');
      const result2 = createIntentHash(longMessage + ' extra text', 'C123', 'U456');

      expect(result1).toBe(result2);
    });

    it('should produce different hashes for different channels', () => {
      const result1 = createIntentHash('Hello world', 'C111', 'U456');
      const result2 = createIntentHash('Hello world', 'C222', 'U456');

      expect(result1).not.toBe(result2);
    });

    it('should produce different hashes for different users', () => {
      const result1 = createIntentHash('Hello world', 'C123', 'U111');
      const result2 = createIntentHash('Hello world', 'C123', 'U222');

      expect(result1).not.toBe(result2);
    });

    it('should handle empty message text', () => {
      const result = createIntentHash('', 'C123', 'U456');

      expect(result).toHaveLength(64);
    });
  });

  describe('isIntentProcessing', () => {
    it('should return true when intent is being processed', async () => {
      vi.mocked(getRedisValue).mockResolvedValue('1');

      const result = await isIntentProcessing('some-hash');

      expect(result).toBe(true);
      expect(getRedisValue).toHaveBeenCalledWith('dedup:intent:some-hash');
    });

    it('should return false when intent is not being processed', async () => {
      vi.mocked(getRedisValue).mockResolvedValue(null);

      const result = await isIntentProcessing('some-hash');

      expect(result).toBe(false);
    });

    it('should use custom TTL window in key', async () => {
      vi.mocked(getRedisValue).mockResolvedValue(null);

      await isIntentProcessing('test-hash', 600);

      expect(getRedisValue).toHaveBeenCalledWith('dedup:intent:test-hash');
    });
  });

  describe('setIntentDedup', () => {
    it('should return true when lock is acquired', async () => {
      vi.mocked(setRedisValueNX).mockResolvedValue(true);

      const result = await setIntentDedup('some-hash');

      expect(result).toBe(true);
      expect(setRedisValueNX).toHaveBeenCalledWith('dedup:intent:some-hash', '1', 300);
    });

    it('should return false when lock already exists', async () => {
      vi.mocked(setRedisValueNX).mockResolvedValue(false);

      const result = await setIntentDedup('some-hash');

      expect(result).toBe(false);
    });

    it('should pass custom window seconds to Redis', async () => {
      vi.mocked(setRedisValueNX).mockResolvedValue(true);

      await setIntentDedup('test-hash', 600);

      expect(setRedisValueNX).toHaveBeenCalledWith('dedup:intent:test-hash', '1', 600);
    });
  });

  describe('markIntentComplete', () => {
    it('should delete the dedup key and set a completion marker', async () => {
      vi.mocked(del).mockResolvedValue(undefined);
      vi.mocked(setRedisValueNX).mockResolvedValue(true);

      await markIntentComplete('some-hash');

      expect(del).toHaveBeenCalledWith('dedup:intent:some-hash');
      expect(setRedisValueNX).toHaveBeenCalledWith('dedup:intent:completed:some-hash', '1', 120);
    });

    it('should use custom window seconds for completion marker', async () => {
      vi.mocked(del).mockResolvedValue(undefined);
      vi.mocked(setRedisValueNX).mockResolvedValue(true);

      await markIntentComplete('test-hash', 300);

      expect(setRedisValueNX).toHaveBeenCalledWith('dedup:intent:completed:test-hash', '1', 300);
    });
  });
});
