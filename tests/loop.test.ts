import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAgentStore,
  mockGeminiCallRaw,
  mockExecuteToolCall,
  mockFinalizeRun,
  mockVerifySemantically,
  mockAssembleContext,
  mockRenderContextForPrompt,
} = vi.hoisted(() => ({
  mockAgentStore: {
    getGoal: vi.fn(),
    getRun: vi.fn(),
    incrementRunIteration: vi.fn(),
    createStep: vi.fn(),
    getStepsForRun: vi.fn(),
    getStep: vi.fn(),
    getRunTrace: vi.fn(),
    getApprovalsForRun: vi.fn().mockResolvedValue([]),
    getApprovedPlanApproval: vi.fn().mockResolvedValue(null),
    getApprovedStepApproval: vi.fn().mockResolvedValue(null),
    getAuditEventsForRun: vi.fn().mockResolvedValue([]),
    updateRunStatus: vi.fn(),
    updateGoalStatus: vi.fn(),
    updateStepStatus: vi.fn(),
    appendAuditEvent: vi.fn(),
    createApprovalRequest: vi.fn(),
    createToolCall: vi.fn(),
    updateToolCallStatus: vi.fn(),
    renewLease: vi.fn().mockResolvedValue(undefined),
  },
  mockGeminiCallRaw: vi.fn(),
  mockExecuteToolCall: vi.fn(),
  mockFinalizeRun: vi.fn(),
  mockVerifySemantically: vi.fn(),
  mockAssembleContext: vi.fn(),
  mockRenderContextForPrompt: vi.fn(),
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/taskClient.js', () => ({
  enqueueRunTask: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/server/agent/context.js', () => ({
  assembleContext: mockAssembleContext,
  renderContextForPrompt: mockRenderContextForPrompt
}));

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCallRaw: mockGeminiCallRaw
}));

vi.mock('../src/server/agent/executor.js', () => ({
  executeToolCall: mockExecuteToolCall
}));

vi.mock('../src/server/agent/finalize.js', () => ({
  finalizeRun: mockFinalizeRun
}));

vi.mock('../src/server/agent/semanticVerifier.js', () => ({
  verifySemantically: mockVerifySemantically
}));

vi.mock('../src/server/agent/log.js', () => ({
  slog: vi.fn()
}));

import { runLoop } from '../src/server/agent/loop.js';

function makeGoal(overrides: any = {}) {
  return {
    id: 'goal-1',
    workspace_id: 'ws-1',
    created_by_user_id: 'user-1',
    source: 'slack',
    source_channel_id: 'C123',
    source_message_ts: '123.456',
    title: 'Test goal',
    original_instruction: 'do something',
    status: 'running',
    priority: 'normal',
    ...overrides,
  };
}

function makeRun(overrides: any = {}) {
  return {
    id: 'run-1',
    goal_id: 'goal-1',
    plan_id: null,
    status: 'queued',
    model: 'gemini-2.5-flash',
    iteration_count: 0,
    ...overrides,
  };
}

describe('Agent Loop - Native Tool Calling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentStore.getApprovalsForRun.mockResolvedValue([]);
    mockAgentStore.getAuditEventsForRun.mockResolvedValue([]);
    mockAgentStore.getRun.mockResolvedValue(makeRun({ status: 'running' }));
    mockAgentStore.getRunTrace.mockResolvedValue({
      run: makeRun({ status: 'running' }),
      goal: makeGoal(),
      steps: [],
      toolCalls: [],
      approvals: [],
      auditEvents: [],
    });
    mockAssembleContext.mockResolvedValue({ threadHistory: [], memoryRecords: [], priorSteps: [], goal: 'test goal', attachments: [] });
    mockRenderContextForPrompt.mockReturnValue('');
  });

  it('happy path: conversational response with no tool calls succeeds immediately', async () => {
    const run = makeRun();
    const goal = makeGoal();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running' });
    mockAgentStore.createStep.mockResolvedValue({ id: 'step-1' } as any);
    
    mockGeminiCallRaw.mockResolvedValue({
      text: 'I have done the task.'
    });

    mockVerifySemantically.mockResolvedValue({ satisfied: true, confidence: 0.95, reasoning: 'Looks good', source: 'llm' });
    mockFinalizeRun.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      'succeeded'
    );
  });

  it('tool call generation: creates tools, step and requeues run', async () => {
    const run = makeRun();
    const goal = makeGoal();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running' });
    mockAgentStore.createStep.mockResolvedValue({ id: 'step-1' } as any);
    
    mockGeminiCallRaw.mockResolvedValue({
      text: 'Let me search.',
      functionCalls: [{ name: 'search.query', args: { query: 'google' } }]
    });

    await runLoop(run);

    expect(mockAgentStore.createToolCall).toHaveBeenCalledWith(expect.objectContaining({
      tool_name: 'search.query',
      input: { query: 'google' }
    }));

    // Should NOT finalize, should requeue
    expect(mockFinalizeRun).not.toHaveBeenCalled();
    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-1', 'queued', expect.any(Object));
  });
});
