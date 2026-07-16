# Rate Limiter Commit Review Guide

## Purpose

This document provides a structured framework for critiquing commit `feat(rate-limit): add KV-backed express-rate-limit store for Vercel` (and the underlying implementation in `src/server/rateLimitStore.ts`, `server.ts`, `.env.example`, and `tests/rateLimitStore.test.ts`). It is intended for code review, audit, or regression-testing purposes.

---

## 1. High-Level Goals of the Commit

### Problem Statement
The global API rate limiter in `server.ts` previously relied on `express-rate-limit`'s default in-memory `MemoryStore`. In a Vercel serverless deployment, each function instance has its own isolated memory. An attacker distributing requests across multiple cold-start instances could bypass the `max: 2000` requests / 15-minute window entirely, defeating the DoS control.

### Intended Solution
Replace the per-process memory counter with a shared counter backed by the project's existing Vercel KV (Upstash Redis) instance. When KV is unavailable (development, no linked KV, or misconfiguration), the code must fall back to the original in-memory behavior without breaking the server.

### Specific Objectives
1. **Shared counter across Vercel instances:** All serverless function invocations must increment/decrement the same Redis key so the limit is enforced globally.
2. **Reuse existing infrastructure:** Use the already-present `@upstash/redis` client exposed via `src/server/redis.ts` (`getRedisClient()`). Do **not** add `rate-limit-redis` or any new npm dependency.
3. **Fail-safe initialization:** `express-rate-limit` v8 calls `store.init()` synchronously at middleware construction. The custom store must not require an async resource (the Redis client) inside `init`. Redis client resolution must be deferred to `increment`, `decrement`, and `resetKey`.
4. **Key namespace isolation:** Limiter keys must use a prefix (`rl:`) that does not collide with existing `dedup:`, `thread:`, or `dedup:intent:` keys managed by `state.ts`.
5. **Environment-aware activation:** Enable the KV store only in production **and** only when KV environment variables are present. Otherwise `store: undefined` must preserve the built-in `MemoryStore` fallback.
6. **Documentation:** `.env.example` must document the KV variables already consumed by `redis.ts` and note their role in rate limiting.

---

## 2. Files Changed and Expected Behavior

| File | Expected Change |
|------|-----------------|
| `src/server/rateLimitStore.ts` | New file. Contains `KvRateLimitStore` implementing `express-rate-limit`'s `Store` interface. |
| `server.ts` | `apiLimiter` block replaced with conditional KV store instantiation. Import added for `KvRateLimitStore`. |
| `.env.example` | New Vercel KV section added explaining the shared variables. |
| `tests/rateLimitStore.test.ts` | New test file covering happy paths, TTL behavior, and KV-unavailable error path. |

---

## 3. Critique Instructions

When reviewing this commit, evaluate each dimension below independently. A failure in any **Required** dimension is a blocking issue.

### 3.1 Architecture & Design
- [ ] **Required:** Does the store implement the `Store` interface from `express-rate-limit` v8 (`init`, `increment`, `decrement`, `resetKey`)?
- [ ] **Required:** Is `init()` synchronous with respect to Redis client resolution? It must only capture `windowMs` and must NOT be `async` (no `await getRedisClient()` inside it).
- [ ] **Required:** Is the `rl:` key prefix used consistently for all Redis keys?
- [ ] **Required:** Does the store reuse `getRedisClient()` from `src/server/redis.js` instead of creating its own client?
- [ ] **Required:** Is there no new npm dependency introduced for the rate limiter?
- [ ] **Required:** Is the first hit implemented as an atomic `SET key '1' NX PX windowMs` (not a separate `incr` + `pexpire`), so there is no race between incrementing and setting the TTL?
- [ ] **Required:** On subsequent hits, does `increment` use `incr` (since the key already exists with its TTL)?
- [ ] **Required:** Is `resetTime` computed from `pttl` with a fallback to `windowMs` when `pttl <= 0`?
- [ ] **Recommended:** Does the store expose `localKeys: false` and/or `prefix: 'rl:'` to help `express-rate-limit`'s double-count detection?
- [ ] **Recommended:** Does `increment` defensively handle `pttl === -1` (key exists but lost its TTL) by re-applying `pexpire`?

### 3.2 server.ts Integration
- [ ] **Required:** Is the KV store instantiated only when `process.env.NODE_ENV === 'production'` **and** (`KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`) is present?
- [ ] **Required:** When KV is absent, is `store: undefined` passed to `rateLimit()` so the built-in `MemoryStore` is used?
- [ ] **Required:** Is there a `try/catch` around `new KvRateLimitStore()` with a console warning on failure?
- [ ] **Required:** Are the existing `windowMs`, `max`, `message`, `standardHeaders`, `legacyHeaders`, and `validate` options preserved unchanged?
- [ ] **Recommended:** Is the import path for `KvRateLimitStore` correct (`./src/server/rateLimitStore.js`) and consistent with the project's ESM `.js` extension convention?

