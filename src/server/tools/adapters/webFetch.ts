import type { ExternalAdapter } from './base.js';
import type { AgentTool, ToolExecutionContext } from '../../agent/types.js';

const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');
const DEFAULT_MAX_LENGTH = 50000; // 50KB default

interface WebFetchInput {
  url: string;
  maxLength?: number; // max characters to return
}

interface WebFetchOutput {
  url: string;
  content: string;
  contentType: string;
  contentLength: number;
  truncated: boolean;
}

export class WebFetchAdapter implements ExternalAdapter {
  name = 'Web Fetch';
  description = 'Fetch content from a URL';

  isConfigured(): boolean {
    return true; // No API key needed, uses native fetch
  }

  getTools(): AgentTool[] {
    return [this.webFetchTool];
  }

  private webFetchTool: AgentTool<WebFetchInput, WebFetchOutput> = {
    name: 'web.fetch',
    description: 'Fetch and extract text content from a URL. Input: url (string), maxLength (optional int). Returns extracted text content with metadata.',
    riskLevel: 'read',
    requiresApproval: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch content from' },
        maxLength: { type: 'integer', description: 'Maximum characters to return (default: 50000)', minimum: 1, maximum: 200000 }
      },
      required: ['url']
    },

    async execute(input: WebFetchInput, _context: ToolExecutionContext): Promise<WebFetchOutput> {
      if (!input.url) {
        throw new Error('URL is required');
      }

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(input.url);
      } catch {
        throw new Error('Invalid URL format');
      }

      // Only allow http/https
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are supported');
      }

      const maxLength = Math.min(Math.max(1, input.maxLength ?? DEFAULT_MAX_LENGTH), 200000);

      const response = await fetch(input.url, {
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SlackAI/1.0; +https://github.com/slackcloud)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || 'unknown';
      let content: string;

      // Handle different content types
      if (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('application/xml')) {
        content = await response.text();
      } else {
        // For binary content, return info about it
        const buffer = await response.arrayBuffer();
        content = `[Binary content: ${contentType}, ${buffer.byteLength} bytes]`;
      }

      const truncated = content.length > maxLength;
      if (truncated) {
        content = content.slice(0, maxLength) + '\n…[truncated]';
      }

      return {
        url: input.url,
        content,
        contentType,
        contentLength: content.length,
        truncated
      };
    }
  };
}