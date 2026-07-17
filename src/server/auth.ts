import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { addLog } from './state.js';
import {
  isRedisConfigured,
  recordAuthFailure,
  isAuthLockedOut,
  lockoutAuth,
  resetAuthFailures,
} from './redis.js';

interface AuthAttempt {
  count: number;
  lockUntil: number;
}

const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

// Local in-memory cache used as a dev fallback when Redis is unavailable. When
// Redis is configured, lockout state lives in Redis so it is consistent across
// serverless instances; the Map is still updated to keep a warm local view.
const failedAttempts = new Map<string, AuthAttempt>();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',');
    return ips[0].trim();
  }
  return req.socket.remoteAddress || 'unknown-ip';
}

function maskIp(ip: string): string {
  if (ip === 'unknown-ip') return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.xx.xx`;
    }
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 2) {
      return `${parts[0]}:${parts[1]}:xxxx::`;
    }
  }
  return 'hidden-ip';
}

export const requireDashboardAuth = async (req: Request, res: Response, next: NextFunction) => {
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
  if (!DASHBOARD_PASSWORD) {
    // If DASHBOARD_PASSWORD is not set in env, allow open access
    return next();
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const redisAvailable = isRedisConfigured();

  if (!redisAvailable) {
    console.warn('[Auth] Distributed lockout unavailable (Redis down), using in-memory fallback');
  }

  // 1. IP Lockout / Cooldown check.
  // With Redis, lockout state is shared across serverless instances; otherwise
  // fall back to the local in-memory Map.
  const memoryAttempt = failedAttempts.get(ip);
  const memoryLocked = !!(memoryAttempt && memoryAttempt.lockUntil > now);
  const redisLocked = redisAvailable ? await isAuthLockedOut(ip) : false;

  if (redisLocked || memoryLocked) {
    const message = memoryLocked
      ? `Too many failed login attempts. Access temporarily locked for your IP address. Please wait ${Math.ceil(
          (memoryAttempt!.lockUntil - now) / 1000
        )} seconds.`
      : 'Too many failed login attempts. Access temporarily locked for your IP address. Please try again later.';
    return res.status(429).json({
      error: message,
      dashboardPasswordRequired: true
    });
  }

  const authHeader = req.headers['authorization'];
  let receivedPassword = '';
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    receivedPassword = authHeader.substring(7).trim();
  } else {
    const headerPass = req.headers['x-dashboard-password'];
    if (headerPass) {
       receivedPassword = (Array.isArray(headerPass) ? headerPass[0] : headerPass).trim();
    }
  }

  let authenticated = false;
  try {
    const receivedHash = crypto.createHash('sha256').update(receivedPassword, 'utf8').digest();
    const actualHash = crypto.createHash('sha256').update(DASHBOARD_PASSWORD, 'utf8').digest();
    authenticated = crypto.timingSafeEqual(receivedHash, actualHash);
  } catch (error) {
    authenticated = false;
  }

  if (authenticated) {
    // Reset failed counter on successful auth (both shared and local caches).
    failedAttempts.delete(ip);
    if (redisAvailable) {
      await resetAuthFailures(ip);
    }
    return next();
  }

  // 2. Auth Failure: Increment IP-based failure count and enforce lockout if
  // more than the allowed number of attempts is exceeded. When Redis is
  // available the count is shared across instances so distributed guessing is
  // caught; the local Map is kept in sync as a fallback.
  const currentAttempt = failedAttempts.get(ip) || { count: 0, lockUntil: 0 };
  currentAttempt.count += 1;

  let failCount = currentAttempt.count;
  if (redisAvailable) {
    const redisCount = await recordAuthFailure(ip);
    // Use the higher of the two so a transient Redis error can't lower the
    // effective count below what this instance has already observed locally.
    failCount = Math.max(redisCount, currentAttempt.count);
  }

  let isLocked = false;
  if (failCount >= MAX_FAILED_ATTEMPTS) {
    // 15-minute cooldown locking window
    currentAttempt.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
    isLocked = true;
    if (redisAvailable) {
      await lockoutAuth(ip, LOCKOUT_DURATION_MS);
    }
    console.warn(`[Security Alert] IP ${ip} has exceeded maximum login attempts and is locked.`);
  }
  failedAttempts.set(ip, currentAttempt);

  // 3. Security Audit Event Logging
  const maskedIpAddress = maskIp(ip);
  try {
    addLog({
      id: `sec-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date().toISOString(),
      eventId: `sec-alert-${Math.random().toString(36).substring(2, 6)}`,
      eventType: 'Security Alert (Auth Failure)',
      channel: 'Dashboard Web Admin Portal',
      user: `Node: ${maskedIpAddress}`,
      text: `SECURITY WARNING: Unauthorized dashboard access attempt with incorrect password. Bad attempt count: ${failCount}.${isLocked ? ' IP address temporarily locked out.' : ''}`,
      status: 'error',
      signatureVerified: false
    });
  } catch (err) {
    console.error('Failed to log security warning event', err);
  }

  // 4. Dynamic Timing Delay to deter active brute force engines
  const penaltyDelayMs = Math.min(3000, 200 * failCount);
  await new Promise((resolve) => setTimeout(resolve, penaltyDelayMs));

  return res.status(401).json({ 
    error: isLocked 
      ? 'Too many unauthorized password attempts. Dashboard login has been locked for 15 minutes.' 
      : 'Invalid dashboard administrative password.',
    dashboardPasswordRequired: true
  });
};

