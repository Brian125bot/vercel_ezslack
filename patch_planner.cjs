const fs = require('fs');
const file = 'src/server/agent/planner.ts';
let code = fs.readFileSync(file, 'utf8');

const importReplacement = `
import type { AgentPlanDraft, PlannedAgentStep, AgentRiskLevel, AgentAttachment } from './types.js';
import { geminiCall } from './geminiClient.js';
import { resolveModel } from './models.js';
import { toolRegistry } from '../tools/registry.js';
import { attachmentsToGeminiParts } from './attachments.js';
`;

code = code.replace(
  /import type \{ AgentPlanDraft.*?\}\s+from '\.\/types\.js';\s*import \{ geminiCall \}\s+from '\.\/geminiClient\.js';\s*import \{ resolveModel \}\s+from '\.\/models\.js';\s*import \{ toolRegistry \}\s+from '\.\.\/tools\/registry\.js';/m,
  importReplacement.trim()
);

const fnSig = `
export async function createPlan(
  goalTitle: string,
  originalInstruction: string,
  selectedModel: string,
  contextBlock?: string,
  attachments?: AgentAttachment[]
): Promise<AgentPlanDraft> {
`;

code = code.replace(
  /export async function createPlan\(goalTitle: string, originalInstruction: string, selectedModel: string, contextBlock\?: string\): Promise<AgentPlanDraft> \{/,
  fnSig.trim() + ' {'
);

const promptInsert = `5. Use the correct tool names and schemas as provided above.
6. If files are attached (see "Attached files" in context), you may reference them by name in a "generate" step's input.prompt (e.g. "Describe the contents of screenshot.png") — the attachment will be available to that generation call automatically.`;

code = code.replace(/5\. Use the correct tool names and schemas as provided above\./, promptInsert);

const callReplacement = `
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
`;

code = code.replace(
  /const responseText = await geminiCall\(\{\n\s*model: resolveModel\(selectedModel\),\n\s*contents: prompt,\n\s*config: \{\n\s*responseMimeType: 'application\/json',\n\s*responseSchema: responseSchema\n\s*\},\n\s*label: 'planner'\n\s*\}\);/,
  callReplacement.trim()
);

fs.writeFileSync(file, code);
