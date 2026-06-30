const fs = require('fs');
const file = 'src/server/agent/handlers/directReply.ts';
let code = fs.readFileSync(file, 'utf8');

const runReplacement = `
    const replyText = await generateSimpleResponse(input.messageText, input.selectedModel, history, input.attachments || []);

    // Update thread memory
    const updatedHistory = [...history, { role: 'user' as const, text: input.messageText, attachments: input.attachments }, { role: 'model' as const, text: replyText }];
`;

code = code.replace(
  /const replyText = await generateSimpleResponse\(input\.messageText, input\.selectedModel, history\);\n\s*\/\/ Update thread memory\n\s*const updatedHistory = \[\.\.\.history, \{ role: 'user' as const, text: input\.messageText \}, \{ role: 'model' as const, text: replyText \}\];/m,
  runReplacement.trim()
);

fs.writeFileSync(file, code);
