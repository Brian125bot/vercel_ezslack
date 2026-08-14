import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockAuthAllows } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockAuthAllows: { value: true }
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<any>) => promise
}));

vi.mock('../src/server/auth.js', () => ({
  requireDashboardAuth: (_req: any, res: any, next: any) => {
    if (!mockAuthAllows.value) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }
}));

vi.mock('../src/server/storage/db.js', () => ({
  query: mockQuery,
  isDbAvailable: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: {
    listRuns: vi.fn(),
    getRunTrace: vi.fn(),
    getGoal: vi.fn(),
    searchMemory: vi.fn(),
    listAuditEvents: vi.fn(),
    resolveApproval: vi.fn(),
    appendAuditEvent: vi.fn(),
    updateRunStatus: vi.fn(),
    updateGoalStatus: vi.fn(),
  }
}));

vi.mock('../src/server/state.js', () => ({
  selectedModel: 'gemini-3.1-flash-lite',
  setSelectedModel: vi.fn(),
  addLog: vi.fn(),
  updateLog: vi.fn(),
  getLogs: vi.fn().mockResolvedValue([]),
  clearLogs: vi.fn(),
  getSelectedModel: vi.fn().mockResolvedValue('gemini-3.1-flash-lite'),
  isEventDuplicate: vi.fn().mockResolvedValue(false),
  isMessageDuplicate: vi.fn().mockResolvedValue(false),
}));

vi.mock('../src/server/agent/intent.js', () => ({
  classifyIntent: vi.fn()
}));

vi.mock('../src/server/agent/orchestrator.js', () => ({
  runAgentPipeline: vi.fn()
}));

import { router } from '../src/server/routes.js';

let server: http.Server;
let baseUrl: string;

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  baseUrl = `http://127.0.0.1:${address.port}/api`;
}

describe('tool policy admin API', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuthAllows.value = true;
    await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  });

  it('requires dashboard auth', async () => {
    mockAuthAllows.value = false;

    const res = await fetch(`${baseUrl}/agent/tool-policy?workspace_id=ws-1`);

    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('lists all policy rows for a workspace', async () => {
    const rows = [
      { id: 'row-1', workspace_id: 'ws-1', channel_id: null, profile: 'minimal' },
      { id: 'row-2', workspace_id: 'ws-1', channel_id: 'C1', profile: 'coding' }
    ];
    mockQuery.mockResolvedValueOnce(rows);

    const res = await fetch(`${baseUrl}/agent/tool-policy?workspace_id=ws-1`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM tool_policies'), ['ws-1']);
  });

  it('rejects channel_id as an empty string', async () => {
    const res = await fetch(`${baseUrl}/agent/tool-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws-1', channel_id: '', profile: 'minimal' })
    });

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid profile', async () => {
    const res = await fetch(`${baseUrl}/agent/tool-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws-1', profile: 'unknown' })
    });

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('upserts the same workspace/channel scope twice without a duplicate path', async () => {
    mockQuery
      .mockResolvedValueOnce([{ id: 'row-1', workspace_id: 'ws-1', channel_id: 'C1', profile: 'minimal' }])
      .mockResolvedValueOnce([{ id: 'row-1', workspace_id: 'ws-1', channel_id: 'C1', profile: 'coding' }]);

    const first = await fetch(`${baseUrl}/agent/tool-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws-1', channel_id: 'C1', profile: 'minimal' })
    });
    const second = await fetch(`${baseUrl}/agent/tool-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws-1', channel_id: 'C1', profile: 'coding' })
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: 'row-1', workspace_id: 'ws-1', channel_id: 'C1', profile: 'coding' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain("ON CONFLICT (workspace_id, COALESCE(channel_id, '')) DO UPDATE");
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws-1', 'C1', 'minimal']);
    expect(mockQuery.mock.calls[1][1]).toEqual(['ws-1', 'C1', 'coding']);
  });

  it('deletes a policy row', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const res = await fetch(`${baseUrl}/agent/tool-policy/row-1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockQuery).toHaveBeenCalledWith('DELETE FROM tool_policies WHERE id = $1', ['row-1']);
  });
});
