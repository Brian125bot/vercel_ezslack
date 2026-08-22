# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

* **Dedicated Internal Secret Authentication for `/api/workflows/agentRun`.** Converted the `/api/workflows/agentRun` background execution endpoint into an internal-only endpoint. Requests must present a valid internal secret in `Authorization: Bearer <WORKFLOW_INTERNAL_SECRET>`. Slack signature verification remains strictly at the `/api/slack/events` ingress boundary, and `signatureVerified` in the request body is no longer treated as an authorization assertion.
* **Constant-Time Secret Comparison.** Implemented constant-time secret comparison via `crypto.timingSafeEqual` over SHA-256 digests in `src/server/workflowAuth.ts`, handling variable input lengths safely without timing side channels or logging secret values.
* **Environment Secret Enforcement.** Added `WORKFLOW_INTERNAL_SECRET` validation in `src/server/env.ts` requiring a valid non-placeholder secret in production and on Vercel deployments (`VERCEL=1`). In local development/testing, an explicit fallback secret is permitted only when `WORKFLOW_INTERNAL_SECRET` is unset and neither production nor Vercel environments are active. Added a non-secret placeholder and setup instructions to `.env.example`.
* **Internal Callers Updated.** Updated `src/server/routes.ts` (`POST /api/slack/events`) and `src/server/agent/taskClient.ts` (`enqueueRunTask`) to attach `Authorization: Bearer <WORKFLOW_INTERNAL_SECRET>` when invoking the workflow endpoint, while preserving any optional Vercel deployment protection bypass headers.

### Added

* **Comprehensive Internal Workflow Authentication Tests.** Added `tests/workflowAuth.test.ts` to verify unauthenticated/unauthorized request rejection before maintenance/DB/pipeline operations, correct Bearer token authentication for initial events and durable `runId` claims, caller header propagation, and `validateEnv` production/Vercel secret rejection.

### Security

