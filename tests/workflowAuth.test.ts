import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyWorkflowInternalSecret, DEV_TEST_WORKFLOW_INTERNAL_SECRET } from '../src/server/workflowAuth.js';
import { validateEnv } from '../src/server/env.js';

// Mocks for workflow endpoint tests
vi.mock('../src/server/agent/maintenance.js', () => ({
  runSystemMaintenance: vi.fn().mockResolvedValue(undefined)
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
    getGoal: vi.fn().mockResolvedValue({ id: 'goal-123', workspace_id: 'ws-1' }),
    getApprovedPlanApproval: vi.fn().mockResolvedValue(null),
    getApprovedStepApproval: vi.fn().mockResolvedValue(null),
    incrementRunIteration: vi.fn().mockResolvedValue({ id: 'run-123', iteration_count: 1 }),
    createPlan: vi.fn().mockResolvedValue({ id: 'plan-123' }),
    createApprovalRequest: vi.fn().mockResolvedValue({ id: 'apr-123' }),
    updateApprovalStatus: vi.fn().mockResolvedValue({}),
    appendAuditEvent: vi.fn().mockResolvedValue({}),
    getStepsForPlan: vi.fn().mockResolvedValue([]),
    getRunTrace: vi.fn().mockResolvedValue({ run: { id: 'run-123' } }),
    getStep: vi.fn().mockResolvedValue({ id: 'step-123', status: 'succeeded' }),
    updateStepStatus: vi.fn().mockResolvedValue({}),
    createStep: vi.fn().mockResolvedValue({}),
    incrementRunRetry: vi.fn().mockResolvedValue({}),
    renewLease: vi.fn().mockResolvedValue({}),
  }
}));

describe('Internal Workflow Security & Authentication', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      WORKFLOW_INTERNAL_SECRET: 'test-secret-12345678901234567890',
      GEMINI_API_KEY: 'test-ai-key',
      SLACK_BOT_TOKEN: 'xoxb-real-token',
      SLACK_SIGNING_SECRET: 'real-signing-secret',
      DASHBOARD_PASSWORD: 'strong-password',
      DATABASE_URL: 'postgres://user:pass@host:5432/db',
      APP_URL: 'https://example.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('verifyWorkflowInternalSecret helper', () => {
    it('validates correct Bearer token in Authorization header', () => {
      const req = {
        headers: {
          authorization: 'Bearer test-secret-12345678901234567890'
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(true);
      expect(result.status).toBe(200);
    });

    it('rejects missing Authorization header with 401', () => {
      const req = { headers: {} };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toContain('Missing Authorization header');
    });

    it('rejects malformed Authorization header with 401', () => {
      const req = {
        headers: {
          authorization: 'Basic test-secret-12345678901234567890'
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toContain('Malformed Authorization header');
    });

    it('rejects incorrect secret with 403', () => {
      const req = {
        headers: {
          authorization: 'Bearer wrong-secret-value'
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toContain('Invalid workflow internal credential');
    });

    it('handles unequal string length safely without throwing', () => {
      const req = {
        headers: {
          authorization: 'Bearer short'
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(403);
    });

    it('uses dev/test fallback in local non-production environment when unset', () => {
      delete process.env.WORKFLOW_INTERNAL_SECRET;
      delete process.env.VERCEL;
      process.env.NODE_ENV = 'development';

      const req = {
        headers: {
          authorization: `Bearer ${DEV_TEST_WORKFLOW_INTERNAL_SECRET}`
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(true);
    });

    it('does NOT use dev fallback in production or on Vercel when WORKFLOW_INTERNAL_SECRET is unset', () => {
      delete process.env.WORKFLOW_INTERNAL_SECRET;
      process.env.NODE_ENV = 'production';

      const req = {
        headers: {
          authorization: `Bearer ${DEV_TEST_WORKFLOW_INTERNAL_SECRET}`
        }
      };
      const result = verifyWorkflowInternalSecret(req);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toContain('WORKFLOW_INTERNAL_SECRET is not configured');
    });
  });

  describe('api/workflows/agentRun Endpoint Authorization', () => {
    it('rejects unauthenticated request and does NOT invoke maintenance, DB, classification, or orchestrator', async () => {
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const { runSystemMaintenance } = await import('../src/server/agent/maintenance.js');
      const { classifyIntent } = await import('../src/server/agent/intent.js');
      const { runAgentPipeline } = await import('../src/server/agent/orchestrator.js');

      const mockReq = {
        method: 'POST',
        headers: {},
        body: {
          event: { text: 'hello', channel: 'C123', user: 'U123', ts: '123.456', type: 'message' },
          eventId: 'evt-001',
          workspaceId: 'T001',
        }
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Authorization header') }));

      expect(runSystemMaintenance).not.toHaveBeenCalled();
      expect(classifyIntent).not.toHaveBeenCalled();
      expect(runAgentPipeline).not.toHaveBeenCalled();
    });

    it('rejects request with incorrect secret', async () => {
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');

      const mockReq = {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-secret'
        },
        body: {
          event: { text: 'hello', channel: 'C123', user: 'U123', ts: '123.456', type: 'message' },
          eventId: 'evt-001',
        }
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Invalid workflow internal credential') }));
    });

    it('allows correctly authenticated initial-event workflow request to reach execution', async () => {
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const { runAgentPipeline } = await import('../src/server/agent/orchestrator.js');

      const mockReq = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret-12345678901234567890'
        },
        body: {
          event: { text: 'hello agent', channel: 'C123', user: 'U123', ts: '123.456', type: 'message' },
          eventId: 'evt-auth-001',
          workspaceId: 'T001',
          logItemId: 'log-123'
        }
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(runAgentPipeline).toHaveBeenCalled();
    });

    it('allows correctly authenticated runId request to reach queue claim path', async () => {
      const { default: workflowHandler } = await import('../api/workflows/agentRun.js');
      const { agentStore } = await import('../src/server/storage/agentStore.js');

      const mockReq = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret-12345678901234567890'
        },
        body: {
          runId: 'run-auth-test-456'
        }
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };

      await workflowHandler(mockReq as any, mockRes as any);

      expect(agentStore.claimQueuedRunById).toHaveBeenCalledWith('run-auth-test-456', expect.any(String), expect.any(Number));
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });
  });

  describe('Internal Callers Send Authorization Header', () => {
    it('enqueueRunTask sends Authorization header with internal secret', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true })));

      const { enqueueRunTask } = await import('../src/server/agent/taskClient.js');
      await enqueueRunTask('run-header-check', 'log-header-check');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/workflows/agentRun'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-secret-12345678901234567890'
          })
        })
      );

      fetchSpy.mockRestore();
    });
  });

  describe('Environment Validation (validateEnv)', () => {
    it('rejects missing WORKFLOW_INTERNAL_SECRET in production mode', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.WORKFLOW_INTERNAL_SECRET;

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      validateEnv();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_INTERNAL_SECRET is missing'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('rejects placeholder WORKFLOW_INTERNAL_SECRET in VERCEL mode', () => {
      process.env.VERCEL = '1';
      process.env.WORKFLOW_INTERNAL_SECRET = 'workflow_internal_secret_placeholder';

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      validateEnv();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_INTERNAL_SECRET is missing or a placeholder'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});
