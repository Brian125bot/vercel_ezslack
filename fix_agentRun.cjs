const fs = require('fs');
const file = 'api/workflows/agentRun.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /const intentResult = await classifyIntent\(promptText, selectedModel, \{ \{/,
  'const intentResult = await classifyIntent(promptText, selectedModel, {'
);

fs.writeFileSync(file, code);