* **SSRF Guard for `web.fetch`.** Implemented a comprehensive shared SSRF protection module `src/server/ssrfGuard.ts` and integrated it into the `web.fetch` tool. The guard validates all requested URLs, parses the hostnames, resolves all IP addresses (using Node's native `dns` module), and blocks any requests containing private, reserved, loopback, or multicast IPv4 and IPv6 network ranges, specifically protecting cloud metadata addresses like `169.254.169.254`. It also extracts and inspects the embedded IPv4 address for IPv4-mapped/translated IPv6 addresses (`::ffff:a.b.c.d/96` and `64:ff9b::/96`), prevents open-redirect bypasses by forcing `redirect: 'manual'` during `fetch` and validating every hop in redirect chains, and fails closed if DNS resolution fails.
  * *Residual Limitation:* This implementation closes direct-IP-targeting and redirect-based bypass. It does NOT provide full DNS-rebinding defense (pinning the TCP connection to a pre-validated IP via a custom `undici` dispatcher). DNS-rebinding remains a known, deliberately deferred residual limitation.
* **Requester and Admin Authorization for Slack Interactivity Approvals.** Secured the `/api/slack/interactivity` button-click resolution path. Interactive action payloads (Approve/Reject) on Block Kit messages are now strictly verified to ensure only the original requester (`requested_from_user_id` stored during approval creation) or authorized Slack administrators (configured via the comma-separated `SLACK_APPROVAL_ADMIN_IDS` environment variable) can resolve a pending request. Unauthorized attempts are ignored, keeping the request pending, and trigger an ephemeral warning to the interacting user while appending an `approval.unauthorized_attempt` audit event to the store.
* **Startup Validation for `APP_URL` in Production.** Added validation at module startup in `server.ts` right after loading env vars to throw an error immediately if `NODE_ENV === 'production'` and `APP_URL` is missing or invalid. This closes security gaps by failing closed on startup rather than request time, preventing any misconfigured server from starting up and serving traffic in production.
* **Express `trust proxy` Hardening.** Changed the Express `trust proxy` setting from `1` (single proxy hop) to `true` (unconditional proxy trust) as requested. To prevent IP-spoofing rate-limit bypass warnings, the `express-rate-limit` permissiveness warning has been safely disabled via `validate: { trustProxy: false }`.
* **CORS Non-Production Fallback Documentation.** Added comments documenting and explaining why allowing all origins (`*`) in non-production environments is an acceptable fallback for testing and local API client integration.

### Added

* **Gemini 3.7 Flash support.** Added `gemini-3.7-flash` as a supported model option with full context-window and output-token configuration. Available via the dashboard model selector and the `/api/model/select` endpoint. Maintains `gemini-3.1-flash-lite` as the user-facing default and `gemini-2.5-flash` as the safe fallback.
* **Comprehensive Unit and Integration Tests for SSRF Guard and Web Fetch Adapter.** Created `tests/ssrfGuard.test.ts` (17 tests) and `tests/webFetch.test.ts` (7 tests) to verify IP blocks, boundary CIDR cases, cloud metadata (`169.254.169.254`), IPv4-mapped IPv6 unwrapping, safe redirects, relative redirects, max redirect limits, and `web.fetch` end-to-end SSRF rejection and regression safety.
* **Unit and Integration Tests for Startup URL Validation.** Added two test cases inside the `HTTPS redirect (production)` suite in `tests/security-headers.test.ts` to verify that starting the server in production with missing or invalid `APP_URL` throws/rejects as expected.

### Fixed

* **ReAct loop yields no longer leave conversations ending with a model turn.** When the ReAct loop yielded mid-tool-execution (approval or wall-clock deadline), the persisted `contents[]` ended with the model's function-call turn but no corresponding `user` functionResponse turn. On resume, Gemini rejected the request with a 400 `"Requests ending with a model turn are not supported"` error, immediately failing the run. Three-part fix in `reactLoop.ts`: (1) on resume, strip a trailing `model` turn from persisted `agent_messages` before sending to Gemini; (2) restructured the tool execution loop so the `model` turn and `user` functionResponse turn are always pushed together before any yield/break, guaranteeing persisted contents never ends with `model`; (3) the `geminiAgentStep` catch block now detects the model-turn 400 via `GeminiCallError.isModelTurnError`, strips the trailing turn, and yields gracefully instead of throwing. Also fixed `compactThreadHistory` in `context.ts` emitting `role: 'system'` (invalid for Gemini `contents[]`) — summary entries now use `role: 'user'`.
* **Timeout-guard requeue retry count now bounded to fail-fast context.** Reduced `ENQUEUE_MAX_RETRIES` to 2 (three total attempts) specifically for `enqueueRunTask()`, which is called only when the wall-clock timeout has already fired. This prevents the timeout guard from spending 20+ seconds retrying when Vercel's hard function deadline is imminent. The scheduler poller's retry behavior is unchanged. The database row is already atomically marked `'queued'`, so the cron poller will pick up the run if this requeue fails.
* **Resilient Rate-Limiter Fail-Open Fallback.** Modified `KvRateLimitStore` in `src/server/rateLimitStore.ts` to implement a robust fail-open fallback. All Redis network client operations (`increment()`, `decrement()`, and `resetKey()`) are now wrapped in `try/catch` blocks. If `getRedisClient()` returns `null` (unconfigured store) or a Redis operation throws a network/runtime exception, the store gracefully logs a structured warning via `slog` with a `'rate-limit'` scope and returns a permissive payload (e.g. `totalHits: 1` and a reset time derived dynamically from `this.windowMs`) rather than allowing the error to bubble up and trigger an Express 500 server error across `/api/*` endpoints. Added extensive unit tests inside `tests/rateLimitStore.test.ts` to assert exact fail-open payload properties, graceful rejections avoidance, and `slog` structure.
* **Task Client Requeue Timeout & Hang Prevention.** Added a dedicated wall-clock timeout (`ENQUEUE_FETCH_TIMEOUT_MS` default 5s) via `AbortSignal.timeout` to fetch requests inside `taskClient.ts`. This prevents infinite execution hangs on requeue tasks and resolves the flaky `vercel.test.ts` timeout-guard test by properly stubbing and simulating fetch timeouts.

## [Unreleased] - 2026-07-28

### Added

* **Semantic message deduplication for Slack AI Agent.** `src/server/agent/dedup.ts` implements dual-strategy deduplication: exact SHA-256 hash matching for instant detection, plus Jaccard similarity over FNV-1a 32-bit bigram hashes for catching near-duplicate paraphrased messages. Fingerprints are stored in Redis with configurable TTL, falling back to an in-memory LRU `Map`. Integrated into `slack.replyInThread` so near-duplicate Slack replies are suppressed automatically. New environment variables: `SLACK_DEDUP_SIMILARITY_THRESHOLD` (0.75), `SLACK_DEDUP_WINDOW_SIZE` (5), `SLACK_DEDUP_TTL_SECONDS` (300).
* **Self-host Dockerfile.** New `Dockerfile` provides a minimal, non-root production container.
* **Expanded Gemini model support.** Added `gemini-3.6-flash` and `gemini-3.5-flash-lite` to the allowed models list in `src/server/agent/models.ts`.

### Fixed

* **`classifyCancelVsUpdate` false-positive on hyphenated compounds.** Excluded hyphen-adjacent matches from cancel word boundaries.
* **`durable_task` heuristic precision improvements.** Ambiguous bare-word matching restricted to task-oriented phrases.
* **ReAct loop final answer persistence regression.** Persisted final text answer as a `succeeded` step and logged audit event.
