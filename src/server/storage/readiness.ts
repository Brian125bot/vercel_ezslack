import { sanitizeString } from '../agent/sanitize.js';
import { runMigrations } from './migrations.js';
import { DurableStateError } from './errors.js';
import { isDbAvailable } from './db.js';
import { isRedisConfigured, pingRedis } from '../redis.js';

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

export function isDurableStateRequired(): boolean {
  if (process.env.REQUIRE_DURABLE_STATE === 'false' || process.env.REQUIRE_DURABLE_STATE === '0') {
    return false;
  }
  if (process.env.REQUIRE_DURABLE_STATE === 'true' || process.env.REQUIRE_DURABLE_STATE === '1') {
    return true;
  }
  return process.env.NODE_ENV === 'production';
}

export function isRedisRequired(): boolean {
  if (process.env.REQUIRE_REDIS === 'false' || process.env.REQUIRE_REDIS === '0') {
    return false;
  }
  if (process.env.REQUIRE_REDIS === 'true' || process.env.REQUIRE_REDIS === '1') {
    return true;
  }
  return process.env.NODE_ENV === 'production';
}

export interface DurableDependencyOptions {
  database?: boolean;
  redis?: boolean;
  schema?: boolean;
}

/**
 * Shared production durable-dependency readiness gate.
 * Verifies database, schema, and Redis readiness according to configured or
 * default production strictness flags.
 */
export async function requireDurableDependencies(options: DurableDependencyOptions = {}): Promise<void> {
  const checkDb = options.database ?? options.schema ?? isDurableStateRequired();
  const checkRedis = options.redis ?? isRedisRequired();

  if (checkDb) {
    const dbConfigured = !!(process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME || process.env.SQL_HOST);
    if (!dbConfigured) {
      throw new DurableStateError(
        'Database configuration is missing while durable state is required',
        'DATABASE_UNAVAILABLE',
        'database',
        503
      );
    }

    try {
      await ensureSchemaReady();
    } catch {
      throw new DurableStateError(
        'Database schema is not ready',
        'SCHEMA_NOT_READY',
        'schema',
        503
      );
    }

    const liveDb = await isDbAvailable();
    if (!liveDb) {
      throw new DurableStateError(
        'Database is unreachable or unavailable',
        'DATABASE_UNAVAILABLE',
        'database',
        503
      );
    }
  }

  if (checkRedis) {
    if (!isRedisConfigured()) {
      throw new DurableStateError(
        'Redis configuration is missing while distributed state is required',
        'REDIS_UNAVAILABLE',
        'redis',
        503
      );
    }

    const liveRedis = await pingRedis();
    if (!liveRedis) {
      throw new DurableStateError(
        'Redis store is unreachable or unavailable',
        'REDIS_UNAVAILABLE',
        'redis',
        503
      );
    }
  }
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
