import type { ExternalAdapter } from './base.js';
import type { AgentTool, ToolExecutionContext } from '../../agent/types.js';
import { createVercelSandbox, VercelSandboxProvider } from '@ai-sdk/sandbox-vercel';
import { getSessionSandboxId, setSessionSandboxId, generateSessionKey } from '../../state.js';

const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');

interface ExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}
interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ReadInput {
  path: string;
}
interface ReadOutput {
  content: string;
}

interface WriteInput {
  path: string;
  content: string;
}
interface WriteOutput {
  success: boolean;
  path: string;
}

interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
interface EditOutput {
  success: boolean;
  path: string;
  replaced: number;
}

interface LsInput {
  path: string;
}
interface LsOutput {
  entries: Array<{ name: string; type: 'file' | 'directory' }>;
}

interface GlobInput {
  pattern: string;
  cwd?: string;
}
interface GlobOutput {
  matches: string[];
}

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}
interface GrepOutput {
  matches: Array<{ file: string; line: number; content: string }>;
}

interface PythonInput {
  code: string;
  timeoutMs?: number;
}
interface PythonOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface NodeInput {
  code: string;
  timeoutMs?: number;
}
interface NodeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let sandboxProvider: ReturnType<typeof createVercelSandbox> | null = null;

function getSandboxProvider() {
  if (!sandboxProvider) {
    sandboxProvider = createVercelSandbox();
  }
  return sandboxProvider;
}

async function getOrCreateSandboxSession(sessionKey: string) {
  const provider = getSandboxProvider();
  let sandboxId = await getSessionSandboxId(sessionKey);
  let session: any;

  if (sandboxId) {
    try {
      session = await provider.resumeSession({ sessionId: sandboxId });
    } catch {
      sandboxId = null;
    }
  }

  if (!sandboxId) {
    session = await provider.createSession();
    sandboxId = session.id;
    await setSessionSandboxId(sessionKey, sandboxId);
  }

  return session;
}

export class SandboxAdapter implements ExternalAdapter {
  name = 'Sandbox';
  description = 'Code execution sandbox with file system access';

  isConfigured(): boolean {
    return !!process.env.SANDBOX_API_KEY || !!process.env.VERCEL;
  }

  getTools(): AgentTool[] {
    return [
      this.execTool,
      this.readTool,
      this.writeTool,
      this.editTool,
      this.lsTool,
      this.globTool,
      this.grepTool,
      this.pythonTool,
      this.nodeTool
    ];
  }

