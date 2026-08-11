import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'dns';
import { WebFetchAdapter } from '../src/server/tools/adapters/webFetch.js';
import type { ToolExecutionContext } from '../src/server/agent/types.js';

describe('WebFetchAdapter', () => {
  let adapter: WebFetchAdapter;
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  const mockContext: ToolExecutionContext = {
    runId: 'run-001',
    stepId: 'step-001',
    workspaceId: 'W001',
    channelId: 'C001',
    userId: 'U001',
    messageTs: '1234567890.000001',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new WebFetchAdapter();
    originalFetch = global.fetch;
    global.fetch = mockFetch;

    // Default mock DNS behavior for domain names in tests
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string) => {
      if (hostname === 'safe.com' || hostname === 'example.com') {
        return [{ address: '1.1.1.1', family: 4 }];
      }
      if (hostname === 'unsafe.com') {
        return [{ address: '10.0.0.1', family: 4 }];
      }
      throw new Error('DNS lookup failed in mock');
    }) as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('isConfigured() always returns true', () => {
    expect(adapter.isConfigured()).toBe(true);
  });

  it('getTools() returns exactly one tool named web.fetch', () => {
    const tools = adapter.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('web.fetch');
  });

  it('web.fetch rejects a private-range target end-to-end', async () => {
    const tools = adapter.getTools();
    const tool = tools[0];

    // direct private IP
    await expect(tool.execute({ url: 'http://127.0.0.1' }, mockContext))
      .rejects.toThrow('blocked: destination not allowed');

    // cloud metadata
    await expect(tool.execute({ url: 'http://169.254.169.254' }, mockContext))
      .rejects.toThrow('blocked: destination not allowed');

    // hostname resolving to private range
    await expect(tool.execute({ url: 'http://unsafe.com' }, mockContext))
      .rejects.toThrow('blocked: destination not allowed');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('web.fetch succeeds for a normal public URL', async () => {
    const tools = adapter.getTools();
    const tool = tools[0];

    mockFetch.mockResolvedValueOnce(new Response('Hello world', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    }));

    const result = await tool.execute({ url: 'http://safe.com' }, mockContext);
    expect(result.url).toBe('http://safe.com');
    expect(result.content).toBe('Hello world');
    expect(result.contentType).toBe('text/plain');
    expect(result.truncated).toBe(false);
  });

  it('web.fetch rejects unsupported protocols', async () => {
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ url: 'ftp://safe.com' }, mockContext))
      .rejects.toThrow('Only HTTP and HTTPS URLs are supported');

    await expect(tool.execute({ url: 'file:///etc/passwd' }, mockContext))
      .rejects.toThrow('Only HTTP and HTTPS URLs are supported');
  });

  it('web.fetch respects maxLength truncation', async () => {
    const tools = adapter.getTools();
    const tool = tools[0];

    mockFetch.mockResolvedValueOnce(new Response('1234567890', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    }));

    const result = await tool.execute({ url: 'http://safe.com', maxLength: 5 }, mockContext);
    expect(result.content).toBe('12345\n…[truncated]');
    expect(result.truncated).toBe(true);
  });

  it('web.fetch handles binary content appropriately', async () => {
    const tools = adapter.getTools();
    const tool = tools[0];

    // Mock an arrayBuffer since node fetch Responses have it
    const fakeBuffer = new ArrayBuffer(8);
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
      arrayBuffer: async () => fakeBuffer
    };
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await tool.execute({ url: 'http://safe.com' }, mockContext);
    expect(result.contentType).toBe('application/octet-stream');
    expect(result.content).toBe('[Binary content: application/octet-stream, 8 bytes]');
    expect(result.truncated).toBe(false);
  });
});
