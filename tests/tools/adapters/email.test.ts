import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EmailAdapter } from '../../../src/server/tools/adapters/email.js';
import type { ToolExecutionContext } from '../../../src/server/agent/types.js';

describe('EmailAdapter', () => {
  const originalEnv = process.env;
  let adapter: EmailAdapter;
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
    adapter = new EmailAdapter();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('isConfigured() returns false when EMAIL_WEBHOOK_URL is absent', () => {
    delete process.env.EMAIL_WEBHOOK_URL;
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when EMAIL_WEBHOOK_URL is set', () => {
    process.env.EMAIL_WEBHOOK_URL = 'http://example.com/webhook';
    expect(adapter.isConfigured()).toBe(true);
  });

  it('getTools() returns exactly one tool named email.send', () => {
    const tools = adapter.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('email.send');
  });

  it('email.send riskLevel is external_write and requiresApproval is true', () => {
    const tools = adapter.getTools();
    const tool = tools[0];
    expect(tool.riskLevel).toBe('external_write');
    expect(tool.requiresApproval).toBe(true);
  });

  it('execute() throws when EMAIL_WEBHOOK_URL is missing at call time', async () => {
    delete process.env.EMAIL_WEBHOOK_URL;
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ to: 'a@b.com', subject: 's', body: 'b' }, mockContext)).rejects.toThrow(/EMAIL_WEBHOOK_URL is not configured/);
  });

  it('execute() throws when required input fields are missing', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'http://example.com/webhook';
    const tools = adapter.getTools();
    const tool = tools[0];

    await expect(tool.execute({ subject: 's', body: 'b' } as any, mockContext)).rejects.toThrow(/to, subject, and body are required/);
    await expect(tool.execute({ to: 'a@b.com', body: 'b' } as any, mockContext)).rejects.toThrow(/to, subject, and body are required/);
    await expect(tool.execute({ to: 'a@b.com', subject: 's' } as any, mockContext)).rejects.toThrow(/to, subject, and body are required/);
  });

  it('execute() correctly calls fetch and returns success', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'http://example.com/webhook';
    const tools = adapter.getTools();
    const tool = tools[0];

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    const input = { to: 'test@example.com', subject: 'Test Subject', body: 'Test Body' };
    const output = await tool.execute(input, mockContext);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('http://example.com/webhook', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }));

    expect(output.status).toBe('success');
    expect(output.to).toBe(input.to);
    expect(output.subject).toBe(input.subject);
    expect(output.message).toBe('Email dispatched');

    fetchSpy.mockRestore();
  });

  it('execute() throws when webhook returns a non-ok status', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'http://example.com/webhook';
    const tools = adapter.getTools();
    const tool = tools[0];

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('Bad Request', { status: 400 }))
    );

    const input = { to: 'test@example.com', subject: 'Test Subject', body: 'Test Body' };
    await expect(tool.execute(input, mockContext)).rejects.toThrow(/Email webhook error \(400\): Bad Request/);

    fetchSpy.mockRestore();
  });
});
