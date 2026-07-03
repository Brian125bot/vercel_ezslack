import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { slog } from './log.js';

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '30000');
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '3');

const defaultSafetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

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
 * Calls the Gemini API with timeout, retry, and exponential backoff.
 * Uses the SDK's built-in retryOptions for automatic retries.
 */
export async function geminiCall(options: GeminiCallOptions): Promise<string> {
  const res = await geminiCallRaw(options);
  return res.text || '';
}

export async function geminiCallRaw(options: GeminiCallOptions): Promise<{ text?: string; functionCalls?: any[]; parts?: any[] }> {
  const {
    model,
    contents,
    config = {},
    label = 'gemini',
    timeoutMs = GEMINI_TIMEOUT_MS,
    maxRetries = GEMINI_MAX_RETRIES
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ai = getClient();

      const mergedConfig: any = {
        safetySettings: defaultSafetySettings,
        ...config,
        httpOptions: {
          timeout: timeoutMs,
          ...(config.httpOptions || {})
        }
      };

      if (!mergedConfig.thinkingConfig && (model.includes('gemini-3') || model.includes('gemini-2.0-pro'))) {
        mergedConfig.thinkingConfig = { thinkingBudgetTokens: 2048 };
      }

      const response = await ai.models.generateContent({
        model,
        contents,
        config: mergedConfig
      });

      if (attempt > 0) {
        slog('geminiClient', 'retry_succeeded', { label, attempt, model });
      }
      return {
        text: response.text || undefined,
        functionCalls: response.functionCalls || undefined,
        parts: response.candidates?.[0]?.content?.parts || undefined
      };
    } catch (err: any) {
      lastError = err;
      const status = err.status || err.code || 0;
      const isRetryable = status === 429 || status === 503 || status === 500 || err.message?.includes('timeout') || err.message?.includes('ECONNRESET');

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

export async function createThreadCache(
  model: string, 
  systemInstruction: string, 
  contents: any[], 
  tools?: any[],
  toolConfig?: any,
  ttlSeconds: number = 3600
): Promise<string> {
  const ai = getClient();
  const cache = await ai.caches.create({
    model,
    config: {
      systemInstruction,
      contents,
      tools,
      toolConfig,
      ttl: `${ttlSeconds}s`
    }
  });
  return cache.name;
}
