const fs = require('fs');
const file = 'src/server/agent/planner.ts';
let code = fs.readFileSync(file, 'utf8');

const importReplacement = `
import { Type, Schema } from '@google/genai';
import type { AgentPlanDraft, AgentAttachment } from './types.js';
import { toolsRegistry } from '../tools/registry.js';
import { geminiCall } from './geminiClient.js';
import { normalizePlanDraft } from './planNormalize.js';
import { resolveModel } from './models.js';
import { slog } from './log.js';
import { attachmentsToGeminiParts } from './attachments.js';
`;

code = code.replace(
  /import \{ Type, Schema \} from '@google\/genai';\nimport type \{ AgentPlanDraft \} from '\.\/types\.js';\nimport \{ toolsRegistry \} from '\.\.\/tools\/registry\.js';\nimport \{ geminiCall \} from '\.\/geminiClient\.js';\nimport \{ normalizePlanDraft \} from '\.\/planNormalize\.js';\nimport \{ resolveModel \} from '\.\/models\.js';\nimport \{ slog \} from '\.\/log\.js';/,
  importReplacement.trim()
);

code = code.replace(
  /export async function createPlan\([\s\S]*?\): Promise<AgentPlanDraft> \{ \{/,
  `export async function createPlan(
  goalTitle: string,
  originalInstruction: string,
  selectedModel: string,
  contextBlock?: string,
  attachments?: AgentAttachment[]
): Promise<AgentPlanDraft> {`
);

fs.writeFileSync(file, code);
