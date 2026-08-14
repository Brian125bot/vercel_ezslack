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
  streamReplyToThread,
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

  const get = vi.fn();
  const getAll = vi.fn().mockReturnValue([]);
  // Mirrors the real registry's policy-scoping semantics against the same
  // `get` mock other tests already configure, so existing `toolsRegistry.get`
  // stubs keep working unchanged.
  const getScoped = vi.fn((name: string, allowedTools: readonly string[] | null) => {
    const t = get(name);
    if (!t) return { tool: undefined, deniedByPolicy: false };
    if (allowedTools != null && !allowedTools.includes(name)) {
      return { tool: undefined, deniedByPolicy: true };
    }
    return { tool: t, deniedByPolicy: false };
  });
  const getAllowed = vi.fn((_allowedTools: readonly string[] | null) => getAll());

  const toolsRegistry = {
    toFunctionDeclarations: vi.fn().mockReturnValue([]),
    get,
    getAll,
    getScoped,
    getAllowed,
  };

  const checkPolicy = vi.fn();
  const postApprovalBlockKit = vi.fn().mockResolvedValue(undefined);
  const streamReplyToThread = vi.fn().mockResolvedValue(undefined);

  return { geminiAgentStep, toolExecute, agentStore, toolsRegistry, checkPolicy, postApprovalBlockKit, streamReplyToThread };
});

