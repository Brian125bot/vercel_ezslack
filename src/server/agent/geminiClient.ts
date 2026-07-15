import { GoogleGenAI, Type } from '@google/genai';
import { slog } from './log.js';

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '30000');
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '3');

export class GeminiCallError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retriesAttempted?: number,
    public readonly label?: string
  ) {
    super(message);
    this.name = 'GeminiCallError';
  }
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiCallOptions {
  model: string;
  contents: string | Array<{ role: string; parts: GeminiPart[] }>;
  config?: Record<string, any>;
  label?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Abort signal tied to a wall-clock deadline; cancels the in-flight call. */
  signal?: AbortSignal;
}

/** A single model-requested tool invocation. */
export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** Normalized, SDK-agnostic structured response used by the planner and ReAct loop. */
export interface GeminiStructuredResponse {
  text?: string;
  functionCalls?: GeminiFunctionCall[];
  /** Raw parts from the response candidate, preserved so that Part-level fields
   *  (notably `thoughtSignature`) survive into conversation history. */
  parts?: any[];
  finishReason?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiAgentStepOptions {
  model: string;
  contents: any[];
  tools?: any[];
  signal?: AbortSignal;
  label?: string;
  config?: Record<string, any>;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/**
 * Core generateContent wrapper with timeout, retry, exponential backoff, and
 * abort-signal support. Shared by geminiCall / geminiCallStructured / geminiAgentStep.
 * Returns the raw SDK response (callers map its getters to a normalized shape).
 */
async function rawGenerate(options: GeminiCallOptions): Promise<any> {
  const {
    model,
    contents,
    config = {},
    label = 'gemini',
    timeoutMs = GEMINI_TIMEOUT_MS,
    maxRetries = GEMINI_MAX_RETRIES,
    signal
  } = options;

  // Fail fast on an already-aborted deadline — never hit the network.
  if (signal?.aborted) {
    throw new GeminiCallError(`Gemini call aborted before start (${label})`, undefined, 0, label);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ai = getClient();

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          ...config,
          httpOptions: {
            timeout: timeoutMs,
            ...(config.httpOptions || {})
          },
          ...(signal ? { abortSignal: signal } : {})
        }
      });

      if (attempt > 0) {
        slog('geminiClient', 'retry_succeeded', { label, attempt, model });
      }
      return response;
    } catch (err: any) {
      // A deadline abort is intentional; never retry it.
      const aborted =
        signal?.aborted ||
        err.name === 'AbortError' ||
        err.message?.toLowerCase().includes('aborted');
      if (aborted) {
        throw new GeminiCallError(`Gemini call aborted (${label})`, err.status, attempt, label);
      }

      lastError = err;
      const status = err.status || err.code || 0;
      const isRetryable =
        status === 429 || status === 503 || status === 500 ||
        err.message?.includes('timeout') || err.message?.includes('ECONNRESET');

      if (!isRetryable || attempt >= maxRetries) {
        slog('geminiClient', 'call_failed', {
          label,
          model,
          attempt,
          status,
          error: err.message,
          retryable: isRetryable
        });
        throw new GeminiCallError(
          `Gemini call failed after ${attempt + 1} attempt(s): ${err.message}`,
          status,
          attempt,
          label
        );
      }

      // Exponential backoff: 1s, 2s, 4s...
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
      slog('geminiClient', 'retry_backoff', { label, attempt: attempt + 1, delayMs, status, error: err.message });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Should not reach here, but satisfies TypeScript
  throw lastError || new GeminiCallError('Unknown error', undefined, maxRetries, label);
}

/** Map a raw SDK response's getters into a normalized GeminiStructuredResponse. */
function mapStructured(response: any): GeminiStructuredResponse {
  const text = response.text || undefined;
  const functionCalls: GeminiFunctionCall[] | undefined = response.functionCalls?.map((fc: any) => ({
    name: fc.name || '',
    args: (fc.args as Record<string, unknown>) || {},
    ...(fc.id ? { id: fc.id } : {})
  }));
  const candidate = response.candidates?.[0];
  const usage = response.usageMetadata;

  return {
    ...(text ? { text } : {}),
    ...(functionCalls && functionCalls.length > 0 ? { functionCalls } : {}),
    parts: response.candidates?.[0]?.content?.parts,
    ...(candidate?.finishReason ? { finishReason: String(candidate.finishReason) } : {}),
    ...(usage?.promptTokenCount != null ? { promptTokenCount: usage.promptTokenCount } : {}),
    ...(usage?.candidatesTokenCount != null ? { candidatesTokenCount: usage.candidatesTokenCount } : {}),
    ...(usage?.totalTokenCount != null ? { totalTokenCount: usage.totalTokenCount } : {})
  };
}

