# Changelog

All notable changes to this project will be documented in this file.

## [7.6.0] - P0 Item 2 Durable-State Remediation & Operational Invariants - 2026-09-04

### Security & Production Safety

* **Shared Durable-Dependency Readiness Gate (`requireDurableDependencies`).** Created a unified readiness gate in `src/server/storage/readiness.ts` that enforces database/schema readiness and Redis reachability across direct production entrypoints (`api/workflows/agentRun.ts`, `api/cron/poll.ts`, `server.ts`).
  * Controlled by `REQUIRE_DURABLE_STATE` and `REQUIRE_REDIS` environment variables, defaulting both to `true` in production (`NODE_ENV=production`).
  * Fail-closed architecture: storage failures trigger typed `DurableStateError` instances returning `503 Service Unavailable` with sanitized, non-sensitive error messages.
* **Slack Interactivity Durable Handoff.** Updated `/slack/interactivity` button-click resolution:
  * Authorization and atomic database approval resolution occur *synchronously before* returning HTTP 200.
  * If database or Redis is unavailable, the endpoint returns `503 Service Unavailable` immediately; it never acknowledges first or relies on process memory / `waitUntil`.
* **Rate-Limiter Fail-Closed Rules.** Removed production Express `MemoryStore` fallback. `validateEnv()` terminates startup if required Redis configuration is missing in production, and `KvRateLimitStore` throws `DurableStateError` (503) on runtime Redis outages when `REQUIRE_REDIS` is active.
* **Universal Orchestration Precondition.** `runAgentPipeline()` in `src/server/agent/orchestrator.ts` verifies `requireDurableDependencies()` and rejects before dispatching any agent handlers (`direct_reply`, `durable_task`, `status_query`, `approval_response`, `cancel_or_update`) if required durable state is down.
* **Operational Rollback Guidance.** Documented immutable deployment rollback as the primary operational rollback procedure. Setting strictness overrides (`REQUIRE_DURABLE_STATE=false`, `REQUIRE_REDIS=false`) is restricted to emergency-only break-glass procedures requiring explicit approval and time limits.

### Added

* `tests/durable-state-outage.test.ts` — 6 new integration tests covering readiness gate checks, workflow 503 outage responses, rate limiter fail-closed enforcement, orchestrator preconditions, and multi-instance deduplication.

### 🧪 Test Results

* 483 tests across 40 test files — all passing.
* `npm run lint` (`tsc --noEmit`) — clean (0 errors).

## [7.6.0] - P0 Dependency Security Remediation - 2026-09-04

### Security

* **Remediated All P0 & Transitive Dependency Vulnerabilities.** Upgraded direct and parent dependencies and introduced explicit, scoped npm overrides to resolve all vulnerabilities reported by `npm audit --omit=dev`.
  * **`ip-address` (<=10.3.0):** Fixed GHSA-mwp4-54f8-5fhr and IPv4 octal / CIDR misclassification vulnerabilities by upgrading `express-rate-limit` to `8.7.0` and applying a `^10.3.1` override (resolving to `10.7.0`). Added security regression tests in `tests/ssrfGuard.test.ts` for ambiguous leading-zero octal IPv4 literals.
  * **`undici` (7.28.0):** Fixed `Cache-Control` response disclosure by upgrading `@ai-sdk/sandbox-vercel` to `1.0.101` and enforcing override `^7.29.1` (resolving to `7.29.1`).
  * **`postcss` (<=8.5.22) & `nanoid` (<=3.3.17):** Fixed path traversal in source map loading (GHSA-fxqj-rqcc-2cmp) and infinite loop vulnerabilities by upgrading `vite` (`^6.4.3`), `autoprefixer` (`^10.5.5`), and applying overrides for `postcss` (`^8.5.23`, resolving to `8.5.28`) and `nanoid` (`^3.3.18`, resolving to `3.3.18`).
  * **`protobufjs` (7.5.0-7.6.4):** Fixed DoS infinite loop in `.proto` option parsing (GHSA-j3f2-48v5-ccww) by upgrading `@google/genai` (`^2.21.0`) and `@google-cloud/cloud-sql-connector` (`^1.12.0`), plus override `^7.6.5` (resolving to `7.6.6`).
  * **`qs` (2.2.5-6.15.3) & `body-parser` (<=1.20.6):** Fixed array-limit bypass DoS (GHSA-x5fp-wj9c-mxmx) and size limit bypass (GHSA-v422-hmwv-36x6) by applying overrides for `qs` (`^6.16.0`) and `body-parser` (`^1.20.6`).
  * **`browserslist` (<=4.28.2) & `brace-expansion` (2.0.0-2.1.3):** Resolved build and coverage tooling vulnerabilities with scoped overrides for `glob` (`brace-expansion@^2.1.4`) and default `brace-expansion` (`^5.0.8`, resolving to `5.0.9`).

