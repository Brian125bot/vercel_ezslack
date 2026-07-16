import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
const {
  mockAgentStore,
  mockSlackReply,
  mockFinalizeRun,
  mockResumeAgentPipeline,
  mockMutatePlan,
  mockEnqueueRunTask,
  mockGenerateSimpleResponse,
  mockGetThreadHistory,
  mockSaveThreadHistory,
  mockUpdateApprovalMessage
} = vi.hoisted(() => ({
  mockAgentStore: {
    getActiveRunsByChannel: vi.fn().mockResolvedValue([]),
    appendAuditEvent: vi.fn().mockResolvedValue({}),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    resolveApproval: vi.fn().mockResolvedValue({}),
    getRun: vi.fn().mockResolvedValue({}),
    createGoal: vi.fn().mockResolvedValue({ id: 'goal-123', title: 'test-goal' }),
    createScheduledTrigger: vi.fn().mockResolvedValue({ id: 'trigger-123' }),
    createRun: vi.fn().mockResolvedValue({ id: 'run-123' }),
    updateRunStatus: vi.fn().mockResolvedValue({}),
    updateGoalStatus: vi.fn().mockResolvedValue({}),
  },
  mockSlackReply: {
    execute: vi.fn().mockResolvedValue({ status: 'success' })
  },
  mockFinalizeRun: vi.fn().mockResolvedValue({}),
  mockResumeAgentPipeline: vi.fn().mockResolvedValue({}),
  mockMutatePlan: vi.fn().mockResolvedValue({ success: true, summary: 'mutated' }),
  mockEnqueueRunTask: vi.fn().mockResolvedValue(true),
  mockGenerateSimpleResponse: vi.fn().mockResolvedValue('Hello response'),
  mockGetThreadHistory: vi.fn().mockResolvedValue([]),
  mockSaveThreadHistory: vi.fn().mockResolvedValue({}),
  mockUpdateApprovalMessage: vi.fn().mockResolvedValue({})
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/tools/slack.js', () => ({
  slackReplyInThreadTool: mockSlackReply,
  updateApprovalMessage: mockUpdateApprovalMessage,
  postApprovalBlockKit: vi.fn()
}));

vi.mock('../src/server/agent/finalize.js', () => ({
  finalizeRun: mockFinalizeRun
}));

vi.mock('../src/server/agent/orchestrator.js', () => ({
  resumeAgentPipeline: mockResumeAgentPipeline
}));

vi.mock('../src/server/agent/planMutation.js', () => ({
  mutatePlan: mockMutatePlan
}));

vi.mock('../src/server/agent/taskClient.js', () => ({
  enqueueRunTask: mockEnqueueRunTask
}));

vi.mock('../src/server/ai.js', () => ({
  generateSimpleResponse: mockGenerateSimpleResponse
}));

vi.mock('../src/server/state.js', () => ({
  getThreadHistory: mockGetThreadHistory,
  saveThreadHistory: mockSaveThreadHistory
}));

// ---- Import Handlers ----
import { handleDirectReply } from '../src/server/agent/handlers/directReply.js';
import { handleUnsafeOrUnsupported } from '../src/server/agent/handlers/unsafeUnsupported.js';
import { handleStatusQuery } from '../src/server/agent/handlers/statusQuery.js';
import { handleApprovalResponse } from '../src/server/agent/handlers/approvalResponse.js';
import { handleCancelOrUpdate } from '../src/server/agent/handlers/cancelUpdate.js';
import { handleDurableTask } from '../src/server/agent/handlers/durableTask.js';

