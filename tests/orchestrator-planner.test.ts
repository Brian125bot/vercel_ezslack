import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
const {
  mockAgentStore,
  mockClassifyIntent,
  mockEnqueueRunTask,
  mockGeminiCall,
  mockAttachmentsToGeminiParts,
  mockHandleDirectReply,
  mockHandleStatusQuery,
  mockHandleApprovalResponse,
  mockHandleCancelOrUpdate,
  mockHandleUnsafeOrUnsupported,
  mockHandleDurableTask
} = vi.hoisted(() => ({
  mockAgentStore: {
    getRun: vi.fn(),
    updateRunStatus: vi.fn(),
    getStepsForPlan: vi.fn(),
    updateStepStatus: vi.fn(),
    appendAuditEvent: vi.fn(),
    hasPendingApproval: vi.fn(),
  },
  mockClassifyIntent: vi.fn(),
  mockEnqueueRunTask: vi.fn(),
  mockGeminiCall: vi.fn(),
  mockAttachmentsToGeminiParts: vi.fn().mockReturnValue([]),
  mockHandleDirectReply: vi.fn().mockResolvedValue({ status: 'success', intent: 'direct_reply' }),
  mockHandleStatusQuery: vi.fn().mockResolvedValue({ status: 'success', intent: 'status_query' }),
  mockHandleApprovalResponse: vi.fn().mockResolvedValue({ status: 'success', intent: 'approval_response' }),
  mockHandleCancelOrUpdate: vi.fn().mockResolvedValue({ status: 'success', intent: 'cancel_or_update' }),
  mockHandleUnsafeOrUnsupported: vi.fn().mockResolvedValue({ status: 'success', intent: 'unsafe_or_unsupported' }),
  mockHandleDurableTask: vi.fn().mockResolvedValue({ status: 'success', intent: 'durable_task' })
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/intent.js', () => ({
  classifyIntent: mockClassifyIntent
}));

vi.mock('../src/server/agent/taskClient.js', () => ({
  enqueueRunTask: mockEnqueueRunTask
}));

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: mockGeminiCall
}));

vi.mock('../src/server/agent/attachments.js', () => ({
  attachmentsToGeminiParts: mockAttachmentsToGeminiParts
}));

vi.mock('../src/server/agent/handlers/index.js', () => ({
  handleDirectReply: mockHandleDirectReply,
  handleStatusQuery: mockHandleStatusQuery,
  handleApprovalResponse: mockHandleApprovalResponse,
  handleCancelOrUpdate: mockHandleCancelOrUpdate,
  handleUnsafeOrUnsupported: mockHandleUnsafeOrUnsupported,
  handleDurableTask: mockHandleDurableTask
}));

import { resumeAgentPipeline, runAgentPipeline } from '../src/server/agent/orchestrator.js';
import { createPlan } from '../src/server/agent/planner.js';

describe('orchestrator.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resumeAgentPipeline', () => {
    it('resumes pipeline successfully and updates blocked steps to pending', async () => {
      const run = { id: 'r1', goal_id: 'g1', plan_id: 'p1' };
      const steps = [
        { id: 's1', status: 'blocked' },
        { id: 's2', status: 'succeeded' }
      ];
      mockAgentStore.getRun.mockResolvedValue(run);
      mockAgentStore.getStepsForPlan.mockResolvedValue(steps);
      mockEnqueueRunTask.mockResolvedValue(true);

      await resumeAgentPipeline('r1');

      expect(mockAgentStore.getRun).toHaveBeenCalledWith('r1');
      expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('r1', 'queued', expect.any(Object));
      expect(mockAgentStore.updateStepStatus).toHaveBeenCalledWith('s1', 'pending');
      expect(mockAgentStore.updateStepStatus).not.toHaveBeenCalledWith('s2', 'pending');
      expect(mockEnqueueRunTask).toHaveBeenCalledWith('r1');
    });
  });

  describe('runAgentPipeline', () => {
    it('uses existing intentResult and routes to correct handler', async () => {
      const input: any = {
        messageText: 'help',
        intentResult: { intent: 'direct_reply' }
      };

      const res = await runAgentPipeline(input);
      expect(res).toEqual({ status: 'success', intent: 'direct_reply' });
      expect(mockHandleDirectReply).toHaveBeenCalled();
      expect(mockClassifyIntent).not.toHaveBeenCalled();
    });

    it('classifies intent if not provided and routes to direct_reply', async () => {
      const input: any = {
        messageText: 'help',
        workspaceId: 'w1',
        channelId: 'c1',
        dbAvailable: true
      };
      mockAgentStore.hasPendingApproval.mockResolvedValue(true);
      mockClassifyIntent.mockResolvedValue({ intent: 'direct_reply' });

      const res = await runAgentPipeline(input);
      expect(res).toEqual({ status: 'success', intent: 'direct_reply' });
      expect(mockClassifyIntent).toHaveBeenCalledWith('help', undefined, expect.any(Object));
    });

    it('routes other intents correctly to their handlers', async () => {
      const intents: any[] = ['status_query', 'approval_response', 'cancel_or_update', 'unsafe_or_unsupported', 'durable_task'];
      const mocks = [mockHandleStatusQuery, mockHandleApprovalResponse, mockHandleCancelOrUpdate, mockHandleUnsafeOrUnsupported, mockHandleDurableTask];

      for (let i = 0; i < intents.length; i++) {
        const input: any = {
          messageText: 'help',
          intentResult: { intent: intents[i] }
        };
        const res = await runAgentPipeline(input);
        expect(res.intent).toBe(intents[i]);
        expect(mocks[i]).toHaveBeenCalled();
      }
    });
  });
});

describe('planner.ts - createPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'mock-key';
  });

  it('throws error if GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(createPlan('title', 'instr', 'flash')).rejects.toThrow('GEMINI_API_KEY is missing');
  });

  it('generates a plan successfully via LLM and normalizes it', async () => {
    const rawPlan = {
      summary: 'do it',
      assumptions: ['none'],
      steps: [
        { title: 'step 1', kind: 'generate', input: { prompt: 'generate' } }
      ],
      riskLevel: 'read',
      requiresApproval: false
    };
    mockGeminiCall.mockResolvedValue(JSON.stringify(rawPlan));

    const plan = await createPlan('goal', 'instr', 'flash', 'context-block', [{ filename: 'f1.txt', mimeType: 'text/plain', base64Data: 'dummy', sizeBytes: 123 }]);
    expect(plan.summary).toBe('do it');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].title).toBe('step 1');
    expect(mockGeminiCall).toHaveBeenCalled();
  });

  it('falls back to a default plan on Gemini failure', async () => {
    mockGeminiCall.mockRejectedValue(new Error('Quota limit'));
    const plan = await createPlan('goal', 'instr', 'flash');
    expect(plan.summary).toBe('Directly execute the given instruction');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].kind).toBe('generate');
    expect(plan.steps[1].toolName).toBe('slack.replyInThread');
  });
});
