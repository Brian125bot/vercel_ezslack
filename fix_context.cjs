const fs = require('fs');
const file = 'src/server/agent/context.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  'goal: goal.title + "\\n" + goal.original_instruction,',
  'goal: goal.title + "\\\\n" + goal.original_instruction,'
);

fs.writeFileSync(file, code);
