import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSimpleResponse } from '../src/server/ai.js';
import * as geminiClient from '../src/server/agent/geminiClient.js';
import * as models from '../src/server/agent/models.js';
import * as context from '../src/server/agent/context.js';
import type { AgentAttachment } from '../src/server/agent/types.js';

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: vi.fn(),
}));

vi.mock('../src/server/agent/models.js', () => ({
  resolveModel: vi.fn((m) => m),
}));

vi.mock('../src/server/agent/context.js', () => ({
  formatDateForContext: vi.fn(() => '2023-10-27T10:00:00Z'),
}));

describe('generateSimpleResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_INCLUDE_DATETIME = 'true';
  });

  it('should call geminiCall with correct parameters and return the response', async () => {
    vi.mocked(geminiClient.geminiCall).mockResolvedValueOnce('Mocked response');
    const text = 'Hello AI';
    const modelName = 'gemini-test';

    const result = await generateSimpleResponse(text, modelName);

    expect(geminiClient.geminiCall).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(geminiClient.geminiCall).mock.calls[0][0];

    expect(callArgs.model).toBe('gemini-test');
    expect(callArgs.contents).toHaveLength(1);
    expect(callArgs.contents[0].role).toBe('user');
    expect(callArgs.contents[0].parts).toEqual([{ text: 'Hello AI' }]);
    expect(callArgs.label).toBe('directReply');
    expect(callArgs.config?.systemInstruction).toContain('Current date and time: 2023-10-27T10:00:00Z');

    expect(result).toBe('Mocked response');
  });

  it('should return "(Empty response)" when geminiCall returns empty string', async () => {
    vi.mocked(geminiClient.geminiCall).mockResolvedValueOnce('');
    const result = await generateSimpleResponse('text', 'model');
    expect(result).toBe('(Empty response)');
  });

  it('should format threadHistory correctly', async () => {
    vi.mocked(geminiClient.geminiCall).mockResolvedValueOnce('OK');
    const threadHistory = [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello', attachments: [{ filename: 'test.png' }] }
    ];

    await generateSimpleResponse('How are you?', 'model', threadHistory);

    const callArgs = vi.mocked(geminiClient.geminiCall).mock.calls[0][0];
    expect(callArgs.contents).toHaveLength(3);
    expect(callArgs.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Hi' }] });
    expect(callArgs.contents[1]).toEqual({ role: 'assistant', parts: [{ text: 'Hello\n[Attached: test.png]' }] });
    expect(callArgs.contents[2]).toEqual({ role: 'user', parts: [{ text: 'How are you?' }] });
  });

  it('should include attachments in user parts', async () => {
    vi.mocked(geminiClient.geminiCall).mockResolvedValueOnce('OK');
    const attachments: AgentAttachment[] = [{
      filename: 'image.png',
      mimeType: 'image/png',
      base64Data: 'base64str',
      sizeBytes: 100
    }];

    await generateSimpleResponse('Look at this', 'model', [], attachments);

    const callArgs = vi.mocked(geminiClient.geminiCall).mock.calls[0][0];
    expect(callArgs.contents).toHaveLength(1);
    expect(callArgs.contents[0].parts).toHaveLength(2);
    expect(callArgs.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'base64str' }
    });
    expect(callArgs.contents[0].parts[1]).toEqual({ text: 'Look at this' });
  });

  it('should omit datetime when AGENT_INCLUDE_DATETIME is false', async () => {
    process.env.AGENT_INCLUDE_DATETIME = 'false';
    vi.mocked(geminiClient.geminiCall).mockResolvedValueOnce('OK');

    await generateSimpleResponse('Hi', 'model');

    const callArgs = vi.mocked(geminiClient.geminiCall).mock.calls[0][0];
    expect(callArgs.config?.systemInstruction).not.toContain('Current date and time:');
  });
});
