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

  constructor(
    message: string,
    code: DurableErrorCode = 'STORE_UNAVAILABLE',
    dependency: 'database' | 'redis' | 'schema' = 'database',
    status: number = 503
  ) {
    super(message);
    this.name = 'DurableStateError';
    this.code = code;
    this.dependency = dependency;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
