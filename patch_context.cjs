const fs = require('fs');
const file = 'src/server/agent/context.ts';
let code = fs.readFileSync(file, 'utf8');

const importReplacement = `
import { agentStore } from '../storage/agentStore.js';
import type { AgentRunTrace, AgentRun, AgentGoal } from '../storage/types.js';
import type { PlanningContext } from './types.js';
import { getThreadHistory } from '../state.js';
import { attachmentCache } from './attachments.js';
`;

code = code.replace(/import { agentStore.*?;[\s\S]*?import { getThreadHistory.*?;/, importReplacement.trim());

const attachmentsLookup = `
  // Retrieve prior steps
  const priorSteps = await agentStore.getStepsForRun(run.id);

  // Retrieve attachments from the in-memory cache keyed by run.id (since goal lacks flexible column)
  const attachments = attachmentCache.get(run.id);

  return {
    goal: goal.title + "\\n" + goal.original_instruction,
    threadHistory,
    memoryRecords,
    priorSteps,
    feedback: run.failure_reason || undefined,
    attachments
  };
`;

code = code.replace(
  /const priorSteps = await agentStore\.getStepsForRun\(run\.id\);\n\n  return \{\n    goal: goal\.title \+ "\\\\n" \+ goal\.original_instruction,\n    threadHistory,\n    memoryRecords,\n    priorSteps,\n    feedback: run\.failure_reason \|\| undefined\n  \};\n/g,
  attachmentsLookup.trim() + "\n"
);


const renderReplacement = `
export function renderContextForPrompt(ctx: PlanningContext): string {
  let dump = \`<context>\\n\`;
  dump += \`Goal: \${ctx.goal}\\n\`;
  if (ctx.attachments && ctx.attachments.length > 0) {
    dump += \`Attached files: \${ctx.attachments.map(a => \`\${a.filename} (\${a.mimeType})\`).join(', ')}\\n\`;
  }
  if (ctx.feedback) dump += \`Feedback from previous run: \${ctx.feedback}\\n\`;
`;

code = code.replace(
  /export function renderContextForPrompt\(ctx: PlanningContext\): string {\n  let dump = \`<context>\\n\`;\n  dump \+= \`Goal: \${ctx\.goal}\\n\`;\n  if \(ctx\.feedback\) dump \+= \`Feedback from previous run: \${ctx\.feedback}\\n\`;/,
  renderReplacement.trim()
);

fs.writeFileSync(file, code);
