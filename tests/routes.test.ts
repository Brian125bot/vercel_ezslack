import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
// routes.ts imports a wide surface (state, intent, orchestrator, agentStore,
// db, semaphore, auth). We stub them all so the test only exercises the
// /api/status and /api/model/select route handlers, not their collaborators.
const {
  selectedModel,
  setSelectedModel,
  getSelectedModel,
  addLog,
  updateLog,
  getLogs,
  clearLogs,
  isEventDuplicate,
  isMessageDuplicate,
  agentStore,
  isDbAvailable,
  runAgentPipeline,
  Semaphore,
  ensureSchemaReady,
  getSchemaReadiness,
} = vi.hoisted(() => ({
  selectedModel: 'gemini-3.1-flash-lite',
  setSelectedModel: vi.fn(),
  getSelectedModel: vi.fn().mockResolvedValue('gemini-3.1-flash-lite'),
  addLog: vi.fn(),
  updateLog: vi.fn(),
  getLogs: vi.fn().mockResolvedValue([]),
  clearLogs: vi.fn().mockResolvedValue(undefined),
  isEventDuplicate: vi.fn().mockResolvedValue(false),
  isMessageDuplicate: vi.fn().mockResolvedValue(false),
  agentStore: {
    listRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    getRunTrace: vi.fn().mockResolvedValue({ run: { id: 'r-1' }, steps: [], toolCalls: [] }),
    listScheduledTriggers: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    listSubAgents: vi.fn().mockResolvedValue([]),
    listMemories: vi.fn().mockResolvedValue([]),
    createSkill: vi.fn().mockResolvedValue({}),
    updateSkill: vi.fn().mockResolvedValue({}),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    upsertSubAgent: vi.fn().mockResolvedValue({}),
    deleteSubAgent: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  },
  isDbAvailable: vi.fn().mockResolvedValue(true),
  runAgentPipeline: vi.fn().mockResolvedValue({ status: 'success', message: 'ok' }),
  Semaphore: class { acquire() {} release() {} },
  ensureSchemaReady: vi.fn().mockResolvedValue(undefined),
  getSchemaReadiness: vi.fn().mockReturnValue({ state: 'ready', ready: true, lastFailureAt: null }),
}));

vi.mock('../src/server/auth.js', () => ({
  requireDashboardAuth: (_req: any, _res: any, next: any) => next(),
  isRedisConfigured: vi.fn().mockReturnValue(false),
  recordAuthFailure: vi.fn().mockResolvedValue(0),
  isAuthLockedOut: vi.fn().mockResolvedValue(false),
  lockoutAuth: vi.fn().mockResolvedValue(undefined),
  resetAuthFailures: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/server/state.js', () => ({
  selectedModel,
  setSelectedModel,
  getSelectedModel,
  addLog,
  updateLog,
  getLogs,
  clearLogs,
  isEventDuplicate,
  isMessageDuplicate,
}));

vi.mock('../src/server/agent/intent.js', () => ({
  classifyIntent: vi.fn().mockResolvedValue({ intent: 'direct_reply', confidence: 0.9, source: 'rule' }),
}));

vi.mock('../src/server/storage/agentStore.js', () => ({ agentStore }));

vi.mock('../src/server/storage/db.js', () => ({ isDbAvailable }));

vi.mock('../src/server/storage/readiness.js', () => ({
  ensureSchemaReady,
  getSchemaReadiness,
}));

vi.mock('../src/server/agent/orchestrator.js', () => ({ runAgentPipeline }));

vi.mock('../src/server/agent/semaphore.js', () => ({ Semaphore }));

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// ── Helpers ──────────────────────────────────────────────────────────────────
function findRoute(router: any, method: string, path: string): any {
  const layer = router.stack.find((l: any) =>
    l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found in router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res;
}

function mockReq(overrides: any = {}): any {
  return {
    ip: '127.0.0.1',
    body: {},
    query: {},
    params: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    get: vi.fn().mockReturnValue(''),
    rawBody: Buffer.alloc(0),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('Dashboard routes — Gemini 3.8 Flash support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.GEMINI_API_KEY;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.APP_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    delete process.env.SQL_HOST;
    ensureSchemaReady.mockResolvedValue(undefined);
    getSchemaReadiness.mockReturnValue({ state: 'ready', ready: true, lastFailureAt: null });
  });

  it('GET /api/health remains a liveness check without schema work', async () => {
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'GET', '/health');
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(ensureSchemaReady).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('GET /api/readiness reports ready only after schema preparation succeeds', async () => {
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'GET', '/readiness');
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(ensureSchemaReady).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ready',
      schema: { state: 'ready', ready: true, lastFailureAt: null },
    });
  });

  it('GET /api/readiness reports a retryable unavailable state after a migration failure', async () => {
    ensureSchemaReady.mockRejectedValueOnce(new Error('migration failed'));
    getSchemaReadiness.mockReturnValueOnce({ state: 'failed', ready: false, lastFailureAt: '2026-08-22T00:00:00.000Z' });
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'GET', '/readiness');
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: 'not_ready',
      schema: { state: 'failed', ready: false, lastFailureAt: '2026-08-22T00:00:00.000Z' },
    });
  });

  it('GET /api/status includes gemini-3.8-flash in availableModels with matching name and description', async () => {
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'GET', '/status');
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.availableModels).toBeDefined();

    const flash38 = payload.availableModels.find((m: any) => m.id === 'gemini-3.8-flash');
    expect(flash38).toBeDefined();
    expect(flash38.name).toBe('Gemini 3.8 Flash');
    expect(flash38.description).toMatch(/next-gen flagship/i);
    // It must be the first entry so the dashboard surfaces the newest model first.
    expect(payload.availableModels[0].id).toBe('gemini-3.8-flash');
  });

  it('POST /api/model/select accepts gemini-3.8-flash and returns success', async () => {
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'POST', '/model/select');
    const req = mockReq({ body: { model: 'gemini-3.8-flash' } });
    const res = mockRes();

    await handler(req, res);

    expect(setSelectedModel).toHaveBeenCalledWith('gemini-3.8-flash');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('POST /api/model/select still rejects unknown models (sanity check)', async () => {
    const { router } = await import('../src/server/routes.js');
    const handler = findRoute(router, 'POST', '/model/select');
    const req = mockReq({ body: { model: 'gemini-99-ultra' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(setSelectedModel).not.toHaveBeenCalled();
  });
});