## [7.5.0] - Concurrency Saturation Policy, SSRF Guard & Test Suite Expansion - 2026-08-23

### Security

* **SSRF Guard for `web.fetch`.** Implemented a comprehensive shared SSRF protection module `src/server/ssrfGuard.ts` and integrated it into the `web.fetch` tool. The guard validates all requested URLs, parses the hostnames, resolves all IP addresses (using Node's native `dns` module), and blocks any requests containing private, reserved, loopback, or multicast IPv4 and IPv6 network ranges, specifically protecting cloud metadata addresses like `169.254.169.254`. It also extracts and inspects the embedded IPv4 address for IPv4-mapped/translated IPv6 addresses (`::ffff:a.b.c.d/96` and `64:ff9b::/96`), prevents open-redirect bypasses by forcing `redirect: 'manual'` during `fetch` and validating every hop in redirect chains, and fails closed if DNS resolution fails.
  * *Residual Limitation:* This implementation closes direct-IP-targeting and redirect-based bypass. It does NOT provide full DNS-rebinding defense (pinning the TCP connection to a pre-validated IP via a custom `undici` dispatcher). DNS-rebinding remains a known, deliberately deferred residual limitation.
* **Requester and Admin Authorization for Slack Interactivity Approvals.** Secured the `/api/slack/interactivity` button-click resolution path. Interactive action payloads (Approve/Reject) on Block Kit messages are now strictly verified to ensure only the original requester (`requested_from_user_id` stored during approval creation) or authorized Slack administrators (configured via the comma-separated `SLACK_APPROVAL_ADMIN_IDS` environment variable) can resolve a pending request. Unauthorized attempts are ignored, keeping the request pending, and trigger an ephemeral warning to the interacting user while appending an `approval.unauthorized_attempt` audit event to the store.
* **Startup Validation for `APP_URL` in Production.** Added validation at module startup in `server.ts` right after loading env vars to throw an error immediately if `NODE_ENV === 'production'` and `APP_URL` is missing or invalid. This closes security gaps by failing closed on startup rather than request time, preventing any misconfigured server from starting up and serving traffic in production.
* **Express `trust proxy` Hardening.** Changed the Express `trust proxy` setting from `1` (single proxy hop) to `true` (unconditional proxy trust) as requested. To prevent IP-spoofing rate-limit bypass warnings, the `express-rate-limit` permissiveness warning has been safely disabled via `validate: { trustProxy: false }`.
* **CORS Non-Production Fallback Documentation.** Added comments documenting and explaining why allowing all origins (`*`) in non-production environments is an acceptable fallback for testing and local API client integration.

### Added

* **Gemini 3.8 Flash support.** Added `gemini-3.8-flash` as a supported model option with full context-window (1M tokens) and output-token (8192 tokens) configuration. Available via the dashboard model selector and the `/api/model/select` endpoint.
* **Gemini 3.7 Flash support.** Added `gemini-3.7-flash` as a supported model option with full context-window and output-token configuration. Available via the dashboard model selector and the `/api/model/select` endpoint. Maintains `gemini-3.1-flash-lite` as the user-facing default and `gemini-2.5-flash` as the safe fallback.
* **Semantic message deduplication for Slack AI Agent.** `src/server/agent/dedup.ts` implements dual-strategy deduplication: exact SHA-256 hash matching for instant detection, plus Jaccard similarity over FNV-1a 32-bit bigram hashes for catching near-duplicate paraphrased messages. Fingerprints are stored in Redis with configurable TTL, falling back to an in-memory LRU `Map`. Integrated into `slack.replyInThread` so near-duplicate Slack replies are suppressed automatically. New environment variables: `SLACK_DEDUP_SIMILARITY_THRESHOLD` (0.75), `SLACK_DEDUP_WINDOW_SIZE` (5), `SLACK_DEDUP_TTL_SECONDS` (300).
* **Self-host Dockerfile.** New `Dockerfile` provides a multi-stage Node 22 build producing a minimal, non-root production container. Also adds `.dockerignore` for clean build context.
* **Expanded Gemini model support.** Added `gemini-3.6-flash` and `gemini-3.5-flash-lite` to the allowed models list in `src/server/agent/models.ts`, with accurate context window sizing (1M tokens for most Flash models, 128K for Flash-lite).
* **Comprehensive Unit and Integration Tests for SSRF Guard and Web Fetch Adapter.** Created `tests/ssrfGuard.test.ts` (17 tests) and `tests/webFetch.test.ts` (7 tests) to verify IP blocks, boundary CIDR cases, cloud metadata (`169.254.169.254`), IPv4-mapped IPv6 unwrapping, safe redirects, relative redirects, max redirect limits, and `web.fetch` end-to-end SSRF rejection and regression safety.
* **Unit and Integration Tests for Startup URL Validation.** Added two test cases inside the `HTTPS redirect (production)` suite in `tests/security-headers.test.ts` to verify that starting the server in production with missing or invalid `APP_URL` throws/rejects as expected.
* **Database storage pool tests.** New `tests/server/storage/db.test.ts` — 21 tests covering admin/user pool configuration, Cloud SQL Connector reuse guards (preventing connector overwrite and socket leaks), SSL handling, and query retry/backoff resilience.
* **Structured logger tests.** New `tests/log.test.ts` — 4 tests covering structured `slog` output shape and scope tagging.
* **Email adapter tests.** New `tests/tools/adapters/email.test.ts` — 8 tests covering `EMAIL_WEBHOOK_URL` configuration gating, `email.send` tool registration, input validation, webhook JSON payload shape, and non-200 response error handling.
* **GitHub Issue adapter tests.** New `tests/tools/adapters/githubIssue.test.ts` — 8 tests covering `GITHUB_TOKEN` configuration gating, `github.createIssue` tool registration, input validation, GitHub REST API payload shape, and non-ok response error handling.
* **Expanded Vercel workflow tests.** `tests/vercel.test.ts` grown to 22 tests, adding direct-reply permit acquisition/release coverage and 429 saturation-policy verification; `tests/agent-extra.test.ts` grown to 27 tests with semaphore lease semantics.

### Changed

* **Semaphore refactored to idempotent Permit leases.** `Semaphore.acquirePermit()` now returns a `Permit { acquired, release() }` lease object with a FIFO-fair waiter queue and strict max-permit capping. `release()` is idempotent — exactly-once semantics are guaranteed regardless of how many times the caller invokes it. The legacy boolean `acquire()` API is retained as a thin wrapper for compatibility.
* **Direct-reply saturation now fails closed with HTTP 429.** `/api/workflows/agentRun` tracks permit acquisition explicitly: when direct-reply capacity (`DIRECT_REPLY_CONCURRENCY`, default 5) is unavailable after the 10-second acquisition wait, the request is rejected with `429 Too Many Requests`, the pipeline log item is marked errored, and the intent-dedup marker is released so genuine retries are not suppressed. Direct replies can never execute without holding a valid permit.

### Fixed

* **Direct-reply concurrency accounting and permit leak.** Previously the workflow released the semaphore unconditionally whenever the intent was `direct_reply` — even when permit acquisition had timed out — corrupting the permit count and allowing over-admission. Release is now tied to `permit.acquired` inside a `finally` block, restoring exact concurrency accounting.
* **ReAct loop yields no longer leave conversations ending with a model turn.** When the ReAct loop yielded mid-tool-execution (approval or wall-clock deadline), the persisted `contents[]` ended with the model's function-call turn but no corresponding `user` functionResponse turn. On resume, Gemini rejected the request with a 400 `"Requests ending with a model turn are not supported"` error, immediately failing the run. Three-part fix in `reactLoop.ts`: (1) on resume, strip a trailing `model` turn from persisted `agent_messages` before sending to Gemini; (2) restructured the tool execution loop so the `model` turn and `user` functionResponse turn are always pushed together before any yield/break, guaranteeing persisted contents never ends with `model`; (3) the `geminiAgentStep` catch block now detects the model-turn 400 via `GeminiCallError.isModelTurnError`, strips the trailing turn, and yields gracefully instead of throwing. Also fixed `compactThreadHistory` in `context.ts` emitting `role: 'system'` (invalid for Gemini `contents[]`) — summary entries now use `role: 'user'`.
* **Timeout-guard requeue retry count now bounded to fail-fast context.** Reduced `ENQUEUE_MAX_RETRIES` to 2 (three total attempts) specifically for `enqueueRunTask()`, which is called only when the wall-clock timeout has already fired. This prevents the timeout guard from spending 20+ seconds retrying when Vercel's hard function deadline is imminent. The scheduler poller's retry behavior is unchanged. The database row is already atomically marked `'queued'`, so the cron poller will pick up the run if this requeue fails.
* **Resilient Rate-Limiter Fail-Open Fallback.** Modified `KvRateLimitStore` in `src/server/rateLimitStore.ts` to implement a robust fail-open fallback. All Redis network client operations (`increment()`, `decrement()`, and `resetKey()`) are now wrapped in `try/catch` blocks. If `getRedisClient()` returns `null` (unconfigured store) or a Redis operation throws a network/runtime exception, the store gracefully logs a structured warning via `slog` with a `'rate-limit'` scope and returns a permissive payload (e.g. `totalHits: 1` and a reset time derived dynamically from `this.windowMs`) rather than allowing the error to bubble up and trigger an Express 500 server error across `/api/*` endpoints. Added extensive unit tests inside `tests/rateLimitStore.test.ts` to assert exact fail-open payload properties, graceful rejections avoidance, and `slog` structure.
* **Task Client Requeue Timeout & Hang Prevention.** Added a dedicated wall-clock timeout (`ENQUEUE_FETCH_TIMEOUT_MS` default 5s) via `AbortSignal.timeout` to fetch requests inside `taskClient.ts`. This prevents infinite execution hangs on requeue tasks and resolves the flaky `vercel.test.ts` timeout-guard test by properly stubbing and simulating fetch timeouts.
* **`classifyCancelVsUpdate` false-positive on hyphenated compounds.** Excluded hyphen-adjacent matches (e.g. "front-end", "back-end", "non-stop") from cancel word boundaries to prevent false cancellations.
* **`durable_task` heuristic precision improvements.** Ambiguous bare-word matching is now restricted to task-oriented phrases or explicit word boundaries to prevent false matches inside words like "trackable" or on common verbs like "watch" and "create".
* **ReAct loop final answer persistence regression.** The final text answer from the ReAct loop is now persisted as a `succeeded` step titled "Final answer" with `output: { generated: "..." }`, and an `agent_loop.final_answer` audit event is logged. This prevents the semantic verifier from reporting "not satisfied" and triggering infinite replan/re-enqueue storms.
* **Rapid dashboard authentication request fix.** Dashboard auth endpoints now handle rapid concurrent requests without failure.

### 🧪 Test Results

* 477 tests across 39 files.
* `tsc --noEmit` — clean.
