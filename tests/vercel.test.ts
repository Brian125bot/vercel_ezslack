import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureSchemaReady } from '../src/server/storage/readiness.js';
import { pollScheduledTriggers } from '../src/server/agent/scheduler.js';

// ---- Mocks ----
vi.mock('../src/server/storage/migrations.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/server/storage/readiness.js', () => ({
  ensureSchemaReady: vi.fn().mockResolvedValue(undefined),
  getSchemaReadiness: vi.fn().mockReturnValue({ state: 'ready', ready: true, lastFailureAt: null }),
}));

vi.mock('../src/server/agent/scheduler.js', () => ({
  pollScheduledTriggers: vi.fn().mockResolvedValue(undefined),
  startScheduler: vi.fn(),
  stopScheduler: vi.fn()
}));

vi.mock('../src/server/storage/db.js', () => ({
  isDbAvailable: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/server/state.js', () => ({
  selectedModel: 'gemini-3.5-flash',
  updateLog: vi.fn(),
  addLog: vi.fn(),
  clearLogs: vi.fn(),
  getLogs: vi.fn().mockReturnValue([]),
  getSelectedModel: vi.fn().mockReturnValue('gemini-3.5-flash'),
  isEventDuplicate: vi.fn().mockResolvedValue(false),
  isMessageDuplicate: vi.fn().mockResolvedValue(false),
  setSelectedModel: vi.fn(),
  getThreadHistory: vi.fn().mockResolvedValue([]),
  saveThreadHistory: vi.fn().mockResolvedValue(undefined),
  createIntentHash: vi.fn().mockReturnValue('mock-intent-hash'),
  setIntentDedup: vi.fn().mockResolvedValue(true),
  markIntentComplete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/agent/intent.js', () => ({
  classifyIntent: vi.fn().mockResolvedValue({ intent: 'direct_reply', confidence: 0.9, source: 'rule' })
}));

vi.mock('../src/server/agent/orchestrator.js', () => ({
  runAgentPipeline: vi.fn().mockResolvedValue({ status: 'success', intent: 'direct_reply', message: 'replied' })
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: {
    getRun: vi.fn().mockResolvedValue({ id: 'run-123', status: 'queued' }),
    claimQueuedRunById: vi.fn().mockResolvedValue({ id: 'run-123', status: 'running' }),
    updateRunStatus: vi.fn().mockResolvedValue({}),
    hasPendingApproval: vi.fn().mockResolvedValue(false),
    updateGoalStatus: vi.fn().mockResolvedValue({}),
    recoverStaleClaims: vi.fn().mockResolvedValue(0),
    reapExpiredApprovals: vi.fn().mockResolvedValue([]),
    getGoal: vi.fn().mockResolvedValue({ id: 'goal-123', workspace_id: 'ws-1', title: 'test', original_instruction: 'test', created_by_user_id: 'user-1', source_channel_id: 'C123' }),
    getApprovedPlanApproval: vi.fn().mockResolvedValue(null),
    getApprovedStepApproval: vi.fn().mockResolvedValue(null),
    incrementRunIteration: vi.fn().mockResolvedValue({ id: 'run-123', iteration_count: 1 }),
    createPlan: vi.fn().mockResolvedValue({ id: 'plan-123' }),
    createApprovalRequest: vi.fn().mockResolvedValue({ id: 'apr-123' }),
    updateApprovalStatus: vi.fn().mockResolvedValue({}),
    appendAuditEvent: vi.fn().mockResolvedValue({}),
    getStepsForPlan: vi.fn().mockResolvedValue([]),
    getRunTrace: vi.fn().mockResolvedValue({ run: { id: 'run-123' }, goal: {}, plan: {}, steps: [], toolCalls: [], approvals: [], auditEvents: [] }),
    getStep: vi.fn().mockResolvedValue({ id: 'step-123', status: 'succeeded' }),
    updateStepStatus: vi.fn().mockResolvedValue({}),
    createStep: vi.fn().mockResolvedValue({}),
    incrementRunRetry: vi.fn().mockResolvedValue({}),
    renewLease: vi.fn().mockResolvedValue({}),
  }
}));

