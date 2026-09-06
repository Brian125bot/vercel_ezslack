export type DurableErrorCode =
  | 'STORE_UNAVAILABLE'
  | 'STORE_TIMEOUT'
  | 'STORE_WRITE_FAILED'
  | 'STORE_READ_FAILED'
  | 'SCHEMA_NOT_READY'
  | 'DATABASE_UNAVAILABLE'
  | 'REDIS_UNAVAILABLE';

export class DurableStateError extends Error {
  public readonly code: DurableErrorCode;
  public readonly dependency: 'database' | 'redis' | 'schema';
  public readonly status: number;
  public readonly operation?: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    codeOrOperation: string = 'STORE_UNAVAILABLE',
    dependencyOrCause?: unknown,
    status: number = 503
  ) {
    super(message);
    this.name = 'DurableStateError';
    const KNOWN_CODES = new Set<string>([
      'STORE_UNAVAILABLE',
      'STORE_TIMEOUT',
      'STORE_WRITE_FAILED',
      'STORE_READ_FAILED',
      'SCHEMA_NOT_READY',
      'DATABASE_UNAVAILABLE',
      'REDIS_UNAVAILABLE',
    ]);
    const KNOWN_DEPS = new Set<string>(['database', 'redis', 'schema']);
    const isCode = KNOWN_CODES.has(codeOrOperation);
    const isDep = typeof dependencyOrCause === 'string' && KNOWN_DEPS.has(dependencyOrCause as string);
    if (isCode && isDep) {
      this.code = codeOrOperation as DurableErrorCode;
      this.dependency = dependencyOrCause as 'database' | 'redis' | 'schema';
      this.status = status;
      this.operation = undefined;
      this.cause = undefined;
    } else if (isCode) {
      this.code = codeOrOperation as DurableErrorCode;
      this.dependency = 'database';
      this.status = typeof dependencyOrCause === 'number' ? (dependencyOrCause as number) : status;
      this.operation = undefined;
      this.cause = undefined;
    } else {
      // Mission spec: (message, operation, cause?)
      this.code = 'STORE_UNAVAILABLE';
      this.dependency = 'database';
      this.status = 503;
      this.operation = codeOrOperation;
      this.cause = dependencyOrCause;
      if (typeof status === 'number' && status !== 503 && dependencyOrCause === undefined) {
        // status override not used in this path
      }
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
