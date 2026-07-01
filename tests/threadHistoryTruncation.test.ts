import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveThreadHistory, getThreadHistory, threadMemory } from '../src/server/state.js';
import { generateSimpleResponse } from '../src/server/ai.js';
import { renderContextForPrompt } from '../src/server/agent/context.js';
import * as attachmentsModule from '../src/server/agent/attachments.js';
import type { ThreadMessage } from '../src/types.js';
import type { AgentAttachment } from '../src/server/agent/types.js';

const isDbAvailableMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const queryMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../src/server/storage/db.js', () => {
  return {
    isDbAvailable: isDbAvailableMock,
    query: queryMock
  };
});

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: vi.fn().mockResolvedValue('mocked response')
}));

describe('Thread History Truncation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDbAvailableMock.mockResolvedValue(true);
    threadMemory.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Message-count cap still enforced at the default of 20 for text-only threads (no regression)', async () => {
    const threadKey = 'test-1';
    const messages: ThreadMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'model', text: `msg ${i}` });
    }

    await saveThreadHistory(threadKey, messages);

    // Test memory path
    const memHist = threadMemory.get(threadKey);
    expect(memHist?.length).toBe(20);
    expect(memHist?.[0].text).toBe('msg 5');

    // DB query gets called with trimmed
    expect(queryMock).toHaveBeenCalledTimes(1);
    const dbCallArgs = queryMock.mock.calls[0][1];
    expect(dbCallArgs[0]).toBe(threadKey);
    const dbMessages = JSON.parse(dbCallArgs[1]);
    expect(dbMessages.length).toBe(20);
    expect(dbMessages[0].text).toBe('msg 5');
  });

  it('2. Persisted attachments have base64Data stripped; filename/mimeType/sizeBytes retained', async () => {
    const threadKey = 'test-2';
    const attachments: AgentAttachment[] = [
      { filename: 'a.png', mimeType: 'image/png', base64Data: 'Zm9v', sizeBytes: 100, sourceUrl: 'http://foo' }
    ];
    const messages: ThreadMessage[] = [
      { role: 'user', text: 'hello', attachments }
    ];

    await saveThreadHistory(threadKey, messages);

    const memHist = threadMemory.get(threadKey);
    expect(memHist?.[0].attachments?.[0].base64Data).toBeUndefined();
    expect(memHist?.[0].attachments?.[0].sourceUrl).toBeUndefined();
    expect(memHist?.[0].attachments?.[0].filename).toBe('a.png');
    expect(memHist?.[0].attachments?.[0].sizeBytes).toBe(100);
  });

  it('3. Message with text longer than 4000 chars is truncated with marker, role preserved', async () => {
    const threadKey = 'test-3';
    const longText = 'A'.repeat(4500);
    const messages: ThreadMessage[] = [
      { role: 'model', text: longText }
    ];

    await saveThreadHistory(threadKey, messages);

    const memHist = threadMemory.get(threadKey);
    expect(memHist?.[0].role).toBe('model');
    expect(memHist?.[0].text?.length).toBeLessThan(4500);
    expect(memHist?.[0].text).toContain('…[truncated, original 4500chars]');
    expect(memHist?.[0].text?.startsWith('A'.repeat(4000))).toBe(true);
  });

  it('4. Thread whose messages collectively exceed 40000 chars gets older messages dropped', async () => {
    const threadKey = 'test-4';
    const messages: ThreadMessage[] = [];
    // MAX is 40000. Each message is ~4000, 11 messages = ~44000 chars.
    for (let i = 0; i < 11; i++) {
      messages.push({ role: 'user', text: 'B'.repeat(3990) + `${i.toString().padStart(10, '0')}` });
    }

    await saveThreadHistory(threadKey, messages);

    const memHist = threadMemory.get(threadKey);
    // Should keep 10 messages (10 * 4000 = 40000 chars)
    expect(memHist?.length).toBe(10);
    // Dropped the oldest message '...0000000000'
    expect(memHist?.[0].text?.endsWith('0000000001')).toBe(true);
  });

  it('5. generateSimpleResponse uses text note for historical attachments, uses attachmentsToGeminiParts for live attachments', async () => {
    const spy = vi.spyOn(attachmentsModule, 'attachmentsToGeminiParts');
    const threadHistory: ThreadMessage[] = [
      { role: 'user', text: 'hist', attachments: [{ filename: 'hist.png', mimeType: 'image/png', base64Data: '', sizeBytes: 10 }] as any }
    ];
    const liveAttachments: AgentAttachment[] = [
      { filename: 'live.png', mimeType: 'image/png', base64Data: 'Zm9v', sizeBytes: 100 }
    ];

    await generateSimpleResponse('live text', 'v0-auto', threadHistory, liveAttachments);

    // attachmentsToGeminiParts should be called exactly once for the live attachments
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(liveAttachments);

    spy.mockRestore();
  });

  it('6. In-memory fallback produces identical trimming/stripping to DB path', async () => {
    isDbAvailableMock.mockResolvedValue(false);

    const threadKey = 'test-6';
    const longText = 'C'.repeat(4500);
    const attachments: AgentAttachment[] = [
      { filename: 'a.png', mimeType: 'image/png', base64Data: 'Zm9v', sizeBytes: 100 }
    ];
    const messages: ThreadMessage[] = [
      { role: 'user', text: longText, attachments }
    ];

    await saveThreadHistory(threadKey, messages);

    const memHist = threadMemory.get(threadKey);
    expect(queryMock).not.toHaveBeenCalled();
    expect(memHist?.[0].text).toContain('…[truncated, original 4500chars]');
    expect(memHist?.[0].attachments?.[0].base64Data).toBeUndefined();
  });

  it('7. Empty history and no-attachment messages are unaffected', async () => {
    const threadKey = 'test-7';
    await saveThreadHistory(threadKey, []);
    expect(threadMemory.get(threadKey)).toEqual([]);

    const messages: ThreadMessage[] = [
      { role: 'user', text: 'hello' },
      { role: 'model', text: 'world' }
    ];
    await saveThreadHistory(threadKey, messages);
    const memHist = threadMemory.get(threadKey);
    expect(memHist).toEqual(messages);
  });

  it('8. renderContextForPrompt only reads msg.text, not msg.attachments', () => {
    const threadHistory: ThreadMessage[] = [
      { role: 'user', text: 'test text', attachments: [{ filename: 'foo.png' } as any] }
    ];
    const ctx = {
      threadHistory,
      memoryRecords: [],
      priorSteps: [],
      goal: 'test'
    };
    const rendered = renderContextForPrompt(ctx);
    expect(rendered).toContain('user: test text');
    expect(rendered).not.toContain('foo.png');
  });
});
