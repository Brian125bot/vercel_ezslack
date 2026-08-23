import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubIssueAdapter } from '../../../src/server/tools/adapters/githubIssue.js';
import type { ToolExecutionContext } from '../../../src/server/agent/types.js';

describe('GitHubIssueAdapter', () => {
  const originalEnv = process.env;
  let adapter: GitHubIssueAdapter;
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
    adapter = new GitHubIssueAdapter();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('isConfigured() returns false when GITHUB_TOKEN is absent', () => {
    delete process.env.GITHUB_TOKEN;
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when GITHUB_TOKEN is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    expect(adapter.isConfigured()).toBe(true);
  });

  it('getTools() returns exactly one tool named github.createIssue', () => {
    const tools = adapter.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('github.createIssue');
  });

  it('github.createIssue riskLevel is external_write and requiresApproval is true', () => {
    const tools = adapter.getTools();
    const tool = tools[0];
    expect(tool.riskLevel).toBe('external_write');
    expect(tool.requiresApproval).toBe(true);
  });

  it('execute() throws when GITHUB_TOKEN is missing at call time', async () => {
    delete process.env.GITHUB_TOKEN;
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ owner: 'o', repo: 'r', title: 't' }, mockContext)).rejects.toThrow(/GITHUB_TOKEN is not configured/);
  });

  it('execute() throws when required input fields are missing', async () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ repo: 'r', title: 't' } as any, mockContext)).rejects.toThrow(/owner, repo, and title are required/);
    await expect(tool.execute({ owner: 'o', title: 't' } as any, mockContext)).rejects.toThrow(/owner, repo, and title are required/);
    await expect(tool.execute({ owner: 'o', repo: 'r' } as any, mockContext)).rejects.toThrow(/owner, repo, and title are required/);
  });

  it('execute() correctly calls fetch and returns success', async () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    const tools = adapter.getTools();
    const tool = tools[0];

    const mockIssueResponse = {
      number: 42,
      html_url: 'https://github.com/owner/repo/issues/42',
      title: 'Test Issue Title'
    };

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(mockIssueResponse), { status: 201 }))
    );

    const input = { owner: 'test-owner', repo: 'test-repo', title: 'Test Issue Title', body: 'Issue body', labels: ['bug'] };
    const output = await tool.execute(input, mockContext);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.github.com/repos/test-owner/test-repo/issues', expect.objectContaining({
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ghp_testtoken',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: 'Test Issue Title',
        body: 'Issue body',
        labels: ['bug']
      })
    }));

    expect(output.status).toBe('success');
    expect(output.issueNumber).toBe(42);
    expect(output.issueUrl).toBe('https://github.com/owner/repo/issues/42');
    expect(output.title).toBe('Test Issue Title');

    fetchSpy.mockRestore();
  });

  it('execute() throws when GitHub API returns a non-ok status', async () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    const tools = adapter.getTools();
    const tool = tools[0];

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('Validation Failed', { status: 422 }))
    );

    const input = { owner: 'test-owner', repo: 'test-repo', title: 'Test Issue Title' };
    await expect(tool.execute(input, mockContext)).rejects.toThrow(/GitHub API error \(422\): Validation Failed/);

    fetchSpy.mockRestore();
  });
});
