import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSearchAdapter } from '../src/server/tools/adapters/webSearch.js';
import type { ToolExecutionContext } from '../src/server/agent/types.js';

describe('WebSearchAdapter', () => {
  const originalEnv = process.env;
  let adapter: WebSearchAdapter;
  const mockContext: ToolExecutionContext = {
    runId: 'run-001',
    stepId: 'step-001',
    workspaceId: 'W001',
    channelId: 'C001',
    userId: 'U001',
    messageTs: '1234567890.000001',
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    adapter = new WebSearchAdapter();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('isConfigured() returns false when TAVILY_API_KEY is absent', () => {
    delete process.env.TAVILY_API_KEY;
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when TAVILY_API_KEY is set', () => {
    process.env.TAVILY_API_KEY = 'test-key';
    expect(adapter.isConfigured()).toBe(true);
  });

  it('getTools() returns exactly one tool named search.query', () => {
    const tools = adapter.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('search.query');
  });

  it('search.query riskLevel is read and requiresApproval is false', () => {
    const tools = adapter.getTools();
    const tool = tools[0];
    expect(tool.riskLevel).toBe('read');
    expect(tool.requiresApproval).toBe(false);
  });

  it('execute() returns structured results on a successful API response', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    const tools = adapter.getTools();
    const tool = tools[0];

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        results: [{ title: 'T', url: 'U', content: 'C', score: 0.9 }]
      }), { status: 200 }))
    );

    const output = await tool.execute({ query: 'test query' }, mockContext);

    expect(output.query).toBe('test query');
    expect(output.resultCount).toBe(1);
    expect(output.results[0].title).toBe('T');
    expect(output.results[0].url).toBe('U');
    expect(output.results[0].score).toBe(0.9);

    fetchSpy.mockRestore();
  });

  it('execute() truncates content longer than MAX_CONTENT_CHARS and appends ellipsis', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    const tools = adapter.getTools();
    const tool = tools[0];

    const longContent = 'A'.repeat(600);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        results: [{ title: 'T', url: 'U', content: longContent, score: 0.9 }]
      }), { status: 200 }))
    );

    const output = await tool.execute({ query: 'test query' }, mockContext);

    expect(output.results[0].content.length).toBeLessThanOrEqual(503); // 500 chars + '…'
    expect(output.results[0].content.endsWith('…')).toBe(true);
    expect(output.results[0].content).toBe('A'.repeat(500) + '…');

    fetchSpy.mockRestore();
  });

  it('execute() throws when Tavily API returns a non-ok status', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    const tools = adapter.getTools();
    const tool = tools[0];

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('rate limited', { status: 429 }))
    );

    await expect(tool.execute({ query: 'test query' }, mockContext)).rejects.toThrow(/Tavily API error \(429\)/);

    fetchSpy.mockRestore();
  });

  it('execute() throws when TAVILY_API_KEY is missing at call time', async () => {
    delete process.env.TAVILY_API_KEY;
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ query: 'x' }, mockContext)).rejects.toThrow(/TAVILY_API_KEY is not configured/);
  });
});
