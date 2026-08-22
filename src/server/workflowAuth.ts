import crypto from 'crypto';

const WORKFLOW_AUTH_SCHEME = 'Bearer ';

function readWorkflowInternalSecret(): string | null {
  const secret = process.env.WORKFLOW_INTERNAL_SECRET?.trim();
  return secret || null;
}

/**
 * Indicates whether this deployment has configured the credential required for
 * trusted calls to the workflow endpoint.
 */
export function isWorkflowInternalSecretConfigured(): boolean {
  return readWorkflowInternalSecret() !== null;
}

/**
 * Creates the authorization header used exclusively for trusted, server-to-server
 * calls to the workflow endpoint. The endpoint itself still rejects requests if
 * the secret is absent, so a missing configuration can never make the endpoint
 * public.
 */
export function getWorkflowInternalAuthHeaders(): Record<string, string> {
  const secret = readWorkflowInternalSecret();
  return secret ? { Authorization: `${WORKFLOW_AUTH_SCHEME}${secret}` } : {};
}

/**
 * Checks the trusted server-to-server credential for the workflow endpoint.
 * Hashing each value gives timingSafeEqual inputs a fixed length and avoids a
 * length-based early return.
 */
export function isWorkflowInternalRequestAuthorized(
  authorization: string | string[] | undefined
): boolean {
  const secret = readWorkflowInternalSecret();
  const received = Array.isArray(authorization) ? authorization[0] : authorization;

  if (!secret || !received || !received.startsWith(WORKFLOW_AUTH_SCHEME)) {
    return false;
  }

  const suppliedSecret = received.slice(WORKFLOW_AUTH_SCHEME.length).trim();
  if (!suppliedSecret) {
    return false;
  }

  const suppliedDigest = crypto.createHash('sha256').update(suppliedSecret, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(secret, 'utf8').digest();

  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}
