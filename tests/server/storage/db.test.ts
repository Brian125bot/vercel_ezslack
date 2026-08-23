import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getAdminDbPool, getDbPool, closeDb, isDbAvailable, query, withTransaction } from '../../../src/server/storage/db.js';

// Mock pg module
vi.mock('pg', () => {
  const PoolMock = vi.fn(() => ({
    on: vi.fn(),
    end: vi.fn(),
  }));
  return { Pool: PoolMock };
});

vi.mock('@google-cloud/cloud-sql-connector', () => {
  return {
    Connector: vi.fn(() => ({
      getOptions: vi.fn().mockResolvedValue({
        host: 'cloud_sql_mock_host',
      }),
      close: vi.fn(),
    })),
  };
});

describe('getAdminDbPool', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await closeDb(); // Ensure adminPool is reset before each test
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('reuses the existing adminPool if called multiple times', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/admin');

    const pool1 = await getAdminDbPool();
    const pool2 = await getAdminDbPool();

    expect(pool1).toBe(pool2);
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it('throws an error if no database configuration is found', async () => {
    await expect(getAdminDbPool()).rejects.toThrow('No database configuration found for admin pool.');
  });

  it('initializes using DATABASE_URL when set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://testuser:testpass@localhost:5432/testdb');
    vi.stubEnv('DB_ADMIN_POOL_MAX', '3');
    vi.stubEnv('DB_CONNECTION_TIMEOUT', '5000');

    await getAdminDbPool();

    expect(Pool).toHaveBeenCalledWith({
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      connectionString: 'postgres://testuser:testpass@localhost:5432/testdb',
    });
  });

  it('initializes using SQL_HOST checking auth variables precedence', async () => {
    vi.stubEnv('SQL_HOST', '/cloudsql/my-project:region:instance');
    vi.stubEnv('SQL_ADMIN_USER', 'admin_user');
    vi.stubEnv('SQL_ADMIN_PASSWORD', 'admin_pass');
    vi.stubEnv('SQL_DB_NAME', 'admin_db');

    await getAdminDbPool();

    expect(Pool).toHaveBeenCalledWith({
      max: 2, // default
      idleTimeoutMillis: 30000, // default
      connectionTimeoutMillis: 10000, // default
      host: '/cloudsql/my-project:region:instance',
      user: 'admin_user',
      password: 'admin_pass',
      database: 'admin_db',
    });
  });

  it('initializes using CLOUD_SQL_CONNECTION_NAME when set', async () => {
    vi.stubEnv('CLOUD_SQL_CONNECTION_NAME', 'my-project:region:instance');
    vi.stubEnv('SQL_ADMIN_USER', 'admin_user');
    vi.stubEnv('SQL_ADMIN_PASSWORD', 'admin_pass');
    vi.stubEnv('DB_NAME', 'admin_db');

    await getAdminDbPool();

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      host: 'cloud_sql_mock_host',
      user: 'admin_user',
      password: 'admin_pass',
      database: 'admin_db',
    }));
  });

  it('handles idle client connection termination events gracefully', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/admin');

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getAdminDbPool();

    // Get the mock instance to manually trigger the 'error' event
    const poolMockInstance = vi.mocked(Pool).mock.results[0].value;

    // Find the error handler registered on the pool
    const errorHandlerCall = poolMockInstance.on.mock.calls.find((call: any) => call[0] === 'error');
    expect(errorHandlerCall).toBeDefined();

    const errorHandler = errorHandlerCall[1];

    // Trigger benign error
    errorHandler(new Error('Connection terminated unexpectedly'));
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Database admin pool detected an idle client connection termination (benign):',
      'Connection terminated unexpectedly'
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();

    // Trigger other unexpected error
    const unexpectedError = new Error('Something went wrong');
    errorHandler(unexpectedError);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Unexpected error on admin idle client',
      unexpectedError
    );
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('getDbPool', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await closeDb(); // Ensure pool is reset before each test
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('reuses the existing pool if called multiple times', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const pool1 = await getDbPool();
    const pool2 = await getDbPool();

    expect(pool1).toBe(pool2);
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it('throws an error if no database configuration is found', async () => {
    await expect(getDbPool()).rejects.toThrow('No database configuration found.');
  });

  it('initializes using DATABASE_URL when set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://testuser:testpass@localhost:5432/testdb');
    vi.stubEnv('DB_POOL_MAX', '3');
    vi.stubEnv('DB_CONNECTION_TIMEOUT', '5000');

    await getDbPool();

    expect(Pool).toHaveBeenCalledWith({
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      connectionString: 'postgres://testuser:testpass@localhost:5432/testdb',
    });
  });

  it('initializes using SQL_HOST checking auth variables precedence', async () => {
    vi.stubEnv('SQL_HOST', '/cloudsql/my-project:region:instance');
    vi.stubEnv('SQL_USER', 'main_user');
    vi.stubEnv('SQL_PASSWORD', 'main_pass');
    vi.stubEnv('SQL_DB_NAME', 'main_db');

    await getDbPool();

    expect(Pool).toHaveBeenCalledWith({
      max: 5, // default
      idleTimeoutMillis: 30000, // default
      connectionTimeoutMillis: 10000, // default
      host: '/cloudsql/my-project:region:instance',
      user: 'main_user',
      password: 'main_pass',
      database: 'main_db',
    });
  });

  it('initializes using CLOUD_SQL_CONNECTION_NAME when set', async () => {
    vi.stubEnv('CLOUD_SQL_CONNECTION_NAME', 'my-project:region:instance');
    vi.stubEnv('DB_USER', 'main_user');
    vi.stubEnv('DB_PASSWORD', 'main_pass');
    vi.stubEnv('DB_NAME', 'main_db');

    await getDbPool();

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      host: 'cloud_sql_mock_host',
      user: 'main_user',
      password: 'main_pass',
      database: 'main_db',
    }));
  });

  it('handles idle client connection termination events gracefully', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await getDbPool();

    // Get the mock instance to manually trigger the 'error' event
    const poolMockInstance = vi.mocked(Pool).mock.results[0].value;

    // Find the error handler registered on the pool
    const errorHandlerCall = poolMockInstance.on.mock.calls.find((call: any) => call[0] === 'error');
    expect(errorHandlerCall).toBeDefined();

    const errorHandler = errorHandlerCall[1];

    // Trigger benign error
    errorHandler(new Error('Connection terminated unexpectedly'));
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Database pool detected an idle client connection termination (benign):',
      'Connection terminated unexpectedly'
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();

    // Trigger other unexpected error
    const unexpectedError = new Error('Something went wrong');
    errorHandler(unexpectedError);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Unexpected error on idle client',
      unexpectedError
    );
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('isDbAvailable', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('returns true if the connection is successful', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    // override the mock to return a connect method that succeeds
    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn().mockResolvedValue({
        release: vi.fn(),
      }),
    })) as any);

    const isAvailable = await isDbAvailable();
    expect(isAvailable).toBe(true);
  });

  it('returns false if the connection fails', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    // override the mock to return a connect method that fails
    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error('Connection failed')),
    })) as any);

    const isAvailable = await isDbAvailable();
    expect(isAvailable).toBe(false);
  });
});

