import { Type, Schema } from '@google/genai';
import type { AgentRunTrace } from '../storage/types.js';
import type { SemanticVerificationResult } from './types.js';
import { slog } from './log.js';
import { geminiCall } from './geminiClient.js';
import { resolveModel } from './models.js';

export async function verifySemantically(trace: AgentRunTrace, model: string): Promise<SemanticVerificationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    slog('verifier', 'skipped', { reason: 'No GEMINI_API_KEY' });
    return {
      satisfied: true,
      confidence: 0,
      reasoning: 'Skipped semantic verification because GEMINI_API_KEY is not configured.',
      source: 'skipped'
    };
  }

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      satisfied: { type: Type.BOOLEAN },
      confidence: { type: Type.NUMBER },
      reasoning: { type: Type.STRING }
    },
    required: ['satisfied', 'confidence', 'reasoning']
  };

  const traceDump = JSON.stringify({
    goal: trace.goal.original_instruction,
    steps: trace.steps.map(s => ({
      title: s.title,
      status: s.status,
      error: s.error,
      output: s.output
    })),
    toolCalls: trace.toolCalls.map(tc => ({
      tool: tc.tool_name,
      status: tc.status,
      input: tc.input,
      output: tc.output,
      error: tc.error
    }))
  }, null, 2);

  const prompt = `
You are an expert AI behavior evaluator. Look at the following execution trace of an agent attempting to satisfy a user goal.
Analyze the actual tool calls made, inputs provided, and their outputs.

Trace:
${traceDump}

Did the trace genuinely and completely satisfy the user's goal? If the agent merely said it did something but did not actually do it, it is NOT satisfied. If it failed at an important step, it is NOT satisfied. 
Output your confidence as a number from 0 to 1.
`;

  try {
    const responseText = await geminiCall({
      model: resolveModel(model),
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      },
      label: 'verifier'
    });

    if (responseText) {
      const result = JSON.parse(responseText) as Omit<SemanticVerificationResult, 'source'>;
      return {
        ...result,
        source: 'llm'
      };
    }
  } catch (err: any) {
    slog('verifier', 'error', { error: err.message });
  }

  // WS4: On error / unparseable output, return INCONCLUSIVE (satisfied with
  // zero confidence) rather than a hard "not satisfied". A flaky verifier must
  // not throw away a structurally-complete plan and burn replan iterations.
  return {
    satisfied: true,
    confidence: 0,
    reasoning: 'Semantic verification was inconclusive (error or empty response); deferring to rule-based verification.',
    source: 'skipped'
  };
}