  private execTool: AgentTool<ExecInput, ExecOutput> = {
    name: 'sandbox.exec',
    description: 'Execute a shell command in the sandbox. Use for running scripts, build commands, tests, etc. Risk: external_write (modifies sandbox state).',
    riskLevel: 'external_write',
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute (e.g., python, node, npm, bash)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        cwd: { type: 'string', description: 'Working directory (default: /home/user)' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default: 60000)' }
      },
      required: ['command']
    },

    async execute(input: ExecInput, context: ToolExecutionContext): Promise<ExecOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const cwd = input.cwd || '/home/user';
      const timeoutMs = input.timeoutMs || TOOL_TIMEOUT_MS;

      const result = await sandbox.exec({
        command: input.command,
        args: input.args || [],
        cwd,
        timeoutMs
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }
  };

  private readTool: AgentTool<ReadInput, ReadOutput> = {
    name: 'sandbox.read',
    description: 'Read a file from the sandbox filesystem. Risk: read.',
    riskLevel: 'read',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' }
      },
      required: ['path']
    },

    async execute(input: ReadInput, context: ToolExecutionContext): Promise<ReadOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const content = await sandbox.readFile(input.path);
      return { content };
    }
  };

  private writeTool: AgentTool<WriteInput, WriteOutput> = {
    name: 'sandbox.write',
    description: 'Write a file to the sandbox filesystem. Creates parent directories if needed. Risk: internal_write.',
    riskLevel: 'internal_write',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'File content' }
      },
      required: ['path', 'content']
    },

    async execute(input: WriteInput, context: ToolExecutionContext): Promise<WriteOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      await sandbox.writeFile(input.path, input.content);
      return { success: true, path: input.path };
    }
  };

  private editTool: AgentTool<EditInput, EditOutput> = {
    name: 'sandbox.edit',
    description: 'Edit a file in the sandbox by replacing oldString with newString. Risk: internal_write.',
    riskLevel: 'internal_write',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        oldString: { type: 'string', description: 'Text to replace' },
        newString: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false)' }
      },
      required: ['path', 'oldString', 'newString']
    },

    async execute(input: EditInput, context: ToolExecutionContext): Promise<EditOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const content = await sandbox.readFile(input.path);
      const oldStr = input.oldString;
      const newStr = input.newString;
      const replaceAll = input.replaceAll || false;

      let newContent: string;
      let replaced = 0;

      if (replaceAll) {
        const parts = content.split(oldStr);
        replaced = parts.length - 1;
        newContent = parts.join(newStr);
      } else {
        const idx = content.indexOf(oldStr);
        if (idx === -1) {
          throw new Error(`String not found in file: ${oldStr.substring(0, 50)}...`);
        }
        newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        replaced = 1;
      }

      await sandbox.writeFile(input.path, newContent);
      return { success: true, path: input.path, replaced };
    }
  };

  private lsTool: AgentTool<LsInput, LsOutput> = {
    name: 'sandbox.ls',
    description: 'List directory contents in the sandbox. Risk: read.',
    riskLevel: 'read',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' }
      },
      required: ['path']
    },

    async execute(input: LsInput, context: ToolExecutionContext): Promise<LsOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const entries = await sandbox.listFiles(input.path);
      return {
        entries: entries.map((e: any) => ({
          name: e.name,
          type: e.isDirectory ? 'directory' : 'file'
        }))
      };
    }
  };

  private globTool: AgentTool<GlobInput, GlobOutput> = {
    name: 'sandbox.glob',
    description: 'Find files matching a glob pattern in the sandbox. Risk: read.',
    riskLevel: 'read',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., **/*.ts)' },
        cwd: { type: 'string', description: 'Working directory (default: /home/user)' }
      },
      required: ['pattern']
    },

    async execute(input: GlobInput, context: ToolExecutionContext): Promise<GlobOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const cwd = input.cwd || '/home/user';
      const matches = await sandbox.glob(input.pattern, { cwd });
      return { matches };
    }
  };

  private grepTool: AgentTool<GrepInput, GrepOutput> = {
    name: 'sandbox.grep',
    description: 'Search for a pattern in files within the sandbox. Risk: read.',
    riskLevel: 'read',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search (default: /home/user)' },
        include: { type: 'string', description: 'File pattern to include (e.g., *.ts)' }
      },
      required: ['pattern']
    },

    async execute(input: GrepInput, context: ToolExecutionContext): Promise<GrepOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const searchPath = input.path || '/home/user';
      const matches = await sandbox.grep(input.pattern, { path: searchPath, include: input.include });
      return {
        matches: matches.map((m: any) => ({
          file: m.file,
          line: m.line,
          content: m.content
        }))
      };
    }
  };

  private pythonTool: AgentTool<PythonInput, PythonOutput> = {
    name: 'sandbox.python',
    description: 'Execute Python code in the sandbox and return stdout/stderr. Risk: external_write.',
    riskLevel: 'external_write',
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default: 60000)' }
      },
      required: ['code']
    },

    async execute(input: PythonInput, context: ToolExecutionContext): Promise<PythonOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const timeoutMs = input.timeoutMs || TOOL_TIMEOUT_MS;
      const result = await sandbox.exec({
        command: 'python3',
        args: ['-c', input.code],
        cwd: '/home/user',
        timeoutMs
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }
  };

  private nodeTool: AgentTool<NodeInput, NodeOutput> = {
    name: 'sandbox.node',
    description: 'Execute Node.js code in the sandbox and return stdout/stderr. Risk: external_write.',
    riskLevel: 'external_write',
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript/TypeScript code to execute' },
        timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default: 60000)' }
      },
      required: ['code']
    },

    async execute(input: NodeInput, context: ToolExecutionContext): Promise<NodeOutput> {
      const sessionKey = generateSessionKey(context.workspaceId, context.channelId, context.threadTs);
      const sandbox = await getOrCreateSandboxSession(sessionKey);

      const timeoutMs = input.timeoutMs || TOOL_TIMEOUT_MS;
      const result = await sandbox.exec({
        command: 'node',
        args: ['-e', input.code],
        cwd: '/home/user',
        timeoutMs
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }
  };
}