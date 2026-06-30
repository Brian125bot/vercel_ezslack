const fs = require('fs');
const file = 'src/server/agent/handlers/durableTask.ts';
let code = fs.readFileSync(file, 'utf8');

const importReplacement = `
import { agentStore } from '../../storage/agentStore.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';
import { detectDeferral } from '../deferral.js';
import { enqueueRunTask } from '../taskClient.js';
import { attachmentCache } from '../attachments.js';
`;

code = code.replace(
  /import \{ agentStore \} from '\.\.\/\.\.\/storage\/agentStore\.js';\nimport \{ slackReplyInThreadTool \} from '\.\.\/\.\.\/tools\/slack\.js';\nimport type \{ AgentPipelineInput, AgentPipelineResult, ToolExecutionContext \} from '\.\.\/types\.js';\nimport \{ detectDeferral \} from '\.\.\/deferral\.js';\nimport \{ enqueueRunTask \} from '\.\.\/taskClient\.js';/,
  importReplacement.trim()
);

const runReplacement = `
    // Create a queued run
    run = await agentStore.createRun({
      goal_id: goal.id,
      model: input.selectedModel,
      status: 'queued'
    });

    // Store attachments in memory cache (keyed by run.id)
    if (input.attachments && input.attachments.length > 0) {
      attachmentCache.set(run.id, input.attachments);
    }
`;

code = code.replace(
  /\/\/ Create a queued run\n\s*run = await agentStore\.createRun\(\{\n\s*goal_id: goal\.id,\n\s*model: input\.selectedModel,\n\s*status: 'queued'\n\s*\}\);/m,
  runReplacement.trim()
);

fs.writeFileSync(file, code);
