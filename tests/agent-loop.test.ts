import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
// The ReAct loop touches Postgres (agentStore), the Gemini client, the tool
// registry, policy, and Slack (for approvals). We stub all of them so the test
// exercises runAgentLoop's control flow, not the collaborators.
const {
  geminiAgentStep,
  toolExecute,
  agentStore,
  toolsRegistry,
  checkPolicy,
  postApprovalBlockKit,
} = vi.hoisted(() => {
  const geminiAgentStep = vi.fn();
  const toolExecute = vi.fn();

  const agentStore = {
    appendAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRunTrace: vi.fn().mockResolvedValue({ toolCalls: [] }),
    updateRunMessages: vi.fn().mockResolvedValue(undefined),
    addRunTokens: vi.fn().mockResolvedValue(undefined),
    createPlan: vi.fn().mockResolvedValue({ id: 'plan-1' }),
    updateRunStatus: vi.fn().mockResolvedValue({}),
    createStep: vi.fn().mockResolvedValue({ id: 'step-1' }),
    createToolCall: vi.fn().mockResolvedValue({ id: 'tc-1' }),
    updateToolCallStatus: vi.fn().mockResolvedValue(undefined),
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    getApprovedStepApproval: vi.fn().mockResolvedValue(null),
    createApprovalRequest: vi.fn().mockResolvedValue({ id: 'appr-1' }),
  };

  const toolsRegistry = {
    toFunctionDeclarations: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
  };

  const checkPolicy = vi.fn();
  const postApprovalBlockKit = vi.fn().mockResolvedValue(undefined);

  return { geminiAgentStep, toolExecute, agentStore, toolsRegistry, checkPolicy, postApprovalBlockKit };
});

vi.mock('../src/server/agent/geminiClient.js', () => ({ geminiAgentStep }));
vi.mock('../src/server/storage/agentStore.js', () => ({ agentStore }));
vi.mock('../src/server/tools/registry.js', () => ({ toolsRegistry }));
vi.mock('../src/server/agent/policy.js', () => ({ checkPolicy }));
vi.mock('../src/server/tools/slack.js', () => ({ postApprovalBlockKit }));

import { runAgentLoop } from '../src/server/agent/reactLoop.js';
import type { AgentRun, AgentGoal } from '../src/server/storage/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const goal: AgentGoal = {
  id: 'g-1',
  workspace_id: 'ws-1',
  title: 'Do the thing',
  original_instruction: 'do it',
  source_channel_id: 'c1',
  created_by_user_id: 'u1',
  source_message_ts: 't1',
  source_thread_ts: 'th1',
} as AgentGoal;

// agent_messages is seeded so the loop skips context assembly (keeps the test
// focused on loop control flow, not assembleContext/attachments).
function makeRun(): AgentRun {
  return {
    id: 'r-1',
    goal_id: 'g-1',
    model: 'gemini-3.1-flash-lite',
    plan_id: 'plan-1',
    agent_messages: [{ role: 'user', parts: [{ text: 'seed' }] }],
    iteration_count: 1,
  } as unknown as AgentRun;
}

const execContext = {
  runId: 'r-1',
  stepId: '',
  workspaceId: 'ws-1',
  channelId: 'c1',
  userId: 'u1',
  messageTs: 't1',
  threadTs: 'th1',
};

function tool(name: string, opts: { riskLevel?: any; requiresApproval?: boolean } = {}) {
  return {
    name,
    riskLevel: opts.riskLevel ?? 'internal_write',
    requiresApproval: opts.requiresApproval ?? false,
    execute: toolExecute,
  };
}

describe('runAgentLoop (ReAct loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolsRegistry.get.mockImplementation((name: string) => tool(name));
    checkPolicy.mockReturnValue({ allowed: true, requiresApproval: false, reason: 'ok' });
  });

  it('completes with a final text answer when the model makes no tool call', async () => {
    geminiAgentStep.mockResolvedValueOnce({ text: 'all done' });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.finalText).toBe('all done');
    expect(agentStore.updateRunMessages).toHaveBeenCalled();
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it('executes a tool call, observes its result, then produces a final answer', async () => {
    geminiAgentStep
      .mockResolvedValueOnce({
        functionCalls: [{ name: 'task.record', args: { title: 'x' } }],
        parts: [{ functionCall: { name: 'task.record', args: { title: 'x' } }, thoughtSignature: 'sig' }],
      })
      .mockResolvedValueOnce({ text: 'done after tool' });
    toolExecute.mockResolvedValue({ recorded: true });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(toolExecute).toHaveBeenCalledWith({ title: 'x' }, expect.anything());
    expect(agentStore.createToolCall).toHaveBeenCalled();
    expect(agentStore.updateToolCallStatus).toHaveBeenCalledWith('tc-1', 'succeeded', expect.anything());
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.finalText).toBe('done after tool');
  });

  it('yields (wall_clock) when the deadline is already near on entry', async () => {
    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() - 10_000, // past
      signal: new AbortController().signal,
      execContext,
    });

    expect(outcome.status).toBe('yield');
    if (outcome.status === 'yield') expect(outcome.reason).toBe('wall_clock');
    expect(geminiAgentStep).not.toHaveBeenCalled();
  });

  it('caps the run after exceeding MAX_AGENT_LOOP_TURNS without a final answer', async () => {
    // The model keeps requesting a tool call and never answers → loop must cap.
    geminiAgentStep.mockResolvedValue({
      functionCalls: [{ name: 'task.record', args: { title: 'x' } }],
      parts: [{ functionCall: { name: 'task.record', args: { title: 'x' } }, thoughtSignature: 'sig' }],
    });
    toolExecute.mockResolvedValue({ recorded: true });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(outcome.status).toBe('capped');
    if (outcome.status === 'capped') expect(outcome.reason).toMatch(/MAX_AGENT_LOOP_TURNS/);
  });

  it('yields (approval) when a tool requires human approval', async () => {
    geminiAgentStep.mockResolvedValueOnce({
      functionCalls: [{ name: 'email.send', args: { to: 'a@b.co', body: 'hi' } }],
      parts: [{ functionCall: { name: 'email.send', args: { to: 'a@b.co', body: 'hi' } }, thoughtSignature: 'sig' }],
    });
    toolsRegistry.get.mockReturnValue(
      tool('email.send', { riskLevel: 'external_write', requiresApproval: true })
    );
    checkPolicy.mockReturnValue({ allowed: true, requiresApproval: true, reason: 'needs approval' });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(agentStore.createApprovalRequest).toHaveBeenCalled();
    expect(postApprovalBlockKit).toHaveBeenCalled();
    expect(agentStore.updateRunStatus).toHaveBeenCalledWith('r-1', 'awaiting_approval');
    expect(outcome.status).toBe('yield');
    if (outcome.status === 'yield') expect(outcome.reason).toBe('approval');
  });

  it('surfaces an unknown tool name honestly instead of crashing', async () => {
    geminiAgentStep
      .mockResolvedValueOnce({
        functionCalls: [{ name: 'does.not.exist', args: {} }],
        parts: [{ functionCall: { name: 'does.not.exist', args: {} }, thoughtSignature: 'sig' }],
      })
      .mockResolvedValueOnce({ text: 'No such tool; here is my final answer.' });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    // The loop should continue (the model gets an "unknown tool" functionResponse)
    // and ultimately complete once the model stops calling tools.
    expect(agentStore.createStep).toHaveBeenCalled();
    expect(outcome.status).toBe('completed');
  });
});
