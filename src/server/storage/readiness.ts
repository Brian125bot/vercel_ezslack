import { sanitizeString } from '../agent/sanitize.js';
import { runMigrations } from './migrations.js';

export type SchemaReadinessState = 'uninitialized' | 'migrating' | 'ready' | 'failed';

export interface SchemaReadinessSnapshot {
  state: SchemaReadinessState;
  ready: boolean;
  lastFailureAt: string | null;
}

let state: SchemaReadinessState = 'uninitialized';
let inFlightMigration: Promise<void> | null = null;
let lastFailureAt: string | null = null;

function formatMigrationError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown migration failure';

  // Database URLs commonly contain usernames and passwords but are not covered
  // by generic token redaction rules, so replace the entire URL before logging.
  return sanitizeString(message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]');
}

/**
 * Ensures the durable-state schema is ready for application work. Concurrent
 * callers in one warm process share a single migration attempt. Failures are
 * deliberately not cached: the next controlled caller may retry migrations.
 */
export async function ensureSchemaReady(): Promise<void> {
  if (state === 'ready') return;
  if (inFlightMigration) return inFlightMigration;

  state = 'migrating';
  inFlightMigration = runMigrations()
    .then(() => {
      state = 'ready';
      lastFailureAt = null;
      console.log('[Schema Readiness] Database schema is ready.');
    })
    .catch((error: unknown) => {
      state = 'failed';
      lastFailureAt = new Date().toISOString();
      console.error(`[Schema Readiness] Migration attempt failed: ${formatMigrationError(error)}`);
      throw error;
    })
    .finally(() => {
      inFlightMigration = null;
    });

  return inFlightMigration;
}

export function getSchemaReadiness(): SchemaReadinessSnapshot {
  return {
    state,
    ready: state === 'ready',
    lastFailureAt,
  };
}

/**
 * Test-only state reset. Production readiness state lives for the lifetime of
 * the warm process and is intentionally not externally mutable.
 */
export function resetSchemaReadinessForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Schema readiness state can only be reset in tests');
  }

  state = 'uninitialized';
  inFlightMigration = null;
  lastFailureAt = null;
}
