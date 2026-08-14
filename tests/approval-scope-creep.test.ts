import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgentStore,
  mockExecute,
  mockGeminiCall,
  mockToolsRegistry,
  mockResolveAllowedTools,
  mockPostApprovalBlockKit
} = vi.hoisted(() => ({
  mockAgentStore: {
    getStepsForPlan: vi.fn().mockResolvedValue([]),
    getStepsForRun: vi.fn().mockResolvedValue([]),
    createToolCall: vi.fn().mockResolvedValue({ id: 'tool-call-1' }),
    updateToolCallStatus: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    appendAuditEvent: vi.fn().mockResolvedValue(undefined),
    createApprovalRequest: vi.fn().mockResolvedValue({ id: 'approval-2' }),
    consumeApproval: vi.fn(),
    getRun: vi.fn(),
    getGoal: vi.fn(),
    createStep: vi.fn().mockResolvedValue({ id: 'new-step' }),
    bumpPlanVersion: vi.fn().mockResolvedValue({ id: 'plan-1', version: 2 })
  },
  mockExecute: vi.fn().mockResolvedValue({ ok: true }),
  mockGeminiCall: vi.fn(),
  mockToolsRegistry: { get: vi.fn(), getScoped: vi.fn() },
  mockResolveAllowedTools: vi.fn(),
  mockPostApprovalBlockKit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/server/storage/agentStore.js', () => ({ agentStore: mockAgentStore }));
vi.mock('../src/server/tools/registry.js', () => ({ toolsRegistry: mockToolsRegistry }));
vi.mock('../src/server/tools/slack.js', () => ({ postApprovalBlockKit: mockPostApprovalBlockKit }));
vi.mock('../src/server/agent/geminiClient.js', () => ({ geminiCall: mockGeminiCall }));
vi.mock('../src/server/agent/policy.js', async () => {
  const actual = await vi.importActual<any>('../src/server/agent/policy.js');
  return { ...actual, resolveAllowedTools: mockResolveAllowedTools };
});

import { executeStep } from '../src/server/agent/executor.js';
import { mutatePlan } from '../src/server/agent/planMutation.js';

const run = { id: 'run-1', goal_id: 'goal-1' } as any;
const step = {
  id: 'step-1',
  title: 'Write externally',
  input: { kind: 'tool', toolName: 'external.write' },
  order_index: 1
} as any;
const context = {
  runId: 'run-1',
  stepId: 'step-1',
  workspaceId: 'workspace-1',
  channelId: 'channel-1',
  userId: 'user-1',
  messageTs: 'message-1',
  preApproved: true,
  planApprovalId: 'approval-1'
};

describe('approval scope-creep prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToolsRegistry.get.mockReturnValue({
      name: 'external.write',
      riskLevel: 'external_write',
      execute: mockExecute
    });
    mockToolsRegistry.getScoped.mockImplementation((name: string) => ({
      tool: mockToolsRegistry.get(name),
      deniedByPolicy: false
    }));
    mockResolveAllowedTools.mockResolvedValue(null);
    mockAgentStore.getRun.mockResolvedValue({ goal_id: 'goal-1' });
    mockAgentStore.getGoal.mockResolvedValue({
      id: 'goal-1',
      workspace_id: 'workspace-1',
      title: 'Goal',
      original_instruction: 'Do something'
    });
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('consumes a plan approval before executing the external write', async () => {
    mockAgentStore.consumeApproval.mockResolvedValue(true);

    await executeStep(run, step, context);

    expect(mockAgentStore.consumeApproval).toHaveBeenCalledWith('approval-1');
    expect(mockExecute).toHaveBeenCalled();
    expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan.approval.consumed' })
    );
    expect(mockAgentStore.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('re-gates a reused plan approval and requests fresh approval', async () => {
    mockAgentStore.consumeApproval.mockResolvedValue(false);

    await executeStep(run, step, context);

    expect(mockAgentStore.createApprovalRequest).toHaveBeenCalled();
    expect(mockAgentStore.updateStepStatus).toHaveBeenCalledWith(
      'step-1',
      'blocked',
      expect.any(Object)
    );
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval.reused.blocked' })
    );
  });

  it('requires approval for a non-pre-approved external write', async () => {
    await executeStep(run, step, { ...context, preApproved: false, planApprovalId: null });

    expect(mockAgentStore.consumeApproval).not.toHaveBeenCalled();
    expect(mockAgentStore.createApprovalRequest).toHaveBeenCalled();
    expect(mockAgentStore.updateStepStatus).toHaveBeenCalledWith(
      'step-1',
      'blocked',
      expect.any(Object)
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('fails a direct out-of-policy tool call with generic tool-not-found text', async () => {
    mockToolsRegistry.getScoped.mockReturnValue({ tool: undefined, deniedByPolicy: true });

    await executeStep(run, step, context, []);

    expect(mockAgentStore.updateStepStatus).toHaveBeenCalledWith(
      'step-1',
      'failed',
      { error: 'Tool not found: external.write' }
    );
    expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'step.policy_denied',
        summary: 'Step failed: Tool not found: external.write',
        payload: { error: 'Tool not found: external.write' }
      })
    );
    expect(mockAgentStore.createToolCall).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('bumps the plan version when mutation adds an external write', async () => {
    mockAgentStore.getStepsForPlan.mockResolvedValue([
      { id: 'existing-step', order_index: 1, status: 'pending', title: 'Existing', input: {} }
    ]);
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      summary: 'Added external write',
      mutations: [{
        action: 'add',
        newTitle: 'New write',
        newKind: 'tool',
        newToolName: 'external.write',
        newInput: {},
        reason: 'Needed'
      }]
    }));

    const result = await mutatePlan('run-1', 'plan-1', 'add a write', 'flash');

    expect(result.success).toBe(true);
    expect(mockAgentStore.bumpPlanVersion).toHaveBeenCalledWith('plan-1');
    expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.mutation.new_approval_required',
        payload: { newExternalWriteSteps: 1, planId: 'plan-1' }
      })
    );
  });

  it('does not treat a policy-denied external write as approvable during mutation', async () => {
    mockResolveAllowedTools.mockResolvedValue(['slack.replyInThread']);
    mockToolsRegistry.getScoped.mockReturnValue({ tool: undefined, deniedByPolicy: true });
    mockAgentStore.getStepsForPlan.mockResolvedValue([
      { id: 'existing-step', order_index: 1, status: 'pending', title: 'Existing', input: {} }
    ]);
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      summary: 'Added external write',
      mutations: [{
        action: 'add',
        newTitle: 'New write',
        newKind: 'tool',
        newToolName: 'external.write',
        newInput: {},
        reason: 'Needed'
      }]
    }));

    const result = await mutatePlan('run-1', 'plan-1', 'add a write', 'flash');

    expect(result.success).toBe(true);
    expect(mockToolsRegistry.getScoped).toHaveBeenCalledWith('external.write', ['slack.replyInThread']);
    expect(mockAgentStore.createStep).not.toHaveBeenCalled();
    expect(mockAgentStore.bumpPlanVersion).not.toHaveBeenCalled();
  });
});