vi.mock('../src/server/agent/geminiClient.js', () => ({ geminiAgentStep }));
vi.mock('../src/server/storage/agentStore.js', () => ({ agentStore }));
vi.mock('../src/server/tools/registry.js', () => ({ toolsRegistry }));
vi.mock('../src/server/agent/policy.js', () => ({ checkPolicy }));
vi.mock('../src/server/tools/slack.js', () => ({ postApprovalBlockKit, streamReplyToThread }));

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

  it('persists the final answer as a succeeded step so the verifier can see the delivered result', async () => {
    // Regression: when the model answers directly (no slack.replyInThread tool
    // call), the answer must land in the run ledger. Otherwise the trace shows
    // only intermediate tool calls, the semantic verifier reports "not
    // satisfied", and the run replans forever — burning durable re-enqueues.
    geminiAgentStep.mockResolvedValueOnce({ text: 'here is the summary' });

    await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(agentStore.createStep).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Final answer',
        status: 'succeeded',
        output: { generated: 'here is the summary' },
      })
    );
    expect(agentStore.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_loop.final_answer' })
    );
  });

  it('does not persist a final-answer step when the model returns empty text', async () => {
    geminiAgentStep.mockResolvedValueOnce({ text: '   ' });

    await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(agentStore.createStep).not.toHaveBeenCalled();
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

  it('does not stream the final text when slack.replyInThread was already called', async () => {
    // Regression: the loop must not call streamReplyToThread for a final text
    // answer when the model already posted via slack.replyInThread — otherwise
    // Slack gets two near-duplicate replies for the same run.
    geminiAgentStep
      .mockResolvedValueOnce({
        functionCalls: [{ name: 'slack.replyInThread', args: { text: 'the answer' } }],
        parts: [{ functionCall: { name: 'slack.replyInThread', args: { text: 'the answer' } }, thoughtSignature: 'sig' }],
      })
      .mockResolvedValueOnce({
        text: 'slightly different answer text',
        streaming: (async function* () { yield 'slightly different answer text'; })()
      });

    toolsRegistry.get.mockImplementation((name: string) => {
      if (name === 'slack.replyInThread') {
        return { name: 'slack.replyInThread', riskLevel: 'internal_write', requiresApproval: false, execute: toolExecute };
      }
      return tool(name);
    });
    toolExecute.mockResolvedValue({ status: 'success', message: 'Posted to Slack' });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.finalText).toBe('slightly different answer text');
    expect(toolExecute).toHaveBeenCalledWith({ text: 'the answer' }, expect.anything());
    expect(streamReplyToThread).not.toHaveBeenCalled();
    // The Final answer step is still persisted for the trace/verifier.
    expect(agentStore.createStep).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Final answer', status: 'succeeded' })
    );
  });

  it('suppresses near-duplicate slack.replyInThread calls in the same thread', async () => {
    // First call: posts normally
    geminiAgentStep.mockResolvedValueOnce({
      functionCalls: [{ name: 'slack.replyInThread', args: { text: 'The 2026 World Cup was won by Spain after defeating Argentina.' } }],
      parts: [{ functionCall: { name: 'slack.replyInThread', args: { text: 'The 2026 World Cup was won by Spain after defeating Argentina.' } }, thoughtSignature: 'sig' }],
    });

    toolsRegistry.get.mockImplementation((name: string) => {
      if (name === 'slack.replyInThread') {
        return { name: 'slack.replyInThread', riskLevel: 'internal_write', requiresApproval: false, execute: toolExecute };
      }
      return tool(name);
    });

    // First post succeeds
    toolExecute.mockResolvedValueOnce({ status: 'success', message: 'Posted to Slack' });

    // Second turn: model emits near-duplicate
    geminiAgentStep.mockResolvedValueOnce({
      functionCalls: [{ name: 'slack.replyInThread', args: { text: '2026 World Cup was won by Spain after defeating Argentina.' } }],
      parts: [{ functionCall: { name: 'slack.replyInThread', args: { text: '2026 World Cup was won by Spain after defeating Argentina.' } }, thoughtSignature: 'sig' }],
    });

    // Third turn: final text answer to complete the loop
    geminiAgentStep.mockResolvedValueOnce({ text: 'All done.' });

    // Second post should be suppressed by dedup
    toolExecute.mockResolvedValueOnce({ status: 'suppressed', message: 'Near-duplicate suppressed' });

    const outcome = await runAgentLoop(makeRun(), goal, {
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      execContext,
    });

    // Both tool calls executed but second returned suppressed status
    expect(toolExecute).toHaveBeenCalledTimes(2);
    // The loop continues because the suppressed response is not an error
    expect(outcome.status).not.toBe('failed');
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

  describe('tool policy scoping (allowedTools)', () => {
    it('filters the tool declarations sent to the model when allowedTools is set', async () => {
      geminiAgentStep.mockResolvedValueOnce({ text: 'done' });

      await runAgentLoop(makeRun(), goal, {
        deadlineMs: Date.now() + 60_000,
        signal: new AbortController().signal,
        execContext,
        allowedTools: ['slack.replyInThread'],
      });

      expect(toolsRegistry.toFunctionDeclarations).toHaveBeenCalledWith(['slack.replyInThread']);
    });

    it('an unrestricted (null allowedTools / no policy row) run is unaffected — regression for default behavior', async () => {
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
        allowedTools: null,
      });

      expect(toolsRegistry.toFunctionDeclarations).toHaveBeenCalledWith(null);
      expect(toolExecute).toHaveBeenCalledWith({ title: 'x' }, expect.anything());
      expect(outcome.status).toBe('completed');
    });

    it('rejects a direct out-of-policy tool call even if the model requests it (defense-in-depth)', async () => {
      geminiAgentStep
        .mockResolvedValueOnce({
          functionCalls: [{ name: 'task.record', args: { title: 'x' } }],
          parts: [{ functionCall: { name: 'task.record', args: { title: 'x' } }, thoughtSignature: 'sig' }],
        })
        .mockResolvedValueOnce({ text: 'ok, I could not use that tool' });

      const outcome = await runAgentLoop(makeRun(), goal, {
        deadlineMs: Date.now() + 60_000,
        signal: new AbortController().signal,
        execContext,
        allowedTools: ['slack.replyInThread'], // task.record is NOT in this list
      });

      // The tool must never actually execute.
      expect(toolExecute).not.toHaveBeenCalled();
      // Denial is logged distinctly from an unregistered tool, for audit use only.
      expect(agentStore.appendAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool.policy_denied' })
      );
      expect(outcome.status).toBe('completed');
    });

    it('emits the same generic error text for an unregistered tool and a policy-denied tool', async () => {
      function functionResponseError(contents: any[]): string {
        const userTurn = contents.find((c) => c.role === 'user' && c.parts?.some((p: any) => p.functionResponse));
        const part = userTurn.parts.find((p: any) => p.functionResponse);
        return part.functionResponse.response.error as string;
      }

      // Unregistered tool: `get` returns undefined for this specific name.
      toolsRegistry.get.mockImplementation((name: string) => (name === 'does.not.exist' ? undefined : tool(name)));
      geminiAgentStep
        .mockResolvedValueOnce({
          functionCalls: [{ name: 'does.not.exist', args: {} }],
          parts: [{ functionCall: { name: 'does.not.exist', args: {} }, thoughtSignature: 'sig' }],
        })
        .mockResolvedValueOnce({ text: 'done' });

      await runAgentLoop(makeRun(), goal, {
        deadlineMs: Date.now() + 60_000,
        signal: new AbortController().signal,
        execContext,
        allowedTools: null,
      });

      const unregisteredErrorText = functionResponseError(geminiAgentStep.mock.calls[1][0].contents);
      expect(unregisteredErrorText).toContain('Tool "does.not.exist" does not exist');

      vi.clearAllMocks();
      toolsRegistry.get.mockImplementation((name: string) => tool(name));
      checkPolicy.mockReturnValue({ allowed: true, requiresApproval: false, reason: 'ok' });

      // Policy-denied (registered) tool.
      geminiAgentStep
        .mockResolvedValueOnce({
          functionCalls: [{ name: 'task.record', args: { title: 'x' } }],
          parts: [{ functionCall: { name: 'task.record', args: { title: 'x' } }, thoughtSignature: 'sig' }],
        })
        .mockResolvedValueOnce({ text: 'done' });

      await runAgentLoop(makeRun(), goal, {
        deadlineMs: Date.now() + 60_000,
        signal: new AbortController().signal,
        execContext,
        allowedTools: ['slack.replyInThread'],
      });

      const deniedErrorText = functionResponseError(geminiAgentStep.mock.calls[1][0].contents);
      expect(deniedErrorText).toContain('Tool "task.record" does not exist');
      // The available-tools list surfaced to the model must not leak the
      // restricted tool name.
      expect(deniedErrorText).not.toContain('task.record,');
      expect(deniedErrorText).toContain('slack.replyInThread');
    });
  });
});
