import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tokenize,
  bigrams,
  fnv1a32,
  sha256,
  computeFingerprint,
  jaccardSimilarity,
  isNearDuplicate,
  storeMessageFingerprint
} from '../src/server/agent/dedup.js';

const mockRedis = vi.hoisted(() => ({
  getRedisJson: vi.fn(),
  setRedisJson: vi.fn(),
}));

vi.mock('../src/server/redis.js', () => ({
  getRedisJson: mockRedis.getRedisJson,
  setRedisJson: mockRedis.setRedisJson,
  isRedisConfigured: () => true,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Deduplication Module - Fingerprinting & Tokenization', () => {
  it('tokenize: converts to lowercase, splits on non-alphanumeric, and filters empty tokens', () => {
    const text = 'Hello, World! This is a test... 123.';
    const tokens = tokenize(text);
    expect(tokens).toEqual(['hello', 'world', 'this', 'is', 'a', 'test', '123']);
  });

  it('tokenize: handles empty strings and pure non-alphanumeric text gracefully', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!!   $$$')).toEqual([]);
  });

  it('bigrams: generates correct bigram pairings', () => {
    const words = ['quick', 'brown', 'fox', 'jumps'];
    expect(bigrams(words)).toEqual([
      'quick brown',
      'brown fox',
      'fox jumps'
    ]);
  });

  it('bigrams: returns empty array for fewer than 2 words', () => {
    expect(bigrams(['hello'])).toEqual([]);
    expect(bigrams([])).toEqual([]);
  });

  it('fnv1a32: produces consistent, deterministic unsigned 32-bit integer hashes', () => {
    const hash1 = fnv1a32('hello');
    const hash2 = fnv1a32('hello');
    const hash3 = fnv1a32('world');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(Number.isInteger(hash1)).toBe(true);
    expect(hash1).toBeGreaterThanOrEqual(0);
  });

  it('sha256: produces exact 16-character SHA-256 hash digests', () => {
    const hash = sha256('test text');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('computeFingerprint: creates a valid StoredFingerprint object', () => {
    const text = 'Quick brown fox jumps.';
    const fp = computeFingerprint(text);

    expect(fp).toHaveProperty('h');
    expect(fp).toHaveProperty('b');
    expect(fp).toHaveProperty('t');
    expect(fp.b).toHaveLength(3); // 'quick brown', 'brown fox', 'fox jumps'
    expect(typeof fp.t).toBe('number');
  });
});

describe('Deduplication Module - Jaccard Similarity', () => {
  it('jaccardSimilarity: returns 1.0 for identical hash arrays', () => {
    const a = [100, 200, 300];
    const b = [100, 200, 300];
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it('jaccardSimilarity: returns 0.0 for disjoint hash arrays', () => {
    const a = [100, 200];
    const b = [300, 400];
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });

  it('jaccardSimilarity: returns correct partial overlap ratio', () => {
    // Union = {100, 200, 300, 400}, Intersection = {200, 300} -> 2/4 = 0.5
    const a = [100, 200, 300];
    const b = [200, 300, 400];
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it('jaccardSimilarity: handles empty inputs correctly', () => {
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity([100], [])).toBe(0);
    expect(jaccardSimilarity([], [100])).toBe(0);
  });
});

describe('Deduplication Module - Public API isNearDuplicate', () => {
  const channelId = 'C12345';
  const threadTs = '1672531199.000000';

  it('isNearDuplicate: returns false when no prior fingerprints are stored', async () => {
    mockRedis.getRedisJson.mockResolvedValueOnce(null);

    const isDup = await isNearDuplicate('This is a completely fresh and new message to Slack.', channelId, threadTs);
    expect(isDup).toBe(false);
  });

  it('isNearDuplicate: returns true for identical text (exact-hash check short-circuit)', async () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const fp = computeFingerprint(text);
    mockRedis.getRedisJson.mockResolvedValueOnce([fp]);

    const isDup = await isNearDuplicate(text, channelId, threadTs);
    expect(isDup).toBe(true);
  });

  it('isNearDuplicate: returns true for semantically very similar text above 0.75 threshold', async () => {
    const text1 = 'The 2026 World Cup was won by Spain after defeating Argentina.';
    const text2 = '2026 World Cup was won by Spain after defeating Argentina.';

    const fp1 = computeFingerprint(text1);
    mockRedis.getRedisJson.mockResolvedValueOnce([fp1]);

    const isDup = await isNearDuplicate(text2, channelId, threadTs);
    expect(isDup).toBe(true);
  });

  it('isNearDuplicate: returns false for completely different content', async () => {
    const text1 = 'The 2026 World Cup was won by Spain after defeating Argentina.';
    const text2 = 'The weather in London is quite rainy today, with a high of fifteen degrees.';

    const fp1 = computeFingerprint(text1);
    mockRedis.getRedisJson.mockResolvedValueOnce([fp1]);

    const isDup = await isNearDuplicate(text2, channelId, threadTs);
    expect(isDup).toBe(false);
  });

  it('isNearDuplicate: short-message guard falls back to exact-hash check only', async () => {
    // "Done." has 1 word -> 0 bigrams (< 3)
    const text = 'Done.';
    const fp = computeFingerprint(text);

    // Create a stored list with "Done." and another slightly similar short text like "Undone."
    mockRedis.getRedisJson.mockResolvedValueOnce([fp]);

    // Same text should match exactly
    expect(await isNearDuplicate('Done.', channelId, threadTs)).toBe(true);

    // Slightly different text like "Done" should not match because bigram count < 3 so no Jaccard comparison runs
    mockRedis.getRedisJson.mockResolvedValueOnce([fp]);
    expect(await isNearDuplicate('Done!', channelId, threadTs)).toBe(false);
  });

  it('isNearDuplicate: falls back gracefully to in-memory store when Redis throws', async () => {
    // Mock Redis JSON methods to throw
    mockRedis.getRedisJson.mockRejectedValue(new Error('Redis connection lost'));
    mockRedis.setRedisJson.mockRejectedValue(new Error('Redis connection lost'));

    const text = 'This is a test message to verify the in memory fallback mechanism.';

    // Store it
    await storeMessageFingerprint(text, channelId, threadTs);

    // Query it - should catch Redis error and successfully query in-memory store
    const isDup = await isNearDuplicate(text, channelId, threadTs);
    expect(isDup).toBe(true);
  });
});
