import { Type, Schema } from '@google/genai';
import type { AgentPlanDraft, AgentAttachment } from './types.js';
import { toolsRegistry } from '../tools/registry.js';
import { geminiCall } from './geminiClient.js';
import { normalizePlanDraft } from './planNormalize.js';
import { resolveModel } from './models.js';
import { slog } from './log.js';
import { attachmentsToGeminiParts } from './attachments.js';

export async function createPlan(
  goalTitle: string,
  originalInstruction: string,
  selectedModel: string,
  contextBlock?: string,
  attachments?: AgentAttachment[]
): Promise<AgentPlanDraft> {
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
  const toolNames = allTools.map(t => t.name).join(', ');

  let prompt = `
You are an AI agent planning a response to:
Title: ${goalTitle}
Instruction: ${originalInstruction}
`;

  if (contextBlock) {
    prompt += `\n${contextBlock}\n`;
  }

  prompt += `
Available tools (these are the ONLY tools that exist):
${toolDescriptions}

Step kinds:
- "tool"    — execute a registered tool (you MUST set toolName + input)
- "generate" — call an LLM at execution time to produce text content (set prompt in input.prompt); downstream steps can consume the generated output automatically
- "note"    — conceptual/no-op step (no tool needed)

Planning rules:
1. Generate a 1-5 step plan. Prefer "generate" kind when a step needs content that depends on tool outputs from earlier steps or on attached files (e.g. search results, memory lookups, screenshot/PDF analysis). A "generate" step's output can feed directly into the NEXT tool step's input field via \`injectInto\` (see rule 6) — this works for any tool, not just slack.replyInThread.
2. You MUST fully populate each step's \`input\` object using the information from the context. For "generate" steps, ALWAYS set \`input.prompt\`.
3. For "tool" steps, include \`kind: "tool"\`, set \`toolName\` to one of EXACTLY these names: ${toolNames}. Do NOT invent tool names.
4. If the task needs an action for which no tool exists above, do NOT fabricate a tool. Instead use a "generate" step to draft the content and a "slack.replyInThread" step to tell the user what was prepared and that the action could not be executed automatically.
5. Set riskLevel to one of: read, draft, internal_write, external_write. Set requiresApproval=true ONLY if a step uses an external_write tool.
6. If the goal requires acting on an attached file's contents (e.g. filing an issue based on a screenshot, summarizing a PDF into a tool's input field), use a "generate" step to produce that content, and set that generate step's \`injectInto\` to the exact field name on the FOLLOWING tool step's input that should receive it (e.g. \`injectInto: "body"\` for github.createIssue, or \`injectInto: "text"\` for slack.replyInThread). The generate step's output will automatically replace that field's value on the next tool step. If files are attached (see "Attached files" in context), you may also reference them by name in the generate step's input.prompt (e.g. "Describe the error visible in screenshot.png").
`;

  try {
    const contents = attachments && attachments.length > 0
    ? [{ role: 'user', parts: [...attachmentsToGeminiParts(attachments), { text: prompt }] }]
    : prompt;

  const responseText = await geminiCall({
    model: resolveModel(selectedModel),
    contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema
    },
    label: 'planner'
  });

    if (responseText) {
      const raw = JSON.parse(responseText) as AgentPlanDraft;
      const { plan, redactedTools } = normalizePlanDraft(raw, toolsRegistry);
      if (redactedTools.length > 0) {
        slog('planner', 'tools_redacted', { tools: redactedTools });
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
