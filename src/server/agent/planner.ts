import { Type, Schema } from '@google/genai';
import type { AgentPlanDraft } from './types.js';
import { toolsRegistry } from '../tools/registry.js';
import { geminiCall } from './geminiClient.js';

export async function createPlan(goalTitle: string, originalInstruction: string, selectedModel: string, contextBlock?: string): Promise<AgentPlanDraft> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing');
  }

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
            kind: { type: Type.STRING },
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

  // Build the tool catalogue dynamically from the registry
  const allTools = toolsRegistry.getAll();
  const toolDescriptions = allTools
    .map(t => `- ${t.name} (risk: ${t.riskLevel}) — ${t.description}`)
    .join('\n');

  let prompt = `
You are an AI agent planning a response to:
Title: ${goalTitle}
Instruction: ${originalInstruction}
`;

  if (contextBlock) {
    prompt += `\n${contextBlock}\n`;
  }

  prompt += `
Available tools:
${toolDescriptions}

Step kinds:
- "tool"    — execute a registered tool (you MUST set toolName + input)
- "generate" — call an LLM at execution time to produce text content (set prompt in input.prompt); downstream steps can consume the generated output automatically
- "note"    — conceptual/no-op step (no tool needed)

Planning rules:
1. Generate a 1-5 step plan. Prefer "generate" kind when the final reply needs content that depends on tool outputs from earlier steps (e.g. search results, memory lookups). Follow a "generate" step with a "slack.replyInThread" step — the reply text will be auto-injected from the generated output.
2. You MUST fully populate each step's \`input\` object using the information from the context.
3. For "tool" steps, include \`kind: "tool"\` (or omit kind), set \`toolName\`, and set \`input\`.
4. If a step requires an external tool not listed above, set riskLevel="external_write" and requiresApproval=true, and describe the action in the step title without a toolName.
5. Otherwise, use riskLevel="internal_write" or "read" or "draft".
`;

  try {
    const responseText = await geminiCall({
      model: selectedModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      },
      label: 'planner'
    });

    if (responseText) {
      const plan = JSON.parse(responseText) as AgentPlanDraft;
      if (!plan.riskLevel) plan.riskLevel = 'internal_write';
      
      // Validate tool names against the live registry
      if (plan.steps) {
        plan.steps = plan.steps.map(step => {
          // If kind is generate or note, no tool needed
          if (step.kind === 'generate' || step.kind === 'note') {
            step.toolName = undefined;
            return step;
          }
          // Default kind to 'tool' if toolName is specified
          if (step.toolName) {
            step.kind = step.kind || 'tool';
            if (!toolsRegistry.get(step.toolName)) {
              console.warn(`Planner generated unknown toolName: ${step.toolName}. Redacting for safety.`);
              step.toolName = undefined;
              plan.requiresApproval = true;
              plan.riskLevel = 'external_write';
            }
          }
          return step;
        });
      }
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
        title: 'Generate response content',
        kind: 'generate',
        input: { prompt: `Respond to: ${originalInstruction}` }
      },
      {
        title: 'Send response to user',
        kind: 'tool',
        toolName: 'slack.replyInThread',
        input: { text: '' } // auto-populated from generate step
      }
    ],
    riskLevel: 'internal_write',
    requiresApproval: false
  };
}