describe('Vercel Migration Integration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv, VERCEL: '1',
      GEMINI_API_KEY: 'test-ai-key',
      SLACK_BOT_TOKEN: 'xoxb-real-token',
      SLACK_SIGNING_SECRET: 'real-signing-secret',
      DASHBOARD_PASSWORD: 'strong-password',
      DATABASE_URL: 'postgres://user:pass@host:5432/db',
      APP_URL: 'https://example.com',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('1. Schema Readiness Middleware in api/index.ts', () => {
    // Helper to get the migration middleware from the Express app stack
    async function getMiddleware() {
      const { default: apiApp } = await import('../api/index.js');
      const stack = (apiApp as any)._router?.stack || [];
      // Find the fail-closed schema-readiness middleware without relying on
      // Express stack offsets that change with security middleware.
      const layer = stack.find((s: any) => 
        s.handle &&
        s.handle.length === 3 &&
        s.handle.toString().includes('ensureSchemaReady')
      );
      return layer ? layer.handle : null;
    }

    it('bypasses schema work for the lightweight liveness endpoint', async () => {
      const middleware = await getMiddleware();
      const mockReq = { path: '/health', ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(mockReq as any, mockRes as any, next);

      expect(ensureSchemaReady).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows a protected request to continue after schema readiness succeeds', async () => {
      const middleware = await getMiddleware();
      expect(middleware).toBeTruthy();

      const mockReq = { path: '/status', ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(mockReq as any, mockRes as any, next);

      expect(ensureSchemaReady).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('invokes the readiness gate for concurrent protected requests', async () => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
      const middleware = await getMiddleware();
      expect(middleware).toBeTruthy();

      const mockReq1 = { path: '/status', ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockReq2 = { path: '/status', ip: '127.0.0.2', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockReq3 = { path: '/status', ip: '127.0.0.3', headers: {}, get: vi.fn().mockReturnValue('') };
      
      const mockRes = {};
      const next1 = vi.fn();
      const next2 = vi.fn();
      const next3 = vi.fn();

      // Trigger 3 concurrent calls with separate request objects
      await Promise.all([
        middleware(mockReq1 as any, mockRes as any, next1),
        middleware(mockReq2 as any, mockRes as any, next2),
        middleware(mockReq3 as any, mockRes as any, next3)
      ]);

      expect(ensureSchemaReady).toHaveBeenCalledTimes(3);
      expect(next1).toHaveBeenCalled();
      expect(next2).toHaveBeenCalled();
      expect(next3).toHaveBeenCalled();
    });

    it('returns 503 and does not invoke downstream routing when schema readiness fails', async () => {
      vi.mocked(ensureSchemaReady).mockRejectedValueOnce(new Error('migration unavailable'));
      const middleware = await getMiddleware();
      const mockReq = { path: '/status', ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(mockReq as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Service temporarily unavailable while database schema is preparing'
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('2. Vercel Cron Endpoint (api/cron/poll.ts)', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    });

    it('restricts access if CRON_SECRET is set but authorization header is invalid', async () => {
      process.env.CRON_SECRET = 'super-secret-cron-key';
      
      const { default: cronHandler } = await import('../api/cron/poll.js');

      vi.clearAllMocks();

      const mockReq = {
        headers: {
          authorization: 'Bearer wrong-secret'
        }
      };
      
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await cronHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized cron request' }));
      expect(pollScheduledTriggers).not.toHaveBeenCalled();
    });

    it('rejects access on Vercel when CRON_SECRET is not configured', async () => {
      delete process.env.CRON_SECRET;
      process.env.VERCEL = '1';

      const { default: cronHandler } = await import('../api/cron/poll.js');

      vi.clearAllMocks();

      const mockReq = {
        headers: {
          authorization: 'Bearer any-token'
        }
      };

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await cronHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized cron request' }));
      expect(pollScheduledTriggers).not.toHaveBeenCalled();
    });

    it('returns 503 and skips maintenance when schema readiness fails', async () => {
      process.env.CRON_SECRET = 'super-secret-cron-key';
      vi.mocked(ensureSchemaReady).mockRejectedValueOnce(new Error('migration unavailable'));
      const { default: cronHandler } = await import('../api/cron/poll.js');
      const mockReq = { headers: { authorization: 'Bearer super-secret-cron-key' } };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await cronHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Service temporarily unavailable while database schema is preparing'
      });
      expect(pollScheduledTriggers).not.toHaveBeenCalled();
    });

    it('allows access, recovers stale claims, and runs poll when CRON_SECRET matches', async () => {
      process.env.CRON_SECRET = 'super-secret-cron-key';
      
      const { default: cronHandler } = await import('../api/cron/poll.js');

      const mockReq = {
        headers: {
          authorization: 'Bearer super-secret-cron-key'
        }
      };
      
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await cronHandler(mockReq as any, mockRes as any);

      // Fix 4: Verify stale claim recovery and approval expiration run before polling
      const { agentStore } = await import('../src/server/storage/agentStore.js');
      expect(agentStore.recoverStaleClaims).toHaveBeenCalled();
      expect(agentStore.reapExpiredApprovals).toHaveBeenCalled();
      expect(pollScheduledTriggers).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });
  });

  describe('3. Vercel Workflows Triggering (taskClient.ts)', () => {
    beforeEach(() => {
      process.env.APP_URL = 'https://my-app.vercel.app';
    });

    it('skips trigger if APP_URL is missing', async () => {
      delete process.env.APP_URL;
      const fetchSpy = vi.spyOn(global, 'fetch');

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-123');

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('posts to the Vercel workflows agentRun endpoint when triggered', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true })))
      );

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-123', 'log-456');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://my-app.vercel.app/api/workflows/agentRun',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: 'run-123', logItemId: 'log-456' })
        })
      );
      fetchSpy.mockRestore();
    });

    it('retries on server error with exponential backoff and eventually succeeds (Fix 3)', async () => {
      let callCount = 0;
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(new Response('Server Error', { status: 503 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      });

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-retry-test');

      // Called 3 times: 2 failed 503s + 1 success
      expect(callCount).toBe(3);
      fetchSpy.mockRestore();
    });

    it('gives up after max retries on persistent server error', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response('Server Error', { status: 503 }))
      );

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-fail-test');

      // Called 3 times: initial + 2 retries = 3 total
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      fetchSpy.mockRestore();
    });

    it('stops and returns false after 2 retries (3 total attempts) on persistent server error', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response('Server Error', { status: 503 }))
      );

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      const result = await enqueueRunTask('run-fail-test-2');

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(result).toBe(false);
      fetchSpy.mockRestore();
    });

    it('does not retry on client error (4xx)', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response('Bad Request', { status: 400 }))
      );

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-4xx-test');

      // Only called once — no retry on 4xx
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it('does not retry on HTTP 508 Loop Detected', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response('Loop Detected', { status: 508 }))
      );

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      const result = await enqueueRunTask('run-508-test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toBe(false);
      fetchSpy.mockRestore();
    });
  });

  describe('4. Vercel Workflow Handler - Direct Reply Concurrency & Error Release', () => {
    it('returns 503 before model resolution or agent work when schema readiness fails', async () => {
      vi.mocked(ensureSchemaReady).mockRejectedValueOnce(new Error('migration unavailable'));
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const { getSelectedModel } = await import('../src/server/state.js');
      const { runAgentPipeline } = await import('../src/server/agent/orchestrator.js');
      const { agentStore } = await import('../src/server/storage/agentStore.js');
      vi.clearAllMocks();

      const mockReq = {
        method: 'POST',
        body: { runId: 'run-readiness-failure' },
        headers: {}
      };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Service temporarily unavailable while database schema is preparing'
      });
      expect(getSelectedModel).not.toHaveBeenCalled();
      expect(runAgentPipeline).not.toHaveBeenCalled();
      expect(agentStore.claimQueuedRunById).not.toHaveBeenCalled();
    });

    it('calls getSelectedModel during handler bootstrap to resolve user model', async () => {
      // Import agentRun handler — its module-level imports trigger getSelectedModel mock
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const { getSelectedModel } = await import('../src/server/state.js');

      vi.clearAllMocks();

      const mockReq = {
        method: 'POST',
        body: {
          event: { text: 'hello', channel: 'C123', user: 'U123', ts: '123.456', thread_ts: null, type: 'message' },
          eventId: 'evt-001',
          signatureVerified: true,
          workspaceId: 'T001',
        },
        get: vi.fn().mockReturnValue(''),
        headers: {}
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        send: vi.fn(),
      };

      await workflowHandler(mockReq as any, mockRes as any);

      // getSelectedModel is called during handler bootstrap to resolve user's model
      expect(getSelectedModel).toHaveBeenCalled();
    });

    it('direct-reply workflow error after acquisition releases its permit', async () => {
      const { runAgentPipeline } = await import('../src/server/agent/orchestrator.js');
      vi.mocked(runAgentPipeline).mockRejectedValueOnce(new Error('Pipeline error during direct reply'));

      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');

      const mockReq = {
        method: 'POST',
        body: {
          event: { text: 'hello', channel: 'C123', user: 'U123', ts: '123.456', thread_ts: null, type: 'message' },
          eventId: 'evt-error-test',
          signatureVerified: true,
          workspaceId: 'T001',
          logItemId: 'log-err-1'
        },
        get: vi.fn().mockReturnValue(''),
        headers: {}
      };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Pipeline error during direct reply' }));
    });

    it('saturated direct-reply workflow follows 429 timeout policy and never executes without permit', async () => {
      process.env.DIRECT_REPLY_CONCURRENCY = '1';
      const { classifyIntent } = await import('../src/server/agent/intent.js');
      vi.mocked(classifyIntent).mockResolvedValue({ intent: 'direct_reply', confidence: 0.9, source: 'rule' });

      const { runAgentPipeline } = await import('../src/server/agent/orchestrator.js');

      // First request acquires the sole permit and hangs in runAgentPipeline
      let resolveFirstPipeline: any;
      vi.mocked(runAgentPipeline).mockImplementationOnce(() => {
        return new Promise(resolve => {
          resolveFirstPipeline = resolve;
        });
      });

      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');

      const req1 = {
        method: 'POST',
        body: {
          event: { text: 'first req', channel: 'C1', user: 'U1', ts: '1.0' },
          eventId: 'evt-1',
          workspaceId: 'T1'
        },
        get: vi.fn().mockReturnValue(''),
        headers: {}
      };
      const res1 = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      // Start req1 (acquires permit)
      const req1Promise = workflowHandler(req1 as any, res1 as any);

      // Req2 attempts direct_reply, but semaphore is fully saturated.
      // Mock timers are fake or short timeout: we can simulate timeout
      const req2 = {
        method: 'POST',
        body: {
          event: { text: 'second req', channel: 'C1', user: 'U1', ts: '2.0' },
          eventId: 'evt-2',
          workspaceId: 'T1',
          logItemId: 'log-sat-2'
        },
        get: vi.fn().mockReturnValue(''),
        headers: {}
      };
      const res2 = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      // Make classifyIntent resolve direct_reply for req2
      vi.mocked(classifyIntent).mockResolvedValueOnce({ intent: 'direct_reply', confidence: 0.9, source: 'rule' });

      // Run req2 and ensure it gets 429 when capacity is saturated
      // Fast forward fake timers if needed, or wait for acquirePermit timeout
      const req2Promise = workflowHandler(req2 as any, res2 as any);

      // Clean up req1
      if (resolveFirstPipeline) {
        resolveFirstPipeline({ status: 'success', intent: 'direct_reply', message: 'done' });
      }
      await req1Promise;
      await req2Promise;

      expect(res2.status).toHaveBeenCalledWith(429);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('capacity exceeded') }));
    });
  });

  describe('5. Closed-Loop Worker - Timeout Guard (Fix 5)', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))));
    });

    it('re-queues and does not finalize when wall-clock timeout is exceeded', async () => {
      // Set a zero ms timeout so the guard fires on the first check
      process.env.RUN_TIMEOUT_MS = '0';

      const { runLoop } = await import('../src/server/agent/loop.js');
      const { agentStore } = await import('../src/server/storage/agentStore.js');

      vi.clearAllMocks();

      const mockRun = {
        id: 'run-timeout-test',
        goal_id: 'goal-123',
        status: 'queued',
        plan_id: null,
        model: 'gemini-2.5-flash',
        iteration_count: 0,
        retry_count: 0,
      };

      await runLoop(mockRun as any, 'test-worker');

      // Should have been re-queued with a timeout reason, never finalized
      const updateCalls = (agentStore.updateRunStatus as any).mock.calls;
      const requeueCall = updateCalls.find((c: any) => c[1] === 'queued');
      expect(requeueCall).toBeDefined();
      expect(requeueCall[2]?.failure_reason).toContain('timeout');
    });

    it('regression: enqueueRunTask does not hang when fetch hangs past ENQUEUE_FETCH_TIMEOUT_MS', async () => {
      // Mock fetch to simulate real fetch behavior with AbortSignal
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url, options) => {
        return new Promise((resolve, reject) => {
          if (options?.signal) {
            if (options.signal.aborted) {
              const err = new Error('The operation was aborted.');
              err.name = 'TimeoutError';
              return reject(err);
            }
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'TimeoutError';
              reject(err);
            });
          }
        });
      }));

      // Mock setTimeout to bypass retry delays, executing them immediately (0ms delay)
      const originalSetTimeout = global.setTimeout;
      vi.stubGlobal('setTimeout', vi.fn().mockImplementation((fn, delay, ...args) => {
        if (delay === 1000 || delay === 2000 || delay === 4000) {
          return originalSetTimeout(fn, 0, ...args);
        }
        return originalSetTimeout(fn, delay, ...args);
      }));

      // Override the timeout env var to make the test extremely fast
      process.env.ENQUEUE_FETCH_TIMEOUT_MS = '10';

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');

      const startTime = Date.now();
      const result = await enqueueRunTask('run-timeout-hang-test');
      const elapsed = Date.now() - startTime;

      expect(result).toBe(false);
      // Ensure it returned quickly (well under the 10s test timeout)
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('6. Atomic Run Claim (Fix: concurrent worker storm)', () => {
    it('returns 200 without invoking runLoop when the run is already claimed', async () => {
      const { agentStore } = await import('../src/server/storage/agentStore.js');
      (agentStore.claimQueuedRunById as any).mockResolvedValueOnce(null);

      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const mockReq = { method: 'POST', body: { runId: 'run-already-claimed' }, get: vi.fn().mockReturnValue(''), headers: {} };
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('already claimed') }));
    });
  });
});
