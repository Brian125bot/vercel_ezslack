const fs = require('fs');
const file = 'api/workflows/agentRun.ts';
let code = fs.readFileSync(file, 'utf8');

const importReplacement = `
import { classifyIntent } from '../../src/server/agent/intent.js';
import { runAgentPipeline } from '../../src/server/agent/orchestrator.js';
import { isDbAvailable } from '../../src/server/storage/db.js';
import { agentStore } from '../../src/server/storage/agentStore.js';
import { Semaphore } from '../../src/server/agent/semaphore.js';
import { selectedModel, getSelectedModel, updateLog } from '../../src/server/state.js';
import { processSlackFiles } from '../../src/server/agent/attachments.js';
`;

code = code.replace(
  /import \{ classifyIntent \} from '\.\.\/\.\.\/src\/server\/agent\/intent\.js';\nimport \{ runAgentPipeline \} from '\.\.\/\.\.\/src\/server\/agent\/orchestrator\.js';\nimport \{ isDbAvailable \} from '\.\.\/\.\.\/src\/server\/storage\/db\.js';\nimport \{ agentStore \} from '\.\.\/\.\.\/src\/server\/storage\/agentStore\.js';\nimport \{ Semaphore \} from '\.\.\/\.\.\/src\/server\/agent\/semaphore\.js';\nimport \{ selectedModel, getSelectedModel, updateLog \} from '\.\.\/\.\.\/src\/server\/state\.js';/,
  importReplacement.trim()
);

const intentReplacement = `
    const hasPendingApproval = dbAvailable ? await agentStore.hasPendingApproval(workspaceId, event.channel) : false;

    // NOTE: classifyIntent does not currently consider attachments. A message
    // with only an image and no text may be misclassified. Tracked as a known
    // follow-up, not addressed in this change.
    const intentResult = await classifyIntent(promptText, selectedModel, {
`;
code = code.replace(
  /const hasPendingApproval = dbAvailable \? await agentStore\.hasPendingApproval\(workspaceId, event\.channel\) : false;\n\n    const intentResult = await classifyIntent\(promptText, selectedModel, \{/m,
  intentReplacement.trim() + " {"
);


const processReplacement = `
    const promptText = (event.text || "").substring(0, 50000);

    const botToken = process.env.SLACK_BOT_TOKEN;
    const { attachments, skipped } = await processSlackFiles(event.files, botToken);
    if (skipped.length > 0) {
      console.log(\`[Vercel Workflow] Skipped \${skipped.length} attachment(s): \${skipped.map(s => \`\${s.filename} (\${s.reason})\`).join(', ')}\`);
    }

    const threadTsTarget = event.thread_ts || event.ts;
`;
code = code.replace(
  /const promptText = \(event\.text \|\| ""\)\.substring\(0, 50000\); \n    const threadTsTarget = event\.thread_ts \|\| event\.ts;/m,
  processReplacement.trim()
);


const runReplacement = `
      result = await runAgentPipeline({
        workspaceId,
        channelId: event.channel,
        userId: event.user,
        messageText: promptText,
        eventId: eventId,
        messageTs: event.ts,
        threadTs: threadTsTarget,
        selectedModel,
        signatureValid: signatureVerified,
        sourceType: 'slack',
        dbAvailable,
        intentResult,
        attachments
      });
`;
code = code.replace(
  /result = await runAgentPipeline\(\{\n\s*workspaceId,\n\s*channelId: event\.channel,\n\s*userId: event\.user,\n\s*messageText: promptText,\n\s*eventId: eventId,\n\s*messageTs: event\.ts,\n\s*threadTs: threadTsTarget,\n\s*selectedModel,\n\s*signatureValid: signatureVerified,\n\s*sourceType: 'slack',\n\s*dbAvailable,\n\s*intentResult\n\s*\}\);/m,
  runReplacement.trim()
);


fs.writeFileSync(file, code);