/**
 * Calls the Gemini API with timeout, retry, and exponential backoff, returning
 * the raw text. Supports an abort signal tied to a wall-clock deadline.
 */
export async function geminiCall(options: GeminiCallOptions): Promise<string> {
  const response = await rawGenerate(options);
  return response.text || '';
}

/**
 * Calls the Gemini API with native tool-calling support, returning a normalized
 * structured response (function calls, text, finish reason, token usage). Fails
 * fast on an already-aborted signal and never retries an AbortError.
 */
export async function geminiCallStructured(options: GeminiCallOptions): Promise<GeminiStructuredResponse> {
  const response = await rawGenerate(options);
  return mapStructured(response);
}

/**
 * Enhanced agent-loop step: native tool-calling with AUTO function-calling mode,
 * abort-signal support, and *real* token streaming via the SDK's
 * `generateContentStream`. The full structured response (text + function calls +
 * token usage) is resolved once the stream completes, and `streaming` replays the
 * accumulated text chunks so callers can surface tokens to the user (e.g. post an
 * incremental Slack reply) after the response is ready.
 */
export async function geminiAgentStep(
  opts: GeminiAgentStepOptions
): Promise<GeminiStructuredResponse & { streaming?: AsyncIterable<string> }> {
  const { model, contents, tools, signal, label = 'agentStep', config = {} } = opts;

  const mergedConfig: Record<string, any> = { ...config };
  if (tools && tools.length > 0) {
    mergedConfig.tools = tools;
    mergedConfig.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  if (signal?.aborted) {
    throw new GeminiCallError(`Gemini agent step aborted before start (${label})`, undefined, 0, label);
  }

  const ai = getClient();

  const textChunks: string[] = [];
  let text = '';
  const functionCalls: GeminiFunctionCall[] = [];
  let finishReason: string | undefined;
  let usage: any;
  let rawParts: any[] | undefined;

  try {
    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        ...mergedConfig,
        httpOptions: { timeout: GEMINI_TIMEOUT_MS, ...(mergedConfig.httpOptions || {}) },
        ...(signal ? { abortSignal: signal } : {})
      }
    });

    // Collect raw functionCall parts from chunks while deduplicating by
    // (name + serialized args) to handle potential incremental streaming.
    const seenParts = new Set<string>();
    const accumulatedParts: any[] = [];

    for await (const chunk of stream) {
      if (chunk.text) {
        text += chunk.text;
        textChunks.push(chunk.text);
      }
      if (chunk.functionCalls) {
        for (const fc of chunk.functionCalls) {
          functionCalls.push({
            name: fc.name || '',
            args: (fc.args as Record<string, unknown>) || {},
            ...(fc.id ? { id: fc.id } : {})
          });
        }
        // Preserve Part-level fields (thoughtSignature) from the raw response.
        const chunkParts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of chunkParts) {
          if (part.functionCall) {
            const key = part.functionCall.name + JSON.stringify(part.functionCall.args || {});
            if (!seenParts.has(key)) {
              seenParts.add(key);
              accumulatedParts.push(part);
            }
          }
        }
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finishReason = String(candidate.finishReason);
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    if (accumulatedParts.length > 0) rawParts = accumulatedParts;
  } catch (err: any) {
    // A deadline abort is intentional; surface it distinctly.
    const aborted =
      signal?.aborted || err.name === 'AbortError' || err.message?.toLowerCase().includes('aborted');
    if (aborted) {
      throw new GeminiCallError(`Gemini agent step aborted (${label})`, err.status, 0, label);
    }
    throw new GeminiCallError(`Gemini agent step failed: ${err.message}`, err.status, 0, label);
  }

  const structured: GeminiStructuredResponse = {
    ...(text ? { text } : {}),
    ...(functionCalls.length > 0 ? { functionCalls } : {}),
    parts: rawParts,
    ...(finishReason ? { finishReason } : {}),
    ...(usage?.promptTokenCount != null ? { promptTokenCount: usage.promptTokenCount } : {}),
    ...(usage?.candidatesTokenCount != null ? { candidatesTokenCount: usage.candidatesTokenCount } : {}),
    ...(usage?.totalTokenCount != null ? { totalTokenCount: usage.totalTokenCount } : {})
  };

  // Buffered replay of the text chunks so the caller can surface tokens to the
  // user after the full response has resolved (the loop needs the complete
  // response — function calls in particular — before it can act).
  const streaming: AsyncIterable<string> = (async function* () {
    for (const c of textChunks) yield c;
  })();

  return { ...structured, streaming };
}

// Re-export so callers that still expect the SDK `Type` enum can reach it.
export { Type };
