import { GoogleGenAI, Type, Schema } from '@google/genai';
import type { AgentPlanDraft } from './types.js';

export async function createPlan(goalTitle: string, originalInstruction: string, selectedModel: string): Promise<AgentPlanDraft> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const ai = new GoogleGenAI({ apiKey });

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      assumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
      steps: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            toolName: { type: Type.STRING },
            input: { type: Type.OBJECT }
          },
          required: ['title']
        }
      },
      riskLevel: { type: Type.STRING },
      requiresApproval: { type: Type.BOOLEAN }
    },
    required: ['summary', 'assumptions', 'steps', 'riskLevel', 'requiresApproval']
  };

  const prompt = `
You are an AI agent planning a response to:
Title: ${goalTitle}
Instruction: ${originalInstruction}

Available safe tools:
- slack.replyInThread (input: { text: string })
- memory.write (input: { content: string, kind: string, visibility: string })
- memory.search (input: { query: string, kind?: string })
- task.record (input: { title: string, notes?: string })

Generate a simple 1-3 step plan to accomplish this goal.
If the task requires unsupported external action (like creating a Jira ticket, posting to social media, GitHub issue), state riskLevel="external_write" and requiresApproval=true, and don't provide a toolName.
Otherwise, use riskLevel="internal_write" or "read" or "draft".
`;

  try {
    const response = await ai.models.generateContent({
      model: selectedModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });

    if (response.text) {
      const plan = JSON.parse(response.text) as AgentPlanDraft;
      if (!plan.riskLevel) plan.riskLevel = 'internal_write';
      return plan;
    }
  } catch (err) {
    console.error('Planner failed:', err);
  }

  // Fallback plan
  return {
    summary: 'Directly execute the given instruction',
    assumptions: [],
    steps: [
      {
        title: 'Draft response',
        toolName: 'slack.replyInThread',
        input: { text: 'I received your request but planning failed to generate a sophisticated structure. How can I assist further?' }
      }
    ],
    riskLevel: 'internal_write',
    requiresApproval: false
  };
}
