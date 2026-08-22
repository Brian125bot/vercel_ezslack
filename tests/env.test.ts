import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('validateEnv', () => {
  const originalEnv = process.env;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit(1)');
    }) as any);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function setAllVars() {
    process.env.GEMINI_API_KEY = 'test-ai-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-real-token';
    process.env.SLACK_SIGNING_SECRET = 'real-signing-secret';
    process.env.DASHBOARD_PASSWORD = 'strong-password';
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
    process.env.APP_URL = 'https://example.com';
    process.env.WORKFLOW_INTERNAL_SECRET = 'test-workflow-internal-secret';
  }

  // ── Critical: missing vars ──────────────────────────────────────────────

  it('rejects missing GEMINI_API_KEY', async () => {
    setAllVars();
    delete process.env.GEMINI_API_KEY;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GEMINI_API_KEY'));
  });

  it('rejects empty GEMINI_API_KEY', async () => {
    setAllVars();
    process.env.GEMINI_API_KEY = '';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GEMINI_API_KEY'));
  });

  it('rejects missing SLACK_BOT_TOKEN', async () => {
    setAllVars();
    delete process.env.SLACK_BOT_TOKEN;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SLACK_BOT_TOKEN'));
  });

  it('rejects missing SLACK_SIGNING_SECRET', async () => {
    setAllVars();
    delete process.env.SLACK_SIGNING_SECRET;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SLACK_SIGNING_SECRET'));
  });

  it('warns (does not exit) when DASHBOARD_PASSWORD is missing in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_PASSWORD;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_PASSWORD'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_PASSWORD'));
  });

  it('warns (does not exit) when DASHBOARD_PASSWORD is missing in dev', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    delete process.env.DASHBOARD_PASSWORD;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_PASSWORD'));
  });

  // ── Critical: placeholders ──────────────────────────────────────────────

  it('rejects placeholder GEMINI_API_KEY', async () => {
    setAllVars();
    process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects placeholder SLACK_BOT_TOKEN', async () => {
    setAllVars();
    process.env.SLACK_BOT_TOKEN = 'xoxb-myslackbottoken';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects placeholder SLACK_SIGNING_SECRET (both variants)', async () => {
    setAllVars();
    process.env.SLACK_SIGNING_SECRET = 'my_slack_signing_secret';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects placeholder SLACK_SIGNING_SECRET with MY_SIGNING_SECRET', async () => {
    setAllVars();
    process.env.SLACK_SIGNING_SECRET = 'MY_SIGNING_SECRET';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('warns (does not exit) on placeholder DASHBOARD_PASSWORD in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_PASSWORD = 'my_dashboard_password';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  // ── Critical vars hard-fail outside production (Vercel non-prod) ─────────

  it('rejects missing SLACK_SIGNING_SECRET in non-production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    delete process.env.SLACK_SIGNING_SECRET;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SLACK_SIGNING_SECRET'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Signature verification is disabled'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('.env.example'));
  });

  it('rejects missing GEMINI_API_KEY in non-production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    delete process.env.GEMINI_API_KEY;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GEMINI_API_KEY'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('.env.example'));
  });

  it('warns (does not exit) on placeholder DASHBOARD_PASSWORD in dev', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    process.env.DASHBOARD_PASSWORD = 'my_dashboard_password';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('warns (does not exit) on generic placeholder "changeme" in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_PASSWORD = 'changeme';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  // ── Critical: database ──────────────────────────────────────────────────

  it('rejects missing all database configs in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    delete process.env.SQL_HOST;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
  });

  it('rejects missing all database configs in non-production (Vercel dev mode)', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    delete process.env.SQL_HOST;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
  });

  it('accepts DATABASE_URL as sole DB config', async () => {
    setAllVars();
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    delete process.env.SQL_HOST;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts CLOUD_SQL_CONNECTION_NAME as sole DB config', async () => {
    setAllVars();
    delete process.env.DATABASE_URL;
    delete process.env.SQL_HOST;
    process.env.CLOUD_SQL_CONNECTION_NAME = 'my-project:us-central1:my-db';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts SQL_HOST as sole DB config', async () => {
    setAllVars();
    delete process.env.DATABASE_URL;
    delete process.env.CLOUD_SQL_CONNECTION_NAME;
    process.env.SQL_HOST = '/cloudsql/my-project:us-central1:my-db';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── Critical: APP_URL in production ────────────────────────────────────

  it('rejects missing APP_URL in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('APP_URL'));
  });

  it('warns about missing APP_URL in dev (does not exit)', async () => {
    setAllVars();
    process.env.NODE_ENV = 'development';
    delete process.env.APP_URL;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('APP_URL'));
  });

  it('rejects placeholder APP_URL in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'changeme';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects placeholder DATABASE_URL in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'changeme';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects placeholder CLOUD_SQL_CONNECTION_NAME in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    process.env.CLOUD_SQL_CONNECTION_NAME = 'placeholder';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('passes when all critical vars are set', async () => {
    setAllVars();
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('passes in production with APP_URL set', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'https://my-app.vercel.app';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── Critical: internal workflow authentication ──────────────────────────

  it('rejects missing WORKFLOW_INTERNAL_SECRET in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    delete process.env.WORKFLOW_INTERNAL_SECRET;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_INTERNAL_SECRET'));
  });

  it('rejects a placeholder WORKFLOW_INTERNAL_SECRET in production', async () => {
    setAllVars();
    process.env.NODE_ENV = 'production';
    process.env.WORKFLOW_INTERNAL_SECRET = 'my_workflow_internal_secret';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  it('rejects missing WORKFLOW_INTERNAL_SECRET on Vercel regardless of NODE_ENV', async () => {
    setAllVars();
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'development';
    delete process.env.WORKFLOW_INTERNAL_SECRET;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_INTERNAL_SECRET'));
  });

  // ── Vercel guard ────────────────────────────────────────────────────────

  it('enforces validation on Vercel deployments (VERCEL=1)', async () => {
    process.env.VERCEL = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.DATABASE_URL;
    delete process.env.WORKFLOW_INTERNAL_SECRET;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── External adapter warnings ───────────────────────────────────────────

  it('warns on missing optional adapter vars', async () => {
    setAllVars();
    delete process.env.TAVILY_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.EMAIL_WEBHOOK_URL;
    delete process.env.SANDBOX_API_KEY;
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TAVILY_API_KEY'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EMAIL_WEBHOOK_URL'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SANDBOX_API_KEY'));
  });

  it('warns on placeholder adapter vars', async () => {
    setAllVars();
    process.env.TAVILY_API_KEY = 'placeholder';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('placeholder'));
  });

  // ── Security: no value leaks ───────────────────────────────────────────

  it('does not log actual secret values', async () => {
    setAllVars();
    process.env.GEMINI_API_KEY = 'super-secret-key-12345';
    process.env.DASHBOARD_PASSWORD = 'p@ssw0rd!';
    process.env.SLACK_BOT_TOKEN = 'xoxb-top-secret-token';
    process.env.WORKFLOW_INTERNAL_SECRET = 'workflow-secret-do-not-log';
    const { validateEnv } = await import('../src/server/env.js');
    expect(() => validateEnv()).not.toThrow();
    for (const call of errorSpy.mock.calls) {
      const msg = call[0] as string;
      expect(msg).not.toContain('super-secret-key-12345');
      expect(msg).not.toContain('p@ssw0rd!');
      expect(msg).not.toContain('xoxb-top-secret-token');
      expect(msg).not.toContain('workflow-secret-do-not-log');
    }
    for (const call of warnSpy.mock.calls) {
      const msg = call[0] as string;
      expect(msg).not.toContain('super-secret-key-12345');
      expect(msg).not.toContain('p@ssw0rd!');
      expect(msg).not.toContain('xoxb-top-secret-token');
      expect(msg).not.toContain('workflow-secret-do-not-log');
    }
  });
});
