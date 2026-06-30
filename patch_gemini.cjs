const fs = require('fs');
const file = 'src/server/agent/geminiClient.ts';
let code = fs.readFileSync(file, 'utf8');

const newInterface = `
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiCallOptions {
  model: string;
  contents: string | Array<{ role: string; parts: GeminiPart[] }>;
  config?: Record<string, any>;
  label?: string;
  timeoutMs?: number;
  maxRetries?: number;
}
`;

code = code.replace(
  /export interface GeminiCallOptions \{[\s\S]*?maxRetries\?: number;\n\}/,
  newInterface.trim()
);

fs.writeFileSync(file, code);
