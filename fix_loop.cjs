const fs = require('fs');
const file = 'src/server/agent/loop.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  'const planDraft = await createPlan(goal.title, goal.original_instruction, run.model, contextBlock, ctx.attachments);',
  'const planDraft = await createPlan(goal.title, goal.original_instruction, run.model, contextBlock, ctx?.attachments);'
);

fs.writeFileSync(file, code);
