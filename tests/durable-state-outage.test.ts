import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requireDurableDependencies,
  resetSchemaReadinessForTests,
} from '../src/server/storage/readiness.js';
import { DurableStateError } from '../src/server/storage/errors.js';
import { runAgentPipeline } from '../src/server/agent/orchestrator.js';
import agentRunHandler from '../api/workflows/agentRun.js';
import cronHandler from '../api/cron/poll.js';
import { KvRateLimitStore } from '../src/server/rateLimitStore.js';
import { isEventDuplicate, isMessageDuplicate } from '../src/server/state.js';

// Mocks
vi.mock('../src/server/storage/db.js', () => ({
  isDbAvailable: vi.fn().mockResolvedValue(true),
  getDbPool: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/server/storage/migrations.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/redis.js', () => ({
  isRedisConfigured: vi.fn().mockReturnValue(true),
  pingRedis: vi.fn().mockResolvedValue(true),
  getRedisClient: vi.fn().mockResolvedValue(null),
  setRedisValueNX: vi.fn().mockResolvedValue(true),
  getRedisValue: vi.fn().mockResolvedValue(null),
  getRedisJson: vi.fn().mockResolvedValue(null),
  setRedisJson: vi.fn().mockResolvedValue(true),
  del: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/agent/intent.js', () => ({
  classifyIntent: vi.fn().mockResolvedValue({ intent: 'direct_reply', confidence: 'high', source: 'rules' }),
}));

vi.mock('../src/server/agent/maintenance.js', () => ({
  runSystemMaintenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/agent/handlers/index.js', () => ({
  handleDirectReply: vi.fn().mockResolvedValue({ status: 'success', intent: 'direct_reply' }),
  handleStatusQuery: vi.fn().mockResolvedValue({ status: 'success', intent: 'status_query' }),
  handleApprovalResponse: vi.fn().mockResolvedValue({ status: 'success', intent: 'approval_response' }),
  handleCancelOrUpdate: vi.fn().mockResolvedValue({ status: 'success', intent: 'cancel_or_update' }),
  handleUnsafeOrUnsupported: vi.fn().mockResolvedValue({ status: 'success', intent: 'unsafe_or_unsupported' }),
  handleDurableTask: vi.fn().mockResolvedValue({ status: 'success', intent: 'durable_task' }),
}));

