const fs = require('fs');
const file = 'src/types.ts';
let code = fs.readFileSync(file, 'utf8');

const replacement = `
import type { AgentAttachment } from './server/agent/types.js';

export interface ServerStatus {
`;

code = code.replace(/export interface ServerStatus \{/, replacement.trim());

code = code.replace(
  /export interface ThreadMessage \{\n  role: 'user' \| 'model';\n  text: string;\n\}/,
  `export interface ThreadMessage {\n  role: 'user' | 'model';\n  text: string;\n  attachments?: AgentAttachment[];\n}`
);

fs.writeFileSync(file, code);
