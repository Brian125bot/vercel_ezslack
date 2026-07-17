import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock the Redis helpers so we can simulate shared/distributed lockout state
// across "instances" as well as a Redis-down fallback scenario.
const redisMock = vi.hoisted(() => ({
  isRedisConfigured: vi.fn(),
  recordAuthFailure: vi.fn(),
  isAuthLockedOut: vi.fn(),
  lockoutAuth: vi.fn(),
  resetAuthFailures: vi.fn(),
}));

vi.mock('../src/server/redis.js', () => redisMock);

const addLogMock = vi.hoisted(() => vi.fn());
vi.mock('../src/server/state.js', () => ({ addLog: addLogMock }));

const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'correct-horse-battery-staple';

type MockRes = Response & {
  statusCode: number;
  body: unknown;
};

function makeReq(password: string, ip = '203.0.113.7'): Request {
  return {
    headers: {
      authorization: `Bearer ${password}`,
      'x-forwarded-for': ip,
    },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function makeRes(): MockRes {
  const res = {} as MockRes;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
}

async function loadAuth() {
  return import('../src/server/auth.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.DASHBOARD_PASSWORD = PASSWORD;

  // Sensible defaults; individual tests override.
  redisMock.isRedisConfigured.mockReturnValue(true);
  redisMock.recordAuthFailure.mockResolvedValue(1);
  redisMock.isAuthLockedOut.mockResolvedValue(false);
  redisMock.lockoutAuth.mockResolvedValue(undefined);
  redisMock.resetAuthFailures.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('requireDashboardAuth - open access', () => {
  it('calls next() when DASHBOARD_PASSWORD is not set', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq('anything');
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireDashboardAuth - successful auth', () => {
  it('calls next() and resets Redis failures on correct password', async () => {
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq(PASSWORD);
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(redisMock.resetAuthFailures).toHaveBeenCalledWith('203.0.113.7');
  });

  it('does not touch Redis when Redis is not configured', async () => {
    redisMock.isRedisConfigured.mockReturnValue(false);
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq(PASSWORD);
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(redisMock.resetAuthFailures).not.toHaveBeenCalled();
  });
});

describe('requireDashboardAuth - failed auth via Redis', () => {
  it('returns 401 and records the failure without locking under threshold', async () => {
    redisMock.recordAuthFailure.mockResolvedValue(3);
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq('wrong');
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(redisMock.recordAuthFailure).toHaveBeenCalledWith('203.0.113.7');
    expect(redisMock.lockoutAuth).not.toHaveBeenCalled();
  });

  it('locks out via Redis once the failure count reaches the threshold', async () => {
    redisMock.recordAuthFailure.mockResolvedValue(5);
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq('wrong');
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(redisMock.lockoutAuth).toHaveBeenCalledWith('203.0.113.7', 15 * 60 * 1000);
    expect(res.statusCode).toBe(401);
  });

  it('returns 429 when Redis reports the IP is already locked out', async () => {
    redisMock.isAuthLockedOut.mockResolvedValue(true);
    const { requireDashboardAuth } = await loadAuth();
    const req = makeReq('wrong');
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(req, res, next);
    expect(res.statusCode).toBe(429);
    // Should short-circuit before attempting to record another failure.
    expect(redisMock.recordAuthFailure).not.toHaveBeenCalled();
  });

  it('distributed lockout respects Redis state across instances', async () => {
    // Simulate a shared Redis counter/lockout backing two independent
    // middleware "instances" (fresh module imports).
    let failures = 0;
    let lockedOut = false;
    redisMock.isRedisConfigured.mockReturnValue(true);
    redisMock.recordAuthFailure.mockImplementation(async () => ++failures);
    redisMock.isAuthLockedOut.mockImplementation(async () => lockedOut);
    redisMock.lockoutAuth.mockImplementation(async () => {
      lockedOut = true;
    });

    const ip = '198.51.100.42';

    // Instance A: 3 failed attempts.
    const modA = await loadAuth();
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await modA.requireDashboardAuth(makeReq('wrong', ip), res, vi.fn() as NextFunction);
    }

    // Instance B: a fresh import (separate in-memory Map) sees the shared count.
    vi.resetModules();
    const modB = await loadAuth();
    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      await modB.requireDashboardAuth(makeReq('wrong', ip), res, vi.fn() as NextFunction);
    }

    // 3 + 2 = 5 failures across instances => Redis lockout engaged.
    expect(lockedOut).toBe(true);
    expect(redisMock.lockoutAuth).toHaveBeenCalledWith(ip, 15 * 60 * 1000);

    // A subsequent request on instance B is now blocked with 429 via Redis.
    const blockedRes = makeRes();
    const next = vi.fn() as NextFunction;
    await modB.requireDashboardAuth(makeReq('wrong', ip), blockedRes, next);
    expect(blockedRes.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireDashboardAuth - Redis unavailable fallback', () => {
  it('logs the fallback warning when Redis is down', async () => {
    redisMock.isRedisConfigured.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { requireDashboardAuth } = await loadAuth();
    await requireDashboardAuth(makeReq('wrong'), makeRes(), vi.fn() as NextFunction);
    expect(
      warnSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('[Auth] Distributed lockout unavailable (Redis down)')
      )
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it('locks out using the in-memory Map after 5 failures when Redis is down', async () => {
    redisMock.isRedisConfigured.mockReturnValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { requireDashboardAuth } = await loadAuth();
    const ip = '192.0.2.99';

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await requireDashboardAuth(makeReq('wrong', ip), res, vi.fn() as NextFunction);
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt is blocked by the in-memory lockout with a 429.
    const blockedRes = makeRes();
    const next = vi.fn() as NextFunction;
    await requireDashboardAuth(makeReq('wrong', ip), blockedRes, next);
    expect(blockedRes.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
    // No Redis calls should have been made.
    expect(redisMock.recordAuthFailure).not.toHaveBeenCalled();
    expect(redisMock.lockoutAuth).not.toHaveBeenCalled();
  });
});

describe('requireDashboardAuth - audit logging safety', () => {
  it('never logs the received or actual password, only masked IP + count', async () => {
    redisMock.recordAuthFailure.mockResolvedValue(2);
    const { requireDashboardAuth } = await loadAuth();
    await requireDashboardAuth(makeReq('super-secret-guess'), makeRes(), vi.fn() as NextFunction);
    expect(addLogMock).toHaveBeenCalledOnce();
    const logged = JSON.stringify(addLogMock.mock.calls[0][0]);
    expect(logged).not.toContain('super-secret-guess');
    expect(logged).not.toContain(PASSWORD);
    // IP is masked (no full IP in the audit event).
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).toContain('203.0.xx.xx');
  });
});
