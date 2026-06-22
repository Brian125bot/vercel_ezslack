import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
// Declared via vi.hoisted() so the objects exist when the hoisted vi.mock()
// factories run. (A plain `const` would be in the temporal dead zone because
// vi.mock calls are hoisted to the very top of the module.)
const {
  mockAgentStore,
  mockCreatePlan,
  mockExecuteStep,
  mockFinalizeRun,
  mockVerifyRun,
  mockVerifySemantically,
} = vi.hoisted(() => ({
  mockAgentStore: {
    getGoal: vi.fn(),
    getRun: vi.fn(),
    incrementRunIteration: vi.fn(),
    createPlan: vi.fn(),
    createStep: vi.fn(),
    getStepsForPlan: vi.fn(),
    getStepsForRun: vi.fn(),
    getStep: vi.fn(),
    getRunTrace: vi.fn(),
    getApprovalsForRun: vi.fn().mockResolvedValue([]),
    getApprovedPlanApproval: vi.fn().mockResolvedValue(null),
    getApprovedStepApproval: vi.fn().mockResolvedValue(null),
    getAuditEventsForRun: vi.fn().mockResolvedValue([]),
    updateRunStatus: vi.fn(),
    updateGoalStatus: vi.fn(),
    incrementRunRetry: vi.fn(),
    updateStepStatus: vi.fn(),
    appendAuditEvent: vi.fn(),
    createApprovalRequest: vi.fn(),
  },
  mockCreatePlan: vi.fn(),
  mockExecuteStep: vi.fn(),
  mockFinalizeRun: vi.fn(),
  mockVerifyRun: vi.fn(),
  mockVerifySemantically: vi.fn(),
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/context.js', () => ({
  assembleContext: vi.fn().mockResolvedValue({ threadHistory: [], memoryRecords: [], priorSteps: [] }),
  renderContextForPrompt: vi.fn().mockReturnValue('')
}));

vi.mock('../src/server/agent/planner.js', () => ({
  createPlan: mockCreatePlan
}));

vi.mock('../src/server/agent/executor.js', () => ({
  executeStep: mockExecuteStep
}));

vi.mock('../src/server/agent/finalize.js', () => ({
  finalizeRun: mockFinalizeRun
}));

vi.mock('../src/server/agent/verifier.js', () => ({
  verifyRun: mockVerifyRun
}));

vi.mock('../src/server/agent/semanticVerifier.js', () => ({
  verifySemantically: mockVerifySemantically
}));

vi.mock('../src/server/agent/log.js', () => ({
  slog: vi.fn()
}));

import { runLoop } from '../src/server/agent/loop.js';

// ---- Helpers ----

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

function makeStep(overrides: any = {}) {
  return {
    id: 'step-1',
    run_id: 'run-1',
    plan_id: 'plan-1',
    order_index: 1,
    title: 'Test step',
    status: 'pending',
    input: { kind: 'tool', toolName: 'slack.replyInThread' },
    ...overrides,
  };
}

function makePlanDraft(overrides: any = {}) {
  return {
    summary: 'Test plan',
    assumptions: [],
    steps: [{ title: 'Step 1', kind: 'tool', toolName: 'slack.replyInThread', input: { text: 'hi' } }],
    riskLevel: 'read',
    requiresApproval: false,
    ...overrides,
  };
}

// ---- Tests ----

describe('Agent Loop (W4-F6)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: getApprovalsForRun and getAuditEventsForRun return empty
    mockAgentStore.getApprovalsForRun.mockResolvedValue([]);
    mockAgentStore.getAuditEventsForRun.mockResolvedValue([]);
    // buildScopedTrace() re-fetches the run + trace; provide sane defaults so
    // the verification path doesn't throw when a test doesn't override them.
    mockAgentStore.getRun.mockResolvedValue(makeRun({ status: 'running', plan_id: 'plan-1' }));
    mockAgentStore.getRunTrace.mockResolvedValue({
      run: makeRun({ status: 'running', plan_id: 'plan-1' }),
      goal: makeGoal(),
      plan: { id: 'plan-1', steps: [] },
      steps: [],
      toolCalls: [],
      approvals: [],
      auditEvents: [],
    });
  });

  it('happy path: plan → execute → verify → succeed', async () => {
    const run = makeRun();
    const goal = makeGoal();
    const step = makeStep();
    const planDraft = makePlanDraft();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockCreatePlan.mockResolvedValue(planDraft);
    mockAgentStore.createPlan.mockResolvedValue({ id: 'plan-1', ...planDraft });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running', plan_id: 'plan-1' });
    mockAgentStore.getStepsForPlan.mockResolvedValue([step]);
    mockAgentStore.createStep.mockResolvedValue(step);

    // executeStep succeeds (updates step status via side effect)
    mockExecuteStep.mockResolvedValue(undefined);
    mockAgentStore.getStep.mockResolvedValue({ ...step, status: 'succeeded' });

    // Verification passes
    mockVerifyRun.mockReturnValue({ status: 'satisfied', confidence: 1, reasons: [], recommendedNextAction: 'complete' });
    mockVerifySemantically.mockResolvedValue({ satisfied: true, confidence: 0.95, reasoning: 'Looks good', source: 'llm' });
    mockAgentStore.getRunTrace.mockResolvedValue({ run, goal, plan: { id: 'plan-1' }, steps: [{ ...step, status: 'succeeded' }], toolCalls: [], approvals: [], auditEvents: [] });

    mockFinalizeRun.mockResolvedValue(undefined);
    mockAgentStore.appendAuditEvent.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      'succeeded'
    );
  });

  it('high-confidence semantic failure triggers replan via lease-safe re-queue', async () => {
    const run = makeRun();
    const goal = makeGoal();
    const step = makeStep();
    const planDraft = makePlanDraft();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockCreatePlan.mockResolvedValue(planDraft);
    mockAgentStore.createPlan.mockResolvedValue({ id: 'plan-1', ...planDraft });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running', plan_id: 'plan-1' });
    mockAgentStore.getStepsForPlan.mockResolvedValue([step]);
    mockAgentStore.createStep.mockResolvedValue(step);
    mockExecuteStep.mockResolvedValue(undefined);
    mockAgentStore.getStep.mockResolvedValue({ ...step, status: 'succeeded' });

    // Rule verification passes but semantic fails WITH HIGH CONFIDENCE
    mockVerifyRun.mockReturnValue({ status: 'satisfied', confidence: 1, reasons: [], recommendedNextAction: 'complete' });
    mockVerifySemantically.mockResolvedValue({ satisfied: false, confidence: 0.9, reasoning: 'Reply does not match goal', source: 'llm' });
    mockAgentStore.getRunTrace.mockResolvedValue({ run, goal, plan: { id: 'plan-1' }, steps: [{ ...step, status: 'succeeded' }], toolCalls: [], approvals: [], auditEvents: [] });
    mockAgentStore.appendAuditEvent.mockResolvedValue(undefined);

    const setImmediateSpy = vi.spyOn(global, 'setImmediate').mockImplementation((() => {}) as any);

    await runLoop(run);

    // WS4: should RE-QUEUE (lease-safe) with plan_id cleared, not recurse in-process.
    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith(
      'run-1',
      'queued',
      expect.objectContaining({ plan_id: null, claimed_by: null, lease_expires_at: null })
    );

    // Must NOT use untracked setImmediate recursion anymore.
    expect(setImmediateSpy).not.toHaveBeenCalled();

    // finalizeRun should NOT have been called (run will be re-claimed by worker).
    expect(mockFinalizeRun).not.toHaveBeenCalled();

    setImmediateSpy.mockRestore();
  });

  it('low-confidence semantic failure is inconclusive and does NOT replan', async () => {
    const run = makeRun();
    const goal = makeGoal();
    const step = makeStep();
    const planDraft = makePlanDraft();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockCreatePlan.mockResolvedValue(planDraft);
    mockAgentStore.createPlan.mockResolvedValue({ id: 'plan-1', ...planDraft });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running', plan_id: 'plan-1' });
    mockAgentStore.getStepsForPlan.mockResolvedValue([step]);
    mockAgentStore.createStep.mockResolvedValue(step);
    mockExecuteStep.mockResolvedValue(undefined);
    mockAgentStore.getStep.mockResolvedValue({ ...step, status: 'succeeded' });

    mockVerifyRun.mockReturnValue({ status: 'satisfied', confidence: 1, reasons: [], recommendedNextAction: 'complete' });
    // Low confidence -> inconclusive -> treated as success.
    mockVerifySemantically.mockResolvedValue({ satisfied: false, confidence: 0.2, reasoning: 'unsure', source: 'llm' });
    mockAgentStore.getRunTrace.mockResolvedValue({ run, goal, plan: { id: 'plan-1' }, steps: [{ ...step, status: 'succeeded' }], toolCalls: [], approvals: [], auditEvents: [] });
    mockAgentStore.appendAuditEvent.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      'succeeded'
    );
  });

  it('transient (retry) verification re-runs failed steps in the same plan', async () => {
    const run = makeRun();
    const goal = makeGoal();
    const step = makeStep();
    const planDraft = makePlanDraft();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockCreatePlan.mockResolvedValue(planDraft);
    mockAgentStore.createPlan.mockResolvedValue({ id: 'plan-1', ...planDraft });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running', plan_id: 'plan-1' });
    mockAgentStore.getStepsForPlan.mockResolvedValue([{ ...step, status: 'failed' }]);
    mockAgentStore.createStep.mockResolvedValue(step);
    mockExecuteStep.mockResolvedValue(undefined);
    mockAgentStore.getStep.mockResolvedValue({ ...step, status: 'failed' });
    mockAgentStore.incrementRunRetry.mockResolvedValue({ ...run, retry_count: 1 });
    mockAgentStore.updateStepStatus.mockResolvedValue(step);

    // Rule verifier asks for a retry (e.g. transient Slack failure).
    mockVerifyRun.mockReturnValue({ status: 'not_satisfied', confidence: 1, reasons: ['slack failed'], recommendedNextAction: 'retry' });
    mockVerifySemantically.mockResolvedValue({ satisfied: true, confidence: 0, reasoning: '', source: 'skipped' });
    mockAgentStore.getRunTrace.mockResolvedValue({ run, goal, plan: { id: 'plan-1' }, steps: [{ ...step, status: 'failed' }], toolCalls: [], approvals: [], auditEvents: [] });
    mockAgentStore.appendAuditEvent.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockAgentStore.incrementRunRetry).toHaveBeenCalledWith('run-1');
    // Re-queued (not finalized as failed) for a fresh attempt at the same plan.
    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith(
      'run-1',
      'queued',
      expect.objectContaining({ claimed_by: null })
    );
    expect(mockFinalizeRun).not.toHaveBeenCalled();
  });

  it('max iterations → failed without plan creation', async () => {
    const run = makeRun({ iteration_count: 3 }); // at MAX_ITERATIONS
    const goal = makeGoal();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockFinalizeRun.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      'failed',
      expect.stringContaining('Max iterations')
    );

    // No plan should have been created
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(mockExecuteStep).not.toHaveBeenCalled();
  });

  it('step blocked → run blocked and finalized', async () => {
    const run = makeRun();
    const goal = makeGoal();
    const step = makeStep();
    const planDraft = makePlanDraft();

    mockAgentStore.getGoal.mockResolvedValue(goal);
    mockAgentStore.incrementRunIteration.mockResolvedValue({ ...run, iteration_count: 1 });
    mockCreatePlan.mockResolvedValue(planDraft);
    mockAgentStore.createPlan.mockResolvedValue({ id: 'plan-1', ...planDraft });
    mockAgentStore.updateRunStatus.mockResolvedValue({ ...run, status: 'running', plan_id: 'plan-1' });
    mockAgentStore.getStepsForPlan.mockResolvedValue([step]);
    mockAgentStore.createStep.mockResolvedValue(step);

    // executeStep doesn't throw but step ends up blocked
    mockExecuteStep.mockResolvedValue(undefined);
    mockAgentStore.getStep.mockResolvedValue({ ...step, status: 'blocked' });
    mockFinalizeRun.mockResolvedValue(undefined);
    mockAgentStore.appendAuditEvent.mockResolvedValue(undefined);

    await runLoop(run);

    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-1', 'blocked');
    expect(mockFinalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      'blocked',
      expect.stringContaining('blocked')
    );
  });
});
