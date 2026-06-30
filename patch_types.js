const fs = require('fs');
const file = 'src/server/agent/types.ts';
let code = fs.readFileSync(file, 'utf8');

const attachmentDef = `
// Keep in sync with AgentAttachment in attachments.ts
export interface AgentAttachment {
  filename: string;
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
  sourceUrl?: string;
}
`;

code = code.replace(
  "export type AgentRiskLevel = 'read' | 'draft' | 'internal_write' | 'external_write' | 'destructive' | 'privileged';",
  "export type AgentRiskLevel = 'read' | 'draft' | 'internal_write' | 'external_write' | 'destructive' | 'privileged';\n" + attachmentDef
);

code = code.replace(
  "intentResult?: IntentResult;",
  "intentResult?: IntentResult;\n  attachments?: AgentAttachment[];"
);

code = code.replace(
  "goal: string;\n}",
  "goal: string;\n  attachments?: AgentAttachment[];\n}"
);

fs.writeFileSync(file, code);