describe('P0 Item 2 Durable-State Remediation Suite', () => {
  const originalEnv = { ...process.env };

  async function resetDependencyMocks() {
    const { isDbAvailable } = await import('../src/server/storage/db.js');
    const { isRedisConfigured, pingRedis } = await import('../src/server/redis.js');
    vi.mocked(isDbAvailable).mockReset();
    vi.mocked(isDbAvailable).mockResolvedValue(true);
    vi.mocked(isRedisConfigured).mockReset();
    vi.mocked(isRedisConfigured).mockReturnValue(true);
    vi.mocked(pingRedis).mockReset();
    vi.mocked(pingRedis).mockResolvedValue(true);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.REQUIRE_DURABLE_STATE;
    delete process.env.REQUIRE_REDIS;
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    delete process.env.SQL_HOST;
    await resetDependencyMocks();
    resetSchemaReadinessForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    resetSchemaReadinessForTests();
  });

  describe('1. Readiness Gate & Dependency Checks', () => {
    it('throws DurableStateError when database is unreachable in strict mode', async () => {
      process.env.REQUIRE_DURABLE_STATE = 'true';
      process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
      const { isDbAvailable } = await import('../src/server/storage/db.js');
      vi.mocked(isDbAvailable).mockResolvedValue(false);

      await expect(requireDurableDependencies()).rejects.toMatchObject({
        name: 'DurableStateError',
        message: 'Database is unreachable or unavailable',
        code: 'DATABASE_UNAVAILABLE',
      });
    });

    it('throws DurableStateError when Redis is unconfigured in strict mode', async () => {
      process.env.REQUIRE_REDIS = 'true';
      process.env.REQUIRE_DURABLE_STATE = 'false';
      const { isRedisConfigured } = await import('../src/server/redis.js');
      vi.mocked(isRedisConfigured).mockReturnValue(false);

      await expect(requireDurableDependencies()).rejects.toMatchObject({
        name: 'DurableStateError',
        message: expect.stringContaining('Redis configuration is missing'),
        code: 'REDIS_UNAVAILABLE',
      });
    });

    it('throws DurableStateError when Redis ping fails in strict mode', async () => {
      process.env.REQUIRE_REDIS = 'true';
      process.env.REQUIRE_DURABLE_STATE = 'false';
      const { pingRedis } = await import('../src/server/redis.js');
      vi.mocked(pingRedis).mockResolvedValue(false);

      await expect(requireDurableDependencies()).rejects.toMatchObject({
        name: 'DurableStateError',
        message: 'Redis store is unreachable or unavailable',
        code: 'REDIS_UNAVAILABLE',
      });
    });

    it('passes successfully when both DB and Redis are healthy', async () => {
      process.env.REQUIRE_DURABLE_STATE = 'true';
      process.env.REQUIRE_REDIS = 'true';
      process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';

      await expect(requireDurableDependencies()).resolves.toBeUndefined();
    });
  });

  describe('2. Workflow Entrypoint Failure Behavior', () => {
    it('returns HTTP 503 from agentRun handler when DB is down', async () => {
      process.env.REQUIRE_DURABLE_STATE = 'true';
      const { isDbAvailable } = await import('../src/server/storage/db.js');
      vi.mocked(isDbAvailable).mockResolvedValueOnce(false);

      const req = {
        method: 'POST',
        body: {
          event: { text: 'Hello', channel: 'C123', user: 'U123', ts: '100.00' },
          eventId: 'ev123',
          workspaceId: 'W123'
        }
      };

      let statusCode = 0;
      let responseBody: any = null;
      const res = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => { responseBody = data; }
          };
        }
      };

      await agentRunHandler(req, res);

      expect(statusCode).toBe(503);
      expect(responseBody).toEqual({ error: 'Service temporarily unavailable due to storage outage.' });
    });

    it('returns HTTP 503 from cron poller when Redis is down in strict mode', async () => {
      process.env.REQUIRE_REDIS = 'true';
      const { pingRedis } = await import('../src/server/redis.js');
      vi.mocked(pingRedis).mockResolvedValueOnce(false);

      const req = {
        headers: { authorization: 'Bearer test-secret' }
      };

      process.env.CRON_SECRET = 'test-secret';

      let statusCode = 0;
      let responseBody: any = null;
      const res = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => { responseBody = data; }
          };
        }
      };

      await cronHandler(req, res);

      expect(statusCode).toBe(503);
      expect(responseBody).toEqual({ error: 'Service temporarily unavailable due to storage outage.' });
    });
  });

  describe('3. Orchestration Boundary Precondition', () => {
    it('runAgentPipeline rejects before handler dispatch when DB is unavailable', async () => {
      process.env.REQUIRE_DURABLE_STATE = 'true';

      const input = {
        workspaceId: 'W1',
        channelId: 'C1',
        userId: 'U1',
        messageText: 'do something',
        eventId: 'E1',
        messageTs: '100',
        threadTs: '100',
        selectedModel: 'gemini-3.1-flash-lite',
        signatureValid: true,
        sourceType: 'slack' as const,
        dbAvailable: false
      };

      await expect(runAgentPipeline(input)).rejects.toThrow(DurableStateError);

      const { handleDirectReply, handleDurableTask } = await import('../src/server/agent/handlers/index.js');
      expect(handleDirectReply).not.toHaveBeenCalled();
      expect(handleDurableTask).not.toHaveBeenCalled();
    });
  });

  describe('4. Rate Limiter Fail-Closed in Strict Mode', () => {
    it('KvRateLimitStore throws DurableStateError when Redis is unavailable in strict mode', async () => {
      process.env.REQUIRE_REDIS = 'true';
      const store = new KvRateLimitStore();
      store.init({ windowMs: 60_000 });

      const { getRedisClient } = await import('../src/server/redis.js');
      vi.mocked(getRedisClient).mockResolvedValueOnce(null);

      await expect(store.increment('127.0.0.1')).rejects.toThrow(DurableStateError);
    });
  });

  describe('5. Multi-Instance Event Deduplication', () => {
    it('detects duplicate events via shared Redis setRedisValueNX', async () => {
      const { setRedisValueNX } = await import('../src/server/redis.js');
      vi.mocked(setRedisValueNX).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const firstCall = await isEventDuplicate('event-12345');
      expect(firstCall).toBe(false);

      const secondCall = await isEventDuplicate('event-12345');
      expect(secondCall).toBe(true);
    });
  });
});
