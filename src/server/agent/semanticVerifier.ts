/**
 * Semantic Verifier (W2-D).
 *
 * The rule-based verifier (verifier.ts) only checks that steps mechanically succeeded. This
 * adds an LLM judge that decides whether the goal was *actually* met given the goal text and
 * the outputs produced. A run is only allowed to succeed when BOTH the rule verifier and this
 * semantic verifier are satisfied (enforced in loop.ts).
 *
 * If no model/API key is available (e.g. local tests), it returns a low-confidence "skipped"
 * pass so the system still functions, while clearly marking that semantic verification did not
 * actually run.
 */
import { GoogleGenAI } from '@google/genai';
import type { AgentRunTrace } from '../storage/types.js';
import type { SemanticVerificationResult } from './types.js';

export async function verifySemantically(
  trace: AgentRunTrace,
  selectedModel: string
): Promise<SemanticVerificationResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return {
      satisfied: true,
      confidence: 'low',
      reasoning: 'Semantic verification skipped: no model API key configured.',
      source: 'skipped',
    };
  }

  const goal = trace.goal;
  const stepSummary = (trace.steps || [])
    .map((s) => `- [${s.status}] ${s.title}${s.output ? `: ${typeof s.output === 'string' ? s.output : JSON.stringify(s.output)}` : ''}${s.error ? ` (error: ${s.error})` : ''}`)
    .join('\n');

  const prompt = `You are a strict verification judge. Decide whether the agent ACTUALLY accomplished the user's goal.

User goal: "${goal?.title}"
Original instruction: "${goal?.original_instruction}"

Executed steps and their outputs:
${stepSummary || '(no steps executed)'}

Judge whether the goal has been genuinely and completely satisfied by these outputs. Be skeptical: empty, placeholder, generic, or off-topic outputs do NOT satisfy the goal. A reply that does not actually address the instruction is NOT satisfied.

Respond with EXACTLY this JSON and nothing else:
{
  "satisfied": true | false,
  "confidence": "high" | "medium" | "low",
  "reasoning": "one or two sentences"
}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: selectedModel,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text?.trim() || '{}');
    return {
      satisfied: parsed.satisfied === true,
      confidence: (['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium') as 'high' | 'medium' | 'low',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided.',
      source: 'llm',
    };
  } catch (err: any) {
    // On judge failure, do not falsely claim success — report not satisfied so the loop replans.
    return {
      satisfied: false,
      confidence: 'low',
      reasoning: `Semantic verifier error: ${err?.message || String(err)}`,
      source: 'llm',
    };
  }
}
