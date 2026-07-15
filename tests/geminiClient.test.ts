import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the @google/genai SDK. The structured response getter (`functionCalls`,
// `text`) is the load-bearing behaviour we assert against, so we build mock
// responses that mimic the SDK's getters.
const mockGenerateContent = vi.hoisted(() => vi.fn());
const mockGenerateContentStream = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => {
  class GenerateContentResponse {
    constructor(private readonly data: any) {}
    get text(): string | undefined {
      return this.data?._text;
    }
    get functionCalls(): any[] | undefined {
      return this.data?._functionCalls;
    }
    get candidates(): any[] | undefined {
      return this.data?._candidates;
    }
    get usageMetadata(): any | undefined {
      return this.data?._usageMetadata;
    }
  }

  class GoogleGenAI {
    models = {
      // Wrap the raw data object the test provides into a response instance so
      // the SDK getters (text/functionCalls/usageMetadata) resolve correctly.
      generateContent: async (params: any) =>
        new GenerateContentResponse(await mockGenerateContent(params)),
      // Streaming: return a GenerateContentResponse that is also async iterable,
      // so the caller can iterate chunks AND access the aggregated response.
      generateContentStream: async (params: any) => {
        const chunks = await mockGenerateContentStream(params);
        const aggregated = chunks?.[chunks.length - 1] || {};
        const response = new GenerateContentResponse(aggregated);
        response[Symbol.asyncIterator] = async function* () {
          for (const c of chunks || []) yield new GenerateContentResponse(c);
        };
        return response;
      },
    };
  }

  return { GoogleGenAI, GenerateContentResponse };
});

// GEMINI_API_KEY is read by getClient(); set it before import.
process.env.GEMINI_API_KEY = 'test-key';

import { geminiCall, geminiCallStructured, geminiAgentStep, GeminiCallError } from '../src/server/agent/geminiClient.js';

function buildResponse(opts: {
  text?: string;
  functionCalls?: Array<{ name?: string; args?: any; id?: string }>;
  parts?: any[];
  finishReason?: string;
  usage?: any;
}) {
  return {
    _text: opts.text,
    _functionCalls: opts.functionCalls,
    _candidates: [{
      ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
      ...(opts.parts ? { content: { parts: opts.parts } } : {})
    }],
    _usageMetadata: opts.usage,
  };
}

