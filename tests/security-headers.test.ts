import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { Express } from 'express';
import type { AddressInfo } from 'net';

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

// ── Development mode (default) ──────────────────────────────────
describe('default (development) security headers', () => {
  let server: http.Server;

  beforeAll(async () => {
    process.env.VERCEL = '1';
    process.env.DISABLE_HTTPS_REDIRECT = '1';
    process.env.GEMINI_API_KEY = 'test-ai-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-real-token';
    process.env.SLACK_SIGNING_SECRET = 'real-signing-secret';
    process.env.DASHBOARD_PASSWORD = 'strong-password';
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
    process.env.APP_URL = 'https://example.com';
    process.env.REQUIRE_REDIS = 'false';
    process.env.REQUIRE_DURABLE_STATE = 'false';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.resetModules();
    const mod = await import('../server.js');
    const app: Express = mod.default;
    await new Promise<void>(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets Content-Security-Policy with default-src self', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
  });

  it('sets Content-Security-Policy with frame-ancestors none', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sets Content-Security-Policy with script-src including unsafe-inline', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('sets Content-Security-Policy with object-src none', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("object-src 'none'");
  });

  it('does NOT set Strict-Transport-Security in development mode', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('includes frame-ancestors none in CSP', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ── Production mode ─────────────────────────────────────────────
describe('production security headers', () => {
  let server: http.Server;

  beforeAll(async () => {
    process.env.VERCEL = '1';
    process.env.DISABLE_HTTPS_REDIRECT = '1';
    process.env.NODE_ENV = 'production';
    process.env.GEMINI_API_KEY = 'test-ai-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-real-token';
    process.env.SLACK_SIGNING_SECRET = 'real-signing-secret';
    process.env.DASHBOARD_PASSWORD = 'strong-password';
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
    process.env.APP_URL = 'https://example.com';
    process.env.REQUIRE_REDIS = 'false';
    process.env.REQUIRE_DURABLE_STATE = 'false';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.resetModules();
    const mod = await import('../server.js');
    const app: Express = mod.default;
    await new Promise<void>(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(() => {
    server?.close();
    process.env.NODE_ENV = 'test';
  });

  it('sets Strict-Transport-Security with max-age=31536000 and includeSubDomains', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const hsts = res.headers.get('strict-transport-security');
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets Content-Security-Policy with upgrade-insecure-requests', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

// ── HTTPS redirect (production only) ────────────────────────────
describe('HTTPS redirect (production)', () => {
  let server: http.Server;

  beforeAll(async () => {
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'production';
    process.env.GEMINI_API_KEY = 'test-ai-key';
    process.env.SLACK_BOT_TOKEN = 'xoxb-real-token';
    process.env.SLACK_SIGNING_SECRET = 'real-signing-secret';
    process.env.DASHBOARD_PASSWORD = 'strong-password';
    process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
    process.env.APP_URL = 'https://example.com';
    process.env.REQUIRE_REDIS = 'false';
    process.env.REQUIRE_DURABLE_STATE = 'false';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.DISABLE_HTTPS_REDIRECT;
    vi.resetModules();
    const mod = await import('../server.js');
    const app: Express = mod.default;
    await new Promise<void>(resolve => {
      server = http.createServer(app).listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(() => {
    server?.close();
    process.env.NODE_ENV = 'test';
  });

  it('redirects with 301 when x-forwarded-proto is http', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: getPort(server),
        path: '/api/health',
        method: 'GET',
        headers: { 'x-forwarded-proto': 'http' },
      }, resolve);
      req.on('error', reject);
      req.end();
    });
    expect(res.statusCode).toBe(301);
    const location = res.headers['location'] || '';
    expect(location).toMatch(/^https:\/\//);
    expect(location).toContain('/api/health');
  });

  it('uses APP_URL for redirect host to prevent host header injection', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: getPort(server),
        path: '/api/health',
        method: 'GET',
        headers: { 'x-forwarded-proto': 'http', 'host': 'evil.com' },
      }, resolve);
      req.on('error', reject);
      req.end();
    });
    expect(res.statusCode).toBe(301);
    const location = res.headers['location'] || '';
    expect(location).toMatch(/^https:\/\/example\.com/);
    expect(location).toContain('/api/health');
  });

  it('passes through (200) when x-forwarded-proto is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/api/health`);
    expect(res.status).toBe(200);
  });

  it('returns 400 when APP_URL is not set in production', async () => {
    const originalAppUrl = process.env.APP_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit called with ${code}`);
    });
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.APP_URL;
      vi.resetModules();

      await expect(import('../server.js')).rejects.toThrow();
    } finally {
      process.env.APP_URL = originalAppUrl;
      process.env.NODE_ENV = originalNodeEnv;
      exitSpy.mockRestore();
    }
  });

  it('returns 400 when APP_URL is invalid in production', async () => {
    const originalAppUrl = process.env.APP_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit called with ${code}`);
    });
    try {
      process.env.NODE_ENV = 'production';
      process.env.REQUIRE_REDIS = 'false';
      process.env.REQUIRE_DURABLE_STATE = 'false';
      process.env.APP_URL = 'not-a-url';
      vi.resetModules();

      await expect(import('../server.js')).rejects.toThrow('APP_URL must be a valid URL in production for HTTPS redirect security');
    } finally {
      process.env.APP_URL = originalAppUrl;
      process.env.NODE_ENV = originalNodeEnv;
      exitSpy.mockRestore();
    }
  });
});
