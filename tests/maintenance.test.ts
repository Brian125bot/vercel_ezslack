import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAgentStore, mockQuery, mockPollScheduledTriggers } = vi.hoisted(() => ({
  mockAgentStore: {
    recoverStaleClaims: vi.fn(),
    reapExpiredApprovals: vi.fn(),
  },
  mockQuery: vi.fn(),
  mockPollScheduledTriggers: vi.fn(),
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore,
}));

vi.mock('../src/server/storage/db.js', () => ({
  query: mockQuery,
}));

vi.mock('../src/server/agent/scheduler.js', () => ({
  pollScheduledTriggers: mockPollScheduledTriggers,
}));

import { runSystemMaintenance } from '../src/server/agent/maintenance.js';

describe('maintenance.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentStore.recoverStaleClaims.mockResolvedValue(0);
    mockAgentStore.reapExpiredApprovals.mockResolvedValue([]);
    mockQuery.mockResolvedValue([]);
    mockPollScheduledTriggers.mockResolvedValue(undefined);
  });

  it('runs all maintenance steps in order', async () => {
    mockAgentStore.recoverStaleClaims.mockResolvedValue(2);
    mockAgentStore.reapExpiredApprovals.mockResolvedValue([{ id: 'apr-1' }]);

    const result = await runSystemMaintenance('[Test]');

    expect(result).toEqual({ recovered: 2, expiredApprovals: 1 });
    expect(mockAgentStore.recoverStaleClaims).toHaveBeenCalledOnce();
    expect(mockAgentStore.reapExpiredApprovals).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM processed_events')
    );
    expect(mockPollScheduledTriggers).toHaveBeenCalledOnce();
  });

  it('continues when recoverStaleClaims fails', async () => {
    mockAgentStore.recoverStaleClaims.mockRejectedValue(new Error('db down'));

    const result = await runSystemMaintenance('[Test]');

    expect(result.recovered).toBe(0);
    expect(mockAgentStore.reapExpiredApprovals).toHaveBeenCalledOnce();
    expect(mockPollScheduledTriggers).toHaveBeenCalledOnce();
  });

  it('continues when reapExpiredApprovals fails', async () => {
    mockAgentStore.reapExpiredApprovals.mockRejectedValue(new Error('db down'));

    const result = await runSystemMaintenance('[Test]');

    expect(result.expiredApprovals).toBe(0);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockPollScheduledTriggers).toHaveBeenCalledOnce();
  });

  it('continues when processed_events cleanup fails', async () => {
    mockQuery.mockRejectedValue(new Error('delete failed'));

    await runSystemMaintenance('[Test]');

    expect(mockPollScheduledTriggers).toHaveBeenCalledOnce();
  });

  it('continues when pollScheduledTriggers fails', async () => {
    mockPollScheduledTriggers.mockRejectedValue(new Error('poll failed'));

    const result = await runSystemMaintenance('[Test]');

    expect(result).toEqual({ recovered: 0, expiredApprovals: 0 });
  });
});