describe('geminiClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('geminiCall (text-only)', () => {
    it('returns the concatenated text', async () => {
      mockGenerateContent.mockResolvedValue(buildResponse({ text: 'hello world' }));

      const out = await geminiCall({ model: 'gemini-2.5-flash', contents: 'hi' });
      expect(out).toBe('hello world');
    });

    it('returns empty string when no text part is present', async () => {
      mockGenerateContent.mockResolvedValue(buildResponse({ text: undefined }));

      const out = await geminiCall({ model: 'gemini-2.5-flash', contents: 'hi' });
      expect(out).toBe('');
    });

    it('passes tools/toolConfig/signal through to the SDK via config', async () => {
      mockGenerateContent.mockResolvedValue(buildResponse({ text: 'ok' }));
      const controller = new AbortController();

      await geminiCall({
        model: 'gemini-2.5-flash',
        contents: 'hi',
        signal: controller.signal,
        config: { tools: [{ functionDeclarations: [{ name: 'foo' }] }] },
      });

      const arg = mockGenerateContent.mock.calls[0][0];
      expect(arg.config.abortSignal).toBe(controller.signal);
      expect(arg.config.tools).toEqual([{ functionDeclarations: [{ name: 'foo' }] }]);
      expect(arg.config.httpOptions.timeout).toBe(30000);
    });
  });

  describe('geminiCallStructured', () => {
    it('surfaces function-call parts from the model', async () => {
      mockGenerateContent.mockResolvedValue(
        buildResponse({
          text: undefined,
          functionCalls: [
            { name: 'search.query', args: { query: 'gemini sdk', maxResults: 3 } },
          ],
          parts: [
            { functionCall: { name: 'search.query', args: { query: 'gemini sdk', maxResults: 3 } }, thoughtSignature: 'test-sig' },
          ],
          finishReason: 'STOP',
          usage: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
        })
      );

      const out = await geminiCallStructured({
        model: 'gemini-2.5-flash',
        contents: 'search for gemini sdk',
        config: { tools: [{ functionDeclarations: [{ name: 'search.query' }] }] },
      });

      expect(out.functionCalls).toHaveLength(1);
      expect(out.functionCalls![0]).toMatchObject({ name: 'search.query', args: { query: 'gemini sdk', maxResults: 3 } });
      expect(out.parts).toBeDefined();
      expect(out.parts![0].thoughtSignature).toBe('test-sig');
      expect(out.text).toBeUndefined();
      expect(out.finishReason).toBe('STOP');
      expect(out.totalTokenCount).toBe(20);
    });

    it('returns text and no functionCalls for a final natural-language answer', async () => {
      mockGenerateContent.mockResolvedValue(
        buildResponse({ text: 'final answer', finishReason: 'STOP', usage: { totalTokenCount: 5 } })
      );

      const out = await geminiCallStructured({ model: 'gemini-2.5-flash', contents: 'hi' });

      expect(out.text).toBe('final answer');
      expect(out.functionCalls).toBeUndefined();
      expect(out.totalTokenCount).toBe(5);
    });

    it('fails fast when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort('deadline');

      await expect(
        geminiCallStructured({ model: 'gemini-2.5-flash', contents: 'hi', signal: controller.signal })
      ).rejects.toThrow(/aborted/);

      // The SDK call must never start.
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('does NOT retry an AbortError (deadline cancellation is intentional)', async () => {
      const controller = new AbortController();
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      mockGenerateContent.mockRejectedValueOnce(abortErr);

      await expect(
        geminiCallStructured({ model: 'gemini-2.5-flash', contents: 'hi', signal: controller.signal })
      ).rejects.toBeInstanceOf(GeminiCallError);

      // Exactly one attempt — no backoff retries.
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('retries a 503 then succeeds', async () => {
      const fiftyThree = Object.assign(new Error('service unavailable'), { status: 503 });
      mockGenerateContent
        .mockRejectedValueOnce(fiftyThree)
        .mockResolvedValueOnce(buildResponse({ text: 'recovered' }));

      const out = await geminiCallStructured({ model: 'gemini-2.5-flash', contents: 'hi', maxRetries: 2 });

      expect(out.text).toBe('recovered');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
  });

  describe('geminiAgentStep (streaming)', () => {
    it('yields text chunks via streaming and resolves the full response', async () => {
      mockGenerateContentStream.mockResolvedValue([
        { _text: 'Hello ' },
        { _text: 'world' },
      ]);

      const out = await geminiAgentStep({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(out.text).toBe('Hello world');
      const chunks: string[] = [];
      for await (const c of out.streaming!) chunks.push(c);
      expect(chunks).toEqual(['Hello ', 'world']);
    });

    it('captures function calls and token usage from the stream', async () => {
      mockGenerateContentStream.mockResolvedValue([
        {
          _functionCalls: [{ name: 'task.record', args: { title: 'x' } }],
          _candidates: [{
            content: {
              parts: [
                { functionCall: { name: 'task.record', args: { title: 'x' } }, thoughtSignature: 'stream-sig' },
              ],
            },
          }],
          _usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
        },
      ]);

      const out = await geminiAgentStep({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: 'do it' }] }],
        tools: [{ functionDeclarations: [] }],
      });

      expect(out.functionCalls?.[0]).toMatchObject({ name: 'task.record', args: { title: 'x' } });
      expect(out.totalTokenCount).toBe(20);
      // AUTO function-calling mode is requested when tools are supplied.
      const arg = mockGenerateContentStream.mock.calls[0][0];
      expect(arg.config.toolConfig.functionCallingConfig.mode).toBe('AUTO');
      // Raw parts preserve thoughtSignature
      expect(out.parts).toBeDefined();
      expect(out.parts![0].thoughtSignature).toBe('stream-sig');
    });

    it('fails fast on an already-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort('deadline');

      await expect(
        geminiAgentStep({
          model: 'gemini-3.1-flash-lite',
          contents: [],
          signal: controller.signal,
        })
      ).rejects.toThrow(/aborted/);
      expect(mockGenerateContentStream).not.toHaveBeenCalled();
    });
  });
});