describe('query', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('executes a query successfully', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    })) as any);

    const rows = await query('SELECT * FROM test');
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('retries on transient errors', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const transientError = new Error('Connection terminated');
    (transientError as any).code = '08003';

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      query: vi.fn()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }),
    })) as any);

    const rows = await query('SELECT * FROM test');
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('throws on non-transient errors', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const nonTransientError = new Error('Syntax error');

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      query: vi.fn().mockRejectedValueOnce(nonTransientError),
    })) as any);

    await expect(query('SELECT * FROM test')).rejects.toThrow('Syntax error');
  });

  it('exhausts retries and throws', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const transientError = new Error('Connection terminated');
    (transientError as any).code = '08003';

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      query: vi.fn()
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError),
    })) as any);

    await expect(query('SELECT * FROM test')).rejects.toThrow('Connection terminated');
  });
});

describe('withTransaction', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('commits a successful transaction', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const clientMock = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn().mockResolvedValue(clientMock),
    })) as any);

    const result = await withTransaction(async (client) => {
      return 'success';
    });

    expect(result).toBe('success');
    expect(clientMock.query).toHaveBeenCalledWith('BEGIN');
    expect(clientMock.query).toHaveBeenCalledWith('COMMIT');
    expect(clientMock.release).toHaveBeenCalled();
  });

  it('rolls back a failed transaction', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const clientMock = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn().mockResolvedValue(clientMock),
    })) as any);

    await expect(withTransaction(async (client) => {
      throw new Error('Transaction failed');
    })).rejects.toThrow('Transaction failed');

    expect(clientMock.query).toHaveBeenCalledWith('BEGIN');
    expect(clientMock.query).toHaveBeenCalledWith('ROLLBACK');
    expect(clientMock.release).toHaveBeenCalled();
  });

  it('warns if rollback fails', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/main');

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const clientMock = {
      query: vi.fn().mockImplementation((query) => {
        if (query === 'ROLLBACK') {
          return Promise.reject(new Error('Rollback failed'));
        }
        return Promise.resolve({});
      }),
      release: vi.fn(),
    };

    vi.mocked(Pool).mockImplementationOnce(vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn().mockResolvedValue(clientMock),
    })) as any);

    await expect(withTransaction(async (client) => {
      throw new Error('Transaction failed');
    })).rejects.toThrow('Transaction failed');

    expect(consoleWarnSpy).toHaveBeenCalledWith('Transaction rollback error (primary error preserved):', 'Rollback failed');
    expect(clientMock.release).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});
