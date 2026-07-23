import crypto from 'crypto';
import { slog } from './log.js';

const SIMILARITY_THRESHOLD = parseFloat(process.env.SLACK_DEDUP_SIMILARITY_THRESHOLD || '0.75');
const WINDOW_SIZE = parseInt(process.env.SLACK_DEDUP_WINDOW_SIZE || '5');
const TTL_SECONDS = parseInt(process.env.SLACK_DEDUP_TTL_SECONDS || '300');

export interface StoredFingerprint {
  h: string;      // SHA-256 hex of normalized text (first 16 chars for compactness)
  b: number[];    // Array of bigram hashes (32-bit integers)
  t: number;      // Timestamp
}

// In-memory LRU fallback (Map with periodic pruning)
const memoryStore = new Map<string, StoredFingerprint[]>();
const MAX_MEMORY_ENTRIES = 500;

// ── Fingerprinting ──

export function tokenize(text: string): string[] {
  // Lowercase, split on non-alphanumeric, filter empty, min length 1 char
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 0);
}

export function bigrams(words: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    result.push(words[i] + ' ' + words[i + 1]);
  }
  return result;
}

// FNV-1a 32-bit hash of a string (fast, deterministic, no crypto dependency)
export function fnv1a32(s: string): number {
  let hash = 0x811c9dc5; // FNV offset
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // unsigned 32-bit
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function computeFingerprint(text: string): StoredFingerprint {
  const normalized = text.trim().toLowerCase();
  const words = tokenize(normalized);
  const bg = bigrams(words);
  // Deduplicate bigrams before hashing (set semantics for Jaccard)
  const uniqueBigrams = [...new Set(bg)];
  return {
    h: sha256(normalized),
    b: uniqueBigrams.map(fnv1a32),
    t: Date.now()
  };
}

// ── Similarity ──

export function jaccardSimilarity(a: number[], b: number[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;  // both empty
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const v of setA) {
    if (setB.has(v)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

// ── Storage ──

const redisKey = (channelId: string, threadTs: string) =>
  `dedup:thread:${channelId}:${threadTs}`;

async function loadFingerprints(channelId: string, threadTs: string): Promise<StoredFingerprint[]> {
  try {
    const { getRedisJson } = await import('../redis.js');
    const stored = await getRedisJson<StoredFingerprint[]>(redisKey(channelId, threadTs));
    if (Array.isArray(stored)) return stored;
  } catch (error: any) {
    slog('dedup', 'redis_error', { operation: 'loadFingerprints', error: error?.message || error });
  }

  // In-memory fallback
  const key = redisKey(channelId, threadTs);
  const cached = memoryStore.get(key);
  if (cached && Array.isArray(cached)) {
    // Evict expired entries
    const now = Date.now();
    return cached.filter(f => now - f.t < TTL_SECONDS * 1000);
  }
  return [];
}

async function storeFingerprints(
  channelId: string,
  threadTs: string,
  fingerprints: StoredFingerprint[]
): Promise<void> {
  try {
    const { setRedisJson } = await import('../redis.js');
    await setRedisJson(redisKey(channelId, threadTs), fingerprints, TTL_SECONDS);
    return;
  } catch (error: any) {
    slog('dedup', 'redis_error', { operation: 'storeFingerprints', error: error?.message || error });
  }

  // In-memory fallback
  const key = redisKey(channelId, threadTs);
  memoryStore.set(key, fingerprints);
  // Prune if too many entries
  if (memoryStore.size > MAX_MEMORY_ENTRIES) {
    const oldest = [...memoryStore.keys()].slice(0, 50);
    for (const k of oldest) memoryStore.delete(k);
  }
}

// ── Public API ──

/**
 * Check if `text` is too similar to a recent message in the same thread.
 * Does NOT store the fingerprint — call storeMessageFingerprint after posting.
 */
export async function isNearDuplicate(
  text: string,
  channelId: string,
  threadTs: string
): Promise<boolean> {
  const fp = computeFingerprint(text);
  const existing = await loadFingerprints(channelId, threadTs);

  // Guard for extremely short messages: if < 3 bigrams (i.e. < 4 words),
  // fall back to exact-hash check only.
  if (fp.b.length < 3) {
    return existing.some(prev => prev.h === fp.h);
  }

  for (const prev of existing) {
    // Quick exact-hash short-circuit
    if (prev.h === fp.h) return true;
    const sim = jaccardSimilarity(fp.b, prev.b);
    if (sim >= SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

/**
 * Store a message fingerprint for future dedup checks.
 * Call AFTER successfully posting to Slack.
 */
export async function storeMessageFingerprint(
  text: string,
  channelId: string,
  threadTs: string
): Promise<void> {
  const fp = computeFingerprint(text);
  const existing = await loadFingerprints(channelId, threadTs);
  existing.unshift(fp);
  // Keep only the most recent WINDOW_SIZE
  const trimmed = existing.slice(0, WINDOW_SIZE);
  await storeFingerprints(channelId, threadTs, trimmed);
}
