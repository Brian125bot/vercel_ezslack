import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGeminiCall = vi.hoisted(() => vi.fn());
const mockSlog = vi.hoisted(() => vi.fn());
const mockAttachmentsToGeminiParts = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: mockGeminiCall,
}));

vi.mock('../src/server/agent/log.js', () => ({
  slog: mockSlog,
}));

vi.mock('../src/server/agent/attachments.js', () => ({
  attachmentsToGeminiParts: mockAttachmentsToGeminiParts,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createPlan', () => {
  it('throws when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const { createPlan } = await import('../src/server/agent/planner.js');
    await expect(createPlan('Title', 'Instruction', 'gemini-2.5-flash'))
      .rejects.toThrow('GEMINI_API_KEY is missing');
  });

  it('returns parsed plan on successful geminiCall', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      summary: 'Test plan',
      assumptions: ['User knows the system'],
      steps: [
        { title: 'Step 1', kind: 'tool', toolName: 'slack.replyInThread', input: { text: 'hello' } },
      ],
      riskLevel: 'read',
      requiresApproval: false,
    }));
    const { createPlan } = await import('../src/server/agent/planner.js');
    const plan = await createPlan('Title', 'Instruction', 'gemini-2.5-flash');
    expect(plan.summary).toBe('Test plan');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].toolName).toBe('slack.replyInThread');
  });

  it('redacts unknown tools and logs them', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      summary: 'Bad tools',
      assumptions: [],
      steps: [
        { title: 'Fake', kind: 'tool', toolName: 'nonexistent.tool', input: {} },
      ],
      riskLevel: 'read',
      requiresApproval: false,
    }));
    const { createPlan } = await import('../src/server/agent/planner.js');
    const plan = await createPlan('Title', 'Inst', 'gemini-2.5-flash');
    expect(plan.steps[0].toolName).toBeUndefined();
    expect(mockSlog).toHaveBeenCalledWith('planner', 'tools_redacted', expect.objectContaining({
      tools: ['nonexistent.tool'],
    }));
  });

  it('returns fallback plan when geminiCall returns null', async () => {
    mockGeminiCall.mockResolvedValue(null);
    const { createPlan } = await import('../src/server/agent/planner.js');
    const plan = await createPlan('Title', 'Inst', 'gemini-2.5-flash');
    expect(plan.summary).toBe('Directly execute the given instruction');
    expect(plan.steps).toHaveLength(2);
  });

  it('returns fallback plan when geminiCall throws', async () => {
    mockGeminiCall.mockRejectedValue(new Error('API error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createPlan } = await import('../src/server/agent/planner.js');
    const plan = await createPlan('Title', 'Inst', 'gemini-2.5-flash');
    expect(plan.summary).toBe('Directly execute the given instruction');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('includes context block in prompt when provided', async () => {
    mockGeminiCall.mockResolvedValue(null);
    const { createPlan } = await import('../src/server/agent/planner.js');
    await createPlan('Title', 'Inst', 'gemini-2.5-flash', '<context>Some context</context>');
    const callArg = mockGeminiCall.mock.calls[0][0];
    const promptText = typeof callArg.contents === 'string' ? callArg.contents : callArg.contents[0]?.parts?.[0]?.text || '';
    expect(promptText).toContain('<context>Some context</context>');
  });

  it('uses contents array format when attachments are provided', async () => {
    mockGeminiCall.mockResolvedValue(null);
    mockAttachmentsToGeminiParts.mockReturnValue([{ inlineData: { mimeType: 'image/png', data: '...' } }]);
    const { createPlan } = await import('../src/server/agent/planner.js');
    await createPlan('Title', 'Inst', 'gemini-2.5-flash', undefined, [
      { filename: 'img.png', mimeType: 'image/png' } as any,
    ]);
    const callArg = mockGeminiCall.mock.calls[0][0];
    expect(Array.isArray(callArg.contents)).toBe(true);
    expect(callArg.contents[0].parts).toHaveLength(2); // attachment part + text part
  });

  it('passes through date/time line from context block into the prompt', async () => {
    mockGeminiCall.mockResolvedValue(null);
    const { createPlan } = await import('../src/server/agent/planner.js');
    const contextBlock = `<context>\nCurrent date and time: 2026-07-16 10:30:00 America/Chicago\nGoal: test\n</context>`;
    await createPlan('Title', 'Inst', 'gemini-2.5-flash', contextBlock);
    const callArg = mockGeminiCall.mock.calls[0][0];
    const promptText = typeof callArg.contents === 'string' ? callArg.contents : callArg.contents?.[0]?.parts?.[0]?.text || '';
    expect(promptText).toContain('Current date and time: 2026-07-16 10:30:00 America/Chicago');
  });

  it('filters the planner-visible tool list when allowedTools is restricted', async () => {
    mockGeminiCall.mockResolvedValue(null);
    const { createPlan } = await import('../src/server/agent/planner.js');

    await createPlan('Title', 'Inst', 'gemini-2.5-flash', undefined, undefined, ['slack.replyInThread']);

    const callArg = mockGeminiCall.mock.calls[0][0];
    const promptText = typeof callArg.contents === 'string' ? callArg.contents : callArg.contents?.[0]?.parts?.[0]?.text || '';
    expect(promptText).toContain('slack.replyInThread');
    expect(promptText).not.toContain('memory.write');
    expect(promptText).not.toContain('task.record');
  });
});
