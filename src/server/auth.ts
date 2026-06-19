import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { addLog } from './state.js';

interface AuthAttempt {
  count: number;
  lockUntil: number;
}

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
  const attempt = failedAttempts.get(ip);

  // 1. IP Lockout / Cooldown check
  if (attempt && attempt.lockUntil > now) {
    const remainingSeconds = Math.ceil((attempt.lockUntil - now) / 1000);
    return res.status(429).json({
      error: `Too many failed login attempts. Access temporarily locked for your IP address. Please wait ${remainingSeconds} seconds.`,
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
    // Reset failed counter on successful auth
    failedAttempts.delete(ip);
    return next();
  }

  // 2. Auth Failure: Increment IP-based failure count and enforce lockout if exceeded 5 attempts
  const currentAttempt = failedAttempts.get(ip) || { count: 0, lockUntil: 0 };
  currentAttempt.count += 1;
  
  let isLocked = false;
  if (currentAttempt.count >= 5) {
    // 15-minute cooldown locking window
    currentAttempt.lockUntil = Date.now() + 15 * 60 * 1000;
    isLocked = true;
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
      text: `SECURITY WARNING: Unauthorized dashboard access attempt with incorrect password. Bad attempt count: ${currentAttempt.count}.${isLocked ? ' IP address temporarily locked out.' : ''}`,
      status: 'error',
      signatureVerified: false
    });
  } catch (err) {
    console.error('Failed to log security warning event', err);
  }

  // 4. Dynamic Timing Delay to deter active brute force engines
  const penaltyDelayMs = Math.min(3000, 200 * currentAttempt.count);
  await new Promise((resolve) => setTimeout(resolve, penaltyDelayMs));

  return res.status(401).json({ 
    error: isLocked 
      ? 'Too many unauthorized password attempts. Dashboard login has been locked for 15 minutes.' 
      : 'Invalid dashboard administrative password.',
    dashboardPasswordRequired: true
  });
};

