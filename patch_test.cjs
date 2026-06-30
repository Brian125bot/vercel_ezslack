const fs = require('fs');
const file = 'tests/attachments.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /import \{ describe, it, expect, vi, beforeEach \} from 'vitest';/,
  "import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';"
);

fs.writeFileSync(file, code);
