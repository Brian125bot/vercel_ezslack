import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAgentStore, mockGetThreadHistory } = vi.hoisted(() => ({
  mockAgentStore: {
    searchMemory: vi.fn().mockResolvedValue([]),
    getStepsForRun: vi.fn().mockResolvedValue([])
  },
  mockGetThreadHistory: vi.fn().mockResolvedValue([])
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/state.js', () => ({
  getThreadHistory: mockGetThreadHistory,
  saveThreadHistory: vi.fn()
}));

import { assembleContext, renderContextForPrompt } from '../src/server/agent/context.js';

describe('context.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentStore.searchMemory.mockResolvedValue([]);
    mockAgentStore.getStepsForRun.mockResolvedValue([]);
    mockGetThreadHistory.mockResolvedValue([]);
  });

  it('assembles context when channelId and userId are missing', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something'
    };
    const run: any = {
      id: 'run-123'
    };

    const ctx = await assembleContext(goal, run);
    expect(ctx.goal).toBe('Test Goal\nDo something');
    expect(ctx.threadHistory).toEqual([]);
    expect(ctx.memoryRecords).toEqual([]);
    expect(ctx.priorSteps).toEqual([]);
    expect(ctx.feedback).toBeUndefined();
    expect(ctx.attachments).toBeUndefined();
  });

  it('retrieves thread history, memory and prior steps when ids are provided', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something',
      workspace_id: 'ws-1',
      source_channel_id: 'chan-1',
      created_by_user_id: 'user-1',
      source_thread_ts: 'thread-123'
    };
    const run: any = {
      id: 'run-123',
      failure_reason: 'Prior error',
      attachments: [{ filename: 'test.txt', mimeType: 'text/plain' }]
    };

    mockGetThreadHistory.mockResolvedValue([{ role: 'user', text: 'hello' }]);
    mockAgentStore.searchMemory.mockResolvedValue([{ kind: 'fact', content: 'Sky is blue' }]);
    mockAgentStore.getStepsForRun.mockResolvedValue([
      { status: 'succeeded', title: 'Step 1', output: { ok: true } },
      { status: 'failed', title: 'Step 2', error: 'Something went wrong' }
    ]);

    const ctx = await assembleContext(goal, run);
    expect(ctx.threadHistory).toHaveLength(1);
    expect(ctx.memoryRecords).toHaveLength(1);
    expect(ctx.priorSteps).toHaveLength(2);
    expect(ctx.feedback).toBe('Prior error');
    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments?.[0].filename).toBe('test.txt');

    expect(mockGetThreadHistory).toHaveBeenCalledWith('chan-chan-1-thread-thread-123');
  });

  it('retrieves single thread history if source_thread_ts is missing', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something',
      workspace_id: 'ws-1',
      source_channel_id: 'chan-1',
      created_by_user_id: 'user-1'
    };
    const run: any = { id: 'run-123' };

    await assembleContext(goal, run);
    expect(mockGetThreadHistory).toHaveBeenCalledWith('chan-chan-1-single');
  });

  it('compacts thread history if estimated tokens exceeds threshold', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something',
      workspace_id: 'ws-1',
      source_channel_id: 'chan-1',
      created_by_user_id: 'user-1'
    };
    const run: any = { id: 'run-123' };

    // Create 15 messages. Middle messages (indices 2 to 12) will be summarized.
    // Make them extremely long so they exceed 8000 tokens (8000 * 4 = 32000 chars).
    // 15 messages, each with 3000 chars of 'a' plus topic word.
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'a'.repeat(3000) + ` This is message index ${i} with topic Capitalizedword.`
    }));

    mockGetThreadHistory.mockResolvedValue(messages);

    const ctx = await assembleContext(goal, run);
    expect(ctx.threadHistory.length).toBe(13); // keepFirst(2) + 1 summary + keepLast(10)
    expect(ctx.threadHistory[2].role).toBe('system');
    expect(ctx.threadHistory[2].summary).toBe(true);
    expect(ctx.threadHistory[2].text).toContain('Capitalizedword');
  });

  it('does not compact thread history if total estimated tokens is within threshold', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something',
      workspace_id: 'ws-1',
      source_channel_id: 'chan-1',
      created_by_user_id: 'user-1'
    };
    const run: any = { id: 'run-123' };

    const messages = [{ role: 'user', text: 'hi' }];
    mockGetThreadHistory.mockResolvedValue(messages);

    const ctx = await assembleContext(goal, run);
    expect(ctx.threadHistory).toEqual(messages);
  });

  it('does not compact thread history if message length is short even if tokens exceed threshold conceptually', async () => {
    const goal: any = {
      title: 'Test Goal',
      original_instruction: 'Do something',
      workspace_id: 'ws-1',
      source_channel_id: 'chan-1',
      created_by_user_id: 'user-1'
    };
    const run: any = { id: 'run-123' };

    // Less than keepFirst + keepLast (12) messages but they are very long (35000 chars total)
    const messages = Array.from({ length: 10 }, () => ({ role: 'user', text: 'a'.repeat(3500) }));
    mockGetThreadHistory.mockResolvedValue(messages);

    const ctx = await assembleContext(goal, run);
    expect(ctx.threadHistory).toHaveLength(10); // Not compacted because length <= keepFirst + keepLast (12)
  });

  it('renders context for prompt correctly', () => {
    const ctx = {
      goal: 'My Goal\nStep by step',
      threadHistory: [
        { role: 'user', text: 'hello' },
        { role: 'system', text: '[Thread summary: test]', summary: true }
      ],
      memoryRecords: [
        { kind: 'fact', content: 'Earth is round' }
      ],
      priorSteps: [
        { status: 'succeeded', title: 'Step A', output: { success: true } },
        { status: 'failed', title: 'Step B', error: 'Network error' }
      ],
      feedback: 'Please retry',
      attachments: [{ filename: 'data.json', mimeType: 'application/json', base64Data: 'dummy', sizeBytes: 123 }]
    };

    const dump = renderContextForPrompt(ctx);
    expect(dump).toContain('<context>');
    expect(dump).toContain('Goal: My Goal\nStep by step');
    expect(dump).toContain('Attached files: data.json (application/json)');
    expect(dump).toContain('Feedback from previous run: Please retry');
    expect(dump).toContain('Memory:\n- fact: Earth is round');
    expect(dump).toContain('Chat History:\nuser: hello\n[SUMMARY] [Thread summary: test]');
    expect(dump).toContain('Prior Steps Execution:\n- [succeeded] Step A\n  Output: {"success":true}\n- [failed] Step B\n  Error: Network error');
    expect(dump).toContain('</context>');
  });
});
