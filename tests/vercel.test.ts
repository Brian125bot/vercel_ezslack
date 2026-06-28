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
  setSelectedModel: vi.fn()
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
    hasPendingApproval: vi.fn().mockResolvedValue(false)
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
    it('restricts access if CRON_SECRET is set but authorization header is invalid', async () => {
      process.env.CRON_SECRET = 'super-secret-cron-key';
      
      const { default: cronHandler } = await import('../api/cron/poll.js');
      
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

    it('allows access and runs poll if CRON_SECRET matches', async () => {
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

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(pollScheduledTriggers).toHaveBeenCalled();
    });
  });

  describe('3. Vercel Workflows Triggering (taskClient.ts)', () => {
    it('skips trigger if APP_URL is missing', async () => {
      delete process.env.APP_URL;
      const fetchSpy = vi.spyOn(global, 'fetch');

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-123');

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('posts to the Vercel workflows agentRun endpoint when triggered', async () => {
      process.env.APP_URL = 'https://my-app.vercel.app';
      
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
  });
});