describe('handlers.test.ts', () => {
  const context: any = { channelId: 'c1' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackReply.execute.mockReset();
    mockSlackReply.execute.mockResolvedValue({ status: 'success' });
    mockAgentStore.getActiveRunsByChannel.mockResolvedValue([]);
    mockAgentStore.getPendingApprovals.mockResolvedValue([]);
    mockAgentStore.createGoal.mockResolvedValue({ id: 'goal-123', title: 'test-goal' });
    mockAgentStore.createScheduledTrigger.mockResolvedValue({ id: 'trigger-123' });
    mockAgentStore.createRun.mockResolvedValue({ id: 'run-123' });
    mockEnqueueRunTask.mockResolvedValue(true);
    mockGenerateSimpleResponse.mockResolvedValue('Hello response');
    mockGetThreadHistory.mockResolvedValue([]);
    mockMutatePlan.mockResolvedValue({ success: true, summary: 'mutated' });
  });

  describe('directReply', () => {
    it('handles direct replies successfully', async () => {
      const input: any = {
        messageText: 'Hello AI',
        channelId: 'chan-1',
        threadTs: 'thread-123',
        selectedModel: 'flash',
        attachments: []
      };

      const result = await handleDirectReply(input, context);
      expect(result).toEqual({ status: 'success', intent: 'direct_reply' });
      expect(mockGenerateSimpleResponse).toHaveBeenCalledWith('Hello AI', 'flash', [], []);
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'Hello response' }, context);
      expect(mockSaveThreadHistory).toHaveBeenCalled();
    });

    it('handles exceptions gracefully', async () => {
      mockGenerateSimpleResponse.mockRejectedValue(new Error('Generation error'));
      const input: any = { messageText: 'Hi', channelId: 'chan-1' };

      const result = await handleDirectReply(input, context);
      expect(result).toEqual({ status: 'error', intent: 'direct_reply', message: 'Generation error' });
    });
  });

  describe('unsafeUnsupported', () => {
    it('sends immediate static refusal', async () => {
      const input: any = { messageText: 'rm -rf /' };
      const result = await handleUnsafeOrUnsupported(input, context);

      expect(result).toEqual({ status: 'success', intent: 'unsafe_or_unsupported' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({
        text: 'I cannot fulfill this request as it is either unsafe, unsupported, or violates my security policy.'
      }, context);
    });

    it('handles errors gracefully', async () => {
      mockSlackReply.execute.mockRejectedValue(new Error('Slack unreachable'));
      const input: any = { messageText: 'rm -rf' };
      const result = await handleUnsafeOrUnsupported(input, context);

      expect(result).toEqual({ status: 'error', intent: 'unsafe_or_unsupported', message: 'Slack unreachable' });
    });
  });

  describe('statusQuery', () => {
    it('returns db-unavailable error fallback', async () => {
      const input: any = { dbAvailable: false };
      const result = await handleStatusQuery(input, context);

      expect(result).toEqual({ status: 'success', intent: 'status_query' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'Database is unavailable. Cannot check task status.' }, context);
    });

    it('returns no active runs text if database is empty', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', userId: 'u1' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([]);

      const result = await handleStatusQuery(input, context);
      expect(result).toEqual({ status: 'success', intent: 'status_query' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'There are currently no active tasks or runs in progress.' }, context);
    });

    it('returns a list of active runs when they exist', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', userId: 'u1' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([
        { id: 'run-long-id-123456', status: 'running', goal_id: 'goal-long-id-123456' }
      ]);

      const result = await handleStatusQuery(input, context);
      expect(result).toEqual({ status: 'success', intent: 'status_query' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({
        text: 'Here is the status of active runs:\n- Run run-long... : running (Goal goal-lon...)'
      }, context);
    });

    it('handles errors gracefully', async () => {
      const input: any = { dbAvailable: true };
      mockAgentStore.getActiveRunsByChannel.mockRejectedValue(new Error('Db query timeout'));

      const result = await handleStatusQuery(input, context);
      expect(result).toEqual({ status: 'error', intent: 'status_query', message: 'Db query timeout' });
    });
  });

  describe('approvalResponse', () => {
    it('returns db-unavailable error fallback', async () => {
      const input: any = { dbAvailable: false };
      const result = await handleApprovalResponse(input, context);

      expect(result).toEqual({ status: 'success', intent: 'approval_response' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'Database is unavailable. Cannot process approvals.' }, context);
    });

    it('notifies when there are no pending approvals', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1' };
      mockAgentStore.getPendingApprovals.mockResolvedValue([]);

      const result = await handleApprovalResponse(input, context);
      expect(result).toEqual({ status: 'success', intent: 'approval_response' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'There are no pending approvals to resolve at the moment.' }, context);
    });

    it('handles ambiguous user response', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', messageText: 'maybe yes maybe no', userId: 'u1' };
      const approval = { id: 'app-1', goal_id: 'g1', run_id: 'r1', step_id: 's1' };
      mockAgentStore.getPendingApprovals.mockResolvedValue([approval]);

      const result = await handleApprovalResponse(input, context);
      expect(result).toEqual({ status: 'success', intent: 'approval_response' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({
        text: "I couldn't clearly understand if you are approving or rejecting. Please reply explicitly with 'approve' or 'reject'."
      }, context);
      expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.ambiguous' }));
    });

    it('resolves approval and resumes run on approval', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', messageText: 'approve', userId: 'u1' };
      const approval = { id: 'app-1', goal_id: 'g1', run_id: 'r1', step_id: 's1', message_ts: 'ts-123', channel_id: 'c1', proposed_action: { tool: 'email' } };
      mockAgentStore.getPendingApprovals.mockResolvedValue([approval]);

      const result = await handleApprovalResponse(input, context);
      expect(result).toEqual({ status: 'success', intent: 'approval_response' });
      expect(mockAgentStore.resolveApproval).toHaveBeenCalledWith('app-1', 'approved');
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'Task has been approved and will resume.' }, context);
      expect(mockResumeAgentPipeline).toHaveBeenCalledWith('r1');
    });

    it('resolves rejection and finalizes run on rejection', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', messageText: 'reject', userId: 'u1' };
      const approval = { id: 'app-1', goal_id: 'g1', run_id: 'r1', step_id: 's1', message_ts: 'ts-123', channel_id: 'c1' };
      mockAgentStore.getPendingApprovals.mockResolvedValue([approval]);
      const run = { id: 'r1' };
      mockAgentStore.getRun.mockResolvedValue(run);

      const result = await handleApprovalResponse(input, context);
      expect(result).toEqual({ status: 'success', intent: 'approval_response' });
      expect(mockAgentStore.resolveApproval).toHaveBeenCalledWith('app-1', 'rejected');
      expect(mockFinalizeRun).toHaveBeenCalledWith(run, 'cancelled', 'User rejected the approval request');
    });

    it('handles errors gracefully', async () => {
      const input: any = { dbAvailable: true, workspaceId: 'w1', channelId: 'c1', messageText: 'approve' };
      mockAgentStore.getPendingApprovals.mockRejectedValue(new Error('resolve crash'));

      const result = await handleApprovalResponse(input, context);
      expect(result).toEqual({ status: 'error', intent: 'approval_response', message: 'resolve crash' });
    });
  });

  describe('cancelUpdate', () => {
    it('returns db-unavailable error fallback', async () => {
      const input: any = { dbAvailable: false };
      const result = await handleCancelOrUpdate(input, context);

      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'Database is unavailable. Cannot cancel or update tasks.' }, context);
    });

    it('cancel path: warns when no active runs exist', async () => {
      const input: any = { dbAvailable: true, messageText: 'cancel please' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([]);

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'There are no active tasks to cancel.' }, context);
    });

    it('cancel path: finalizes all active runs', async () => {
      const input: any = { dbAvailable: true, messageText: 'abort' };
      const run1 = { id: 'r1' };
      const run2 = { id: 'r2' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([run1, run2]);

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockFinalizeRun).toHaveBeenCalledTimes(2);
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'I have cancelled 2 active task(s).' }, context);
    });

    it('update path: warns when no active runs exist', async () => {
      const input: any = { dbAvailable: true, messageText: 'add a step to review logs' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([]);

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'There are no active tasks to update.' }, context);
    });

    it('update path: handles active run with missing planId', async () => {
      const input: any = { dbAvailable: true, messageText: 'add step' };
      const run = { id: 'r1', plan_id: null };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([run]);

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({
        text: "The active task doesn't have a plan yet — it's still in the planning phase. I'll incorporate your feedback when the plan is created."
      }, context);
    });

    it('update path: mutates plan successfully', async () => {
      const input: any = { dbAvailable: true, messageText: 'add step', model: 'flash' };
      const run = { id: 'r1', plan_id: 'p1', model: 'flash' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([run]);

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockMutatePlan).toHaveBeenCalledWith('r1', 'p1', 'add step', 'flash');
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: '✅ Plan updated: mutated' }, context);
    });

    it('update path: handles mutation failure', async () => {
      const input: any = { dbAvailable: true, messageText: 'add step', model: 'flash' };
      const run = { id: 'r1', plan_id: 'p1', model: 'flash' };
      mockAgentStore.getActiveRunsByChannel.mockResolvedValue([run]);
      mockMutatePlan.mockResolvedValue({ success: false, summary: 'no pending steps' });

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'success', intent: 'cancel_or_update' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: '⚠️ Could not update the plan: no pending steps' }, context);
    });

    it('handles errors gracefully', async () => {
      const input: any = { dbAvailable: true, messageText: 'cancel' };
      mockAgentStore.getActiveRunsByChannel.mockRejectedValue(new Error('cancel error'));

      const result = await handleCancelOrUpdate(input, context);
      expect(result).toEqual({ status: 'error', intent: 'cancel_or_update', message: 'cancel error' });
    });
  });

  describe('durableTask', () => {
    it('returns db-unavailable error fallback', async () => {
      const input: any = { dbAvailable: false };
      const result = await handleDurableTask(input, context);

      expect(result).toEqual({ status: 'success', intent: 'durable_task' });
      expect(mockSlackReply.execute).toHaveBeenCalledWith({ text: 'I cannot perform durable tasks right now because the database is unavailable.' }, context);
    });

    it('schedules time-deferred trigger when deferred language is detected', async () => {
      const input: any = {
        dbAvailable: true,
        messageText: 'remind me in 10 minutes to deploy',
        workspaceId: 'w1',
        channelId: 'c1',
        userId: 'u1',
        sourceType: 'slack',
        threadTs: 't1',
        messageTs: 'm1'
      };

      const result = await handleDurableTask(input, context);
      expect(result).toEqual({ status: 'success', intent: 'durable_task' });
      expect(mockAgentStore.createGoal).toHaveBeenCalled();
      expect(mockAgentStore.createScheduledTrigger).toHaveBeenCalled();
      expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'trigger.created' }));
      expect(mockSlackReply.execute).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("Got it — I'll remind you in 10 minutes at")
      }), context);
    });

    it('queues run and triggers workflow immediately for non-deferred task', async () => {
      const input: any = {
        dbAvailable: true,
        messageText: 'build this project',
        workspaceId: 'w1',
        channelId: 'c1',
        userId: 'u1',
        sourceType: 'slack',
        selectedModel: 'flash',
        attachments: []
      };

      const result = await handleDurableTask(input, context);
      expect(result).toEqual({ status: 'success', runId: 'run-123', intent: 'durable_task' });
      expect(mockAgentStore.createGoal).toHaveBeenCalled();
      expect(mockAgentStore.createRun).toHaveBeenCalled();
      expect(mockEnqueueRunTask).toHaveBeenCalledWith('run-123');
      expect(mockSlackReply.execute).toHaveBeenCalledWith({
        text: 'I have accepted your goal: "test-goal". Analyzing constraints and drafting a plan...'
      }, context);
    });

    it('handles enqueue failure gracefully', async () => {
      const input: any = {
        dbAvailable: true,
        messageText: 'build this project',
        workspaceId: 'w1',
        channelId: 'c1',
        userId: 'u1',
        sourceType: 'slack',
        selectedModel: 'flash',
        attachments: []
      };
      mockEnqueueRunTask.mockResolvedValue(false);

      const result = await handleDurableTask(input, context);
      expect(result).toEqual({ status: 'error', intent: 'durable_task', message: 'Failed to enqueue run' });
      expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-123', 'failed', { failure_reason: 'Failed to enqueue run' });
      expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-123', 'failed');
    });

    it('handles throw exceptions gracefully', async () => {
      const input: any = { dbAvailable: true, messageText: 'build this project' };
      mockAgentStore.createGoal.mockRejectedValue(new Error('Store full'));

      const result = await handleDurableTask(input, context);
      expect(result).toEqual({ status: 'error', intent: 'durable_task', message: 'Store full', runId: undefined });
    });
  });
});