### 3.3 .env.example Documentation
- [ ] **Required:** Is there a clearly labeled Vercel KV section?
- [ ] **Required:** Does it mention that `src/server/redis.ts` already reads these variables?
- [ ] **Required:** Does it note that Vercel injects these automatically when KV is linked?
- [ ] **Required:** Are the documented variable names (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) correct and consistent with `redis.ts`?

### 3.4 Testing
- [ ] **Required:** Does `tests/rateLimitStore.test.ts` mock `../src/server/redis.js` using `vi.mock` (not the real module)?
- [ ] **Required:** Does the test suite verify `init` stores `windowMs` (synchronously, returns `undefined`)?
- [ ] **Required:** Does the test suite verify `increment` returns `totalHits: 1` on the first call and increments on subsequent calls?
- [ ] **Required:** Does the test suite verify the first hit issues `SET key '1' NX PX windowMs` (atomic create with TTL)?
- [ ] **Required:** Does the test suite verify subsequent hits use `incr` (not a second `SET NX`)?
- [ ] **Required:** Does the test suite verify `decrement` and `resetKey` mutate the counter correctly?
- [ ] **Required:** Does the test suite verify `resetTime` is a `Date` in the future?
- [ ] **Required:** Does the test suite verify `increment` THROWS when `getRedisClient()` returns `null` (the fail-closed path)? This negative test must actually execute a rejection, not just a happy-path call.
- [ ] **Recommended:** Does the test suite cover concurrent first hits proving only one atomic `SET NX` wins (no double-count)?
- [ ] **Required:** Do the new tests pass in isolation (`npx vitest run tests/rateLimitStore.test.ts`)?
- [ ] **Recommended:** Are the mock Redis methods (`set`, `incr`, `pexpire`, `pttl`, `decr`, `del`) typed or structured to match the real `@upstash/redis` client API?

### 3.5 Type Safety & Lint
- [ ] **Required:** Does `npx tsc --noEmit` pass for `src/server/rateLimitStore.ts` and `server.ts`?
- [ ] **Required:** Does `KvRateLimitStore` satisfy the `Store` type without TypeScript errors (no missing methods, no incompatible signatures)?
- [ ] **Required:** Is there no `private` member on `KvRateLimitStore` that conflicts with the `Store` interface's optional `prefix` field?
- [ ] **Required:** Is `init` declared `void` (not `Promise<void>`) so it is genuinely synchronous? (The `Store` interface allows `void | Promise<void>`; the committed code uses the `void` form.)

### 3.6 Runtime Behavior & Failure Modes
- [ ] **Required:** When KV is down or returns an error in production, does `increment()` reject and cause `express-rate-limit` to return a 503 (fail-closed)?
- [ ] **Required:** When KV is not configured, does the server start without errors and does the limiter still function via `MemoryStore`?
- [ ] **Required:** Are Redis key TTLs set in **milliseconds** (`SET ... PX windowMs` on first hit, `pexpire` only as a defensive fallback), not seconds?
- [ ] **Required:** Is `resetTime` computed from the actual `pttl` returned by Redis (with a fallback to `windowMs` when `pttl <= 0`)?
- [ ] **Required:** Is the first-hit path atomic (`SET NX PX`) so concurrent cold-start invocations cannot double-count or lose the TTL?
- [ ] **Recommended:** Does `increment` defensively re-apply `pexpire` if `pttl === -1` (key exists without TTL)?

---

## 4. Pass / Fail Criteria

### Blocking Failures (commit must be rejected or amended)
Any single item marked **Required** above that is not satisfied is a blocking failure.

Concrete examples:
- `KvRateLimitStore` missing a required `Store` method.
- `init()` awaiting `getRedisClient()` (it must be synchronous).
- First-hit implemented as separate `incr` + `pexpire` rather than atomic `SET NX PX` (race condition).
- New npm package added for rate limiting.
- `server.ts` instantiating `KvRateLimitStore` unconditionally at module load.
- `.env.example` missing the KV documentation section.
- `tsc --noEmit` reporting errors in changed files.
- Tests not mocking `redis.js` and instead hitting a real or unintended module.
- Missing the negative test that proves `increment()` throws when `getRedisClient()` returns `null`.

### Non-Blocking Recommendations
Items marked **Recommended** should be addressed in a follow-up commit but do not block merge.

### Success Criteria Summary
The commit passes review if and only if:
1. The KV-backed rate limiter is functional in production with shared counters.
2. The in-memory fallback is preserved when KV is absent.
3. No new dependencies are introduced.
4. TypeScript compiles cleanly for all changed files.
5. Unit tests cover the core store behaviors and pass.
6. Documentation in `.env.example` is accurate and complete.

---

## 5. How to Run Verification Commands

```bash
# Type check
npx tsc --noEmit

# Run only the new rate limiter tests
npx vitest run tests/rateLimitStore.test.ts

# Run targeted existing tests to check for regressions
npx vitest run tests/state.test.ts tests/handlers.test.ts
```

---

## 6. Notes
- This review guide is specific to commit `feat(rate-limit): add KV-backed express-rate-limit store for Vercel`.
- Future changes to the rate limiter (per-route limits, fail-open behavior, etc.) should be reviewed against updated criteria.
