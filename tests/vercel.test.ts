import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../src/server/storage/migrations.js';
import { pollScheduledTriggers } from '../src/server/agent/scheduler.js';

// ---- Mocks ----
vi.mock('../src/server/storage/migrations.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined)
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
    process.env = { ...originalEnv, VERCEL: '1' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. Lazy Migration Middleware in api/index.ts', () => {
    // Helper to get the migration middleware from the Express app stack
    async function getMiddleware() {
      const { default: apiApp } = await import('../api/index.js');
      const stack = (apiApp as any)._router?.stack || [];
      // Robustly find the lazy migration middleware by checking the function source code
      const layer = stack.find((s: any) => 
        s.handle && 
        s.handle.length === 3 && 
        s.handle.toString().includes('runMigrations')
      );
      return layer ? layer.handle : null;
    }

    it('does not trigger migrations if DATABASE_URL is missing', async () => {
      delete process.env.DATABASE_URL;
      const middleware = await getMiddleware();
      expect(middleware).toBeTruthy();

      const mockReq = { ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockRes = {};
      const next = vi.fn();

      await middleware(mockReq as any, mockRes as any, next);

      expect(runMigrations).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('triggers migrations exactly once even under concurrent requests when DATABASE_URL is set', async () => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
      const middleware = await getMiddleware();
      expect(middleware).toBeTruthy();

      const mockReq1 = { ip: '127.0.0.1', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockReq2 = { ip: '127.0.0.2', headers: {}, get: vi.fn().mockReturnValue('') };
      const mockReq3 = { ip: '127.0.0.3', headers: {}, get: vi.fn().mockReturnValue('') };
      
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

      expect(runMigrations).toHaveBeenCalledTimes(1);
      expect(next1).toHaveBeenCalled();
      expect(next2).toHaveBeenCalled();
      expect(next3).toHaveBeenCalled();
    });
  });

  describe('2. Vercel Cron Endpoint (api/cron/poll.ts)', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    });

    it('restricts access if CRON_SECRET is set but authorization header is invalid', async () => {
      process.env.CRON_SECRET = 'super-secret-cron-key';
      
      const { default: cronHandler } = await import('../api/cron/poll.js');

      // Need fresh mock to verify pollScheduledTriggers didn't get called through the chain
      const { agentStore } = await import('../src/server/storage/agentStore.js');
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

      // Called 4 times: initial + 3 retries = 4 total
      expect(fetchSpy).toHaveBeenCalledTimes(4);
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
  });

  describe('4. Vercel Workflow Handler - Model Selection (Fix 1)', () => {
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
  });

  describe('5. Closed-Loop Worker - Timeout Guard (Fix 5)', () => {
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
      expect(agentStore.updateGoalStatus).not.toHaveBeenCalled();
    });
  });
});
