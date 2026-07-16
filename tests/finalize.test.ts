import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAgentStore, mockReportRunResult, mockReportStatus } = vi.hoisted(() => ({
  mockAgentStore: {
    updateRunStatus: vi.fn(),
    updateGoalStatus: vi.fn(),
    appendAuditEvent: vi.fn(),
    getGoal: vi.fn(),
    getRunTrace: vi.fn()
  },
  mockReportRunResult: vi.fn(),
  mockReportStatus: vi.fn()
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/reporter.js', () => ({
  reportRunResult: mockReportRunResult,
  reportStatus: mockReportStatus
}));

import { finalizeRun } from '../src/server/agent/finalize.js';

describe('finalize.ts - finalizeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReportRunResult.mockResolvedValue({});
    mockReportStatus.mockResolvedValue({});
  });

  it('finalizes a successful run and reports results', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    const goal: any = { id: 'goal-1', workspace_id: 'ws-1', source_channel_id: 'chan-1', created_by_user_id: 'user-1' };
    const trace: any = { run_id: 'run-1' };

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.getRunTrace.mockResolvedValue(trace);

    await finalizeRun(run, 'succeeded', 'Completed task successfully');

    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-1', 'succeeded', {
      result_summary: 'Completed task successfully',
      failure_reason: undefined
    });
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-1', 'completed');
    expect(mockReportRunResult).toHaveBeenCalledWith(trace, expect.objectContaining({
      runId: 'run-1',
      channelId: 'chan-1'
    }));
  });

  it('finalizes a failed run and reports results', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    const goal: any = { id: 'goal-1', workspace_id: 'ws-1', source_channel_id: 'chan-1', created_by_user_id: 'user-1' };
    const trace: any = { run_id: 'run-1' };

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.getRunTrace.mockResolvedValue(trace);

    await finalizeRun(run, 'failed', 'System crash');

    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-1', 'failed', {
      result_summary: 'System crash',
      failure_reason: 'System crash'
    });
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-1', 'failed');
  });

  it('finalizes blocked and cancelled runs correctly', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    const goal: any = { id: 'goal-1', workspace_id: 'ws-1', source_channel_id: 'chan-1', created_by_user_id: 'user-1' };
    const trace: any = { run_id: 'run-1' };

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.getRunTrace.mockResolvedValue(trace);

    await finalizeRun(run, 'cancelled', 'User cancelled');
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-1', 'cancelled');

    await finalizeRun(run, 'blocked', 'User blocked');
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-1', 'blocked');
  });

  it('falls back to simple reportStatus when reportRunResult fails', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    const goal: any = { id: 'goal-1', workspace_id: 'ws-1', source_channel_id: 'chan-1', created_by_user_id: 'user-1' };
    const trace: any = { run_id: 'run-1' };

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.getRunTrace.mockResolvedValue(trace);
    mockReportRunResult.mockRejectedValue(new Error('Rich report failed'));

    await finalizeRun(run, 'succeeded');

    expect(mockReportStatus).toHaveBeenCalledWith(
      'completed',
      'Run finished with status: succeeded. (Detailed report failed to send)',
      expect.objectContaining({ runId: 'run-1' })
    );
  });

  it('handles nested failure when simple reportStatus also fails', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    const goal: any = { id: 'goal-1', workspace_id: 'ws-1', source_channel_id: 'chan-1', created_by_user_id: 'user-1' };
    const trace: any = { run_id: 'run-1' };

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.getRunTrace.mockResolvedValue(trace);
    mockReportRunResult.mockRejectedValue(new Error('Rich report failed'));
    mockReportStatus.mockRejectedValue(new Error('Simple report failed'));

    await finalizeRun(run, 'succeeded');

    expect(mockAgentStore.updateRunStatus).toHaveBeenLastCalledWith('run-1', 'succeeded', {
      failure_reason: 'Completed but failed to report to Slack: Simple report failed'
    });
  });

  it('catches outer errors (e.g. goal lookup throws) gracefully', async () => {
    const run: any = { id: 'run-1', goal_id: 'goal-1' };
    mockAgentStore.getGoal.mockRejectedValue(new Error('Outer DB error'));

    await expect(finalizeRun(run, 'succeeded')).resolves.toBeUndefined();
  });
});
