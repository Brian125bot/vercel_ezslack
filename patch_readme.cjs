const fs = require('fs');
const file = 'README.md';
let code = fs.readFileSync(file, 'utf8');

const featuresInsert = `
### Multimodal Input

The agent can see and reason about images, screenshots, and PDFs attached to
Slack messages. Supported formats: PNG, JPEG, WebP, HEIC/HEIF, and PDF, up to
15MB per file and 4 files per message (configurable via \`MAX_ATTACHMENT_BYTES\`
and \`MAX_ATTACHMENTS_PER_MESSAGE\`). This works for both direct replies and
multi-step durable tasks — attachments are passed to Gemini as native
multimodal input, not OCR'd or pre-processed.
`;

code = code.replace(
  /---/,
  "---\n" + featuresInsert + "\n"
);

fs.writeFileSync(file, code);
