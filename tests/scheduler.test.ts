import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAgentStore, mockEnqueueRunTask } = vi.hoisted(() => ({
  mockAgentStore: {
    getDueScheduledTriggers: vi.fn(),
    getGoal: vi.fn(),
    getRunsForGoal: vi.fn(),
    createRun: vi.fn(),
    appendAuditEvent: vi.fn(),
    reinsertScheduledTrigger: vi.fn(),
    updateGoalStatus: vi.fn(),
  },
  mockEnqueueRunTask: vi.fn()
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/taskClient.js', () => ({
  enqueueRunTask: mockEnqueueRunTask
}));

import { pollScheduledTriggers } from '../src/server/agent/scheduler.js';

describe('scheduler.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('polls when no triggers are due', async () => {
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([]);
    await pollScheduledTriggers();
    expect(mockAgentStore.getDueScheduledTriggers).toHaveBeenCalled();
    expect(mockAgentStore.getGoal).not.toHaveBeenCalled();
  });

  it('polls, fires and schedules next run for recurring trigger (interval_seconds)', async () => {
    const trigger = {
      id: 'tr-1',
      goal_id: 'g-1',
      interval_seconds: 60,
      timezone: 'UTC'
    };
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([trigger]);
    mockAgentStore.getGoal.mockResolvedValue({ id: 'g-1', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([{ model: 'gemini-3.1-flash-lite' }]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    await pollScheduledTriggers();

    expect(mockAgentStore.createRun).toHaveBeenCalledWith({
      goal_id: 'g-1',
      model: 'gemini-3.1-flash-lite',
      status: 'queued'
    });
    expect(mockAgentStore.reinsertScheduledTrigger).toHaveBeenCalledWith(trigger, expect.any(Date));
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('g-1', 'running');
    expect(mockEnqueueRunTask).toHaveBeenCalledWith('run-123');
  });

  it('polls and fires one-shot trigger (no cron/interval)', async () => {
    const trigger = {
      id: 'tr-1',
      goal_id: 'g-1',
      timezone: 'UTC'
    };
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([trigger]);
    mockAgentStore.getGoal.mockResolvedValue({ id: 'g-1', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    await pollScheduledTriggers();

    expect(mockAgentStore.createRun).toHaveBeenCalledWith({
      goal_id: 'g-1',
      model: 'gemini-2.5-flash', // fallback model
      status: 'queued'
    });
    expect(mockAgentStore.reinsertScheduledTrigger).toHaveBeenCalledWith(trigger, null);
  });

  it('handles cron triggers successfully with cron-parser', async () => {
    const trigger = {
      id: 'tr-1',
      goal_id: 'g-1',
      cron: '0 0 * * *', // daily at midnight
      timezone: 'UTC'
    };
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([trigger]);
    mockAgentStore.getGoal.mockResolvedValue({ id: 'g-1', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    await pollScheduledTriggers();

    expect(mockAgentStore.reinsertScheduledTrigger).toHaveBeenCalledWith(trigger, expect.any(Date));
  });

  it('handles invalid cron triggers gracefully falling back to default next runs', async () => {
    const trigger = {
      id: 'tr-1',
      goal_id: 'g-1',
      cron: 'invalid-cron-expr',
      timezone: 'UTC'
    };
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([trigger]);
    mockAgentStore.getGoal.mockResolvedValue({ id: 'g-1', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    await pollScheduledTriggers();

    // With invalid cron-parser expr, it falls back to basic parsing. "invalid-cron-expr" doesn't have 5 parts,
    // so it will fall back to ultimate fallback: 1 hour.
    expect(mockAgentStore.reinsertScheduledTrigger).toHaveBeenCalledWith(trigger, expect.any(Date));
  });

  it('handles simple 5-part wildcard cron fallback parsing', async () => {
    const trigger = {
      id: 'tr-1',
      goal_id: 'g-1',
      cron: '* * * * *',
      timezone: 'UTC'
    };
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([trigger]);
    mockAgentStore.getGoal.mockResolvedValue({ id: 'g-1', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    // Mock cron-parser import/parse failure so the fallback code executes
    // To do this, let's mock cron-parser's parse to throw
    vi.mock('cron-parser', () => {
      return {
        CronExpressionParser: {
          parse: () => {
            throw new Error('Simulated cron-parser error');
          }
        }
      };
    });

    await pollScheduledTriggers();
    expect(mockAgentStore.reinsertScheduledTrigger).toHaveBeenCalledWith(trigger, expect.any(Date));
  });

  it('handles error in loop processing without crashing the whole poll', async () => {
    mockAgentStore.getDueScheduledTriggers.mockResolvedValue([
      { id: 'tr-1', goal_id: 'g-1' },
      { id: 'tr-2', goal_id: 'g-2' }
    ]);
    mockAgentStore.getGoal.mockRejectedValueOnce(new Error('Goal db error'));
    mockAgentStore.getGoal.mockResolvedValueOnce({ id: 'g-2', workspace_id: 'ws-1' });
    mockAgentStore.getRunsForGoal.mockResolvedValue([]);
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });

    await pollScheduledTriggers();

    // Second trigger should still have been processed successfully
    expect(mockAgentStore.createRun).toHaveBeenCalledTimes(1);
  });

  it('handles error in outer try-catch of pollScheduledTriggers', async () => {
    mockAgentStore.getDueScheduledTriggers.mockRejectedValue(new Error('Outer DB error'));
    await expect(pollScheduledTriggers()).resolves.toBeUndefined();
  });
});
