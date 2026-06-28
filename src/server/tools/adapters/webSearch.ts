import type { ExternalAdapter } from './base.js';
import type { AgentTool, ToolExecutionContext } from '../../agent/types.js';

const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');
const TAVILY_API_URL = 'https://api.tavily.com/search';
const DEFAULT_MAX_RESULTS = 5;
const MAX_CONTENT_CHARS = 500; // truncate per-result content to keep output bounded

interface WebSearchInput {
  query: string;
  maxResults?: number; // 1–10, defaults to DEFAULT_MAX_RESULTS
}

interface WebSearchResult {
  title: string;
  url: string;
  content: string;   // snippet/excerpt, truncated to MAX_CONTENT_CHARS
  score: number;     // relevance score from Tavily (0.0–1.0)
}

interface WebSearchOutput {
  query: string;
  resultCount: number;
  results: WebSearchResult[];
}

interface TavilyResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>;
}

export class WebSearchAdapter implements ExternalAdapter {
  name = 'Web Search';
  description = 'Search the web using Tavily and return structured results for downstream generate steps.';

  isConfigured(): boolean {
    return !!process.env.TAVILY_API_KEY;
  }

  getTools(): AgentTool[] {
    return [this.webSearchTool];
  }

  private webSearchTool: AgentTool<WebSearchInput, WebSearchOutput> = {
    name: 'search.query',
    description: 'Search the web for current information. Input: query (string), maxResults (optional int 1-10). Returns ranked results with title, url, content snippet, and relevance score.',
    riskLevel: 'read',
    requiresApproval: false,

    async execute(input: WebSearchInput, _context: ToolExecutionContext): Promise<WebSearchOutput> {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        throw new Error('TAVILY_API_KEY is not configured');
      }

      const clampedMaxResults = Math.min(Math.max(1, input.maxResults ?? DEFAULT_MAX_RESULTS), 10);

      const requestBody = {
        api_key: apiKey,
        query: input.query,
        max_results: clampedMaxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false
      };

      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Tavily API error (${response.status}): ${errorBody}`);
      }

      const data = await response.json() as any;

      if (!data || !Array.isArray(data.results)) {
        throw new Error('Tavily API returned unexpected response shape');
      }

      const tavilyResponse = data as TavilyResponse;

      const mappedResults: WebSearchResult[] = tavilyResponse.results.map(res => {
        let truncatedContent = res.content;
        if (truncatedContent.length > MAX_CONTENT_CHARS) {
          truncatedContent = truncatedContent.slice(0, MAX_CONTENT_CHARS) + '…';
        }
        return {
          title: res.title,
          url: res.url,
          content: truncatedContent,
          score: res.score
        };
      });

      return {
        query: input.query,
        resultCount: mappedResults.length,
        results: mappedResults
      };
    }
  };
}
