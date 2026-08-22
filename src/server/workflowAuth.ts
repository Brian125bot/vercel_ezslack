import crypto from 'crypto';

/**
 * Fallback internal secret used ONLY in local development or test environments
 * when WORKFLOW_INTERNAL_SECRET is not explicitly configured.
 * NEVER enabled when NODE_ENV === 'production' or VERCEL === '1'.
 */
export const DEV_TEST_WORKFLOW_INTERNAL_SECRET = 'test-workflow-internal-secret-fallback';

export interface WorkflowAuthResult {
  valid: boolean;
  status: number;
  error?: string;
}

/**
 * Validates internal request authentication for workflow execution endpoints.
 *
 * Accepts credentials strictly via `Authorization: Bearer <secret>`.
 * Uses SHA-256 digest comparison with `crypto.timingSafeEqual` to safely handle
 * variable input lengths in constant time.
 *
 * Never logs secret values.
 */
export function verifyWorkflowInternalSecret(req: { headers: Record<string, any> }): WorkflowAuthResult {
  const isProduction = process.env.NODE_ENV === 'production';
  const isVercel = process.env.VERCEL === '1';

  let expectedSecret = process.env.WORKFLOW_INTERNAL_SECRET?.trim();

  // In local development or test mode, allow a test fallback if WORKFLOW_INTERNAL_SECRET is unset.
  if (!expectedSecret) {
    if (!isProduction && !isVercel) {
      expectedSecret = DEV_TEST_WORKFLOW_INTERNAL_SECRET;
    } else {
      return {
        valid: false,
        status: 401,
        error: 'WORKFLOW_INTERNAL_SECRET is not configured on server'
      };
    }
  }

  const rawAuthHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!rawAuthHeader || typeof rawAuthHeader !== 'string') {
    return {
      valid: false,
      status: 401,
      error: 'Missing Authorization header'
    };
  }

  const authHeader = rawAuthHeader.trim();
  if (!authHeader.startsWith('Bearer ')) {
    return {
      valid: false,
      status: 401,
      error: 'Malformed Authorization header. Must use Bearer token format'
    };
  }

  const providedSecret = authHeader.substring(7).trim();
  if (!providedSecret) {
    return {
      valid: false,
      status: 401,
      error: 'Empty Bearer token credential'
    };
  }

  try {
    const providedHash = crypto.createHash('sha256').update(providedSecret, 'utf8').digest();
    const expectedHash = crypto.createHash('sha256').update(expectedSecret, 'utf8').digest();

    if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
      return {
        valid: false,
        status: 403,
        error: 'Invalid workflow internal credential'
      };
    }
  } catch {
    return {
      valid: false,
      status: 403,
      error: 'Credential verification error'
    };
  }

  return { valid: true, status: 200 };
}

/**
 * Returns the active internal workflow secret to be attached by legitimate internal callers.
 * Uses fallback secret only in local dev/test when WORKFLOW_INTERNAL_SECRET is unset.
 */
export function getWorkflowInternalSecret(): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const isVercel = process.env.VERCEL === '1';
  const configured = process.env.WORKFLOW_INTERNAL_SECRET?.trim();
  if (configured) return configured;
  if (!isProduction && !isVercel) return DEV_TEST_WORKFLOW_INTERNAL_SECRET;
  return '';
}
