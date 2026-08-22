import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/server/storage/migrations.js';
import {
  ensureSchemaReady,
  getSchemaReadiness,
  resetSchemaReadinessForTests,
} from '../src/server/storage/readiness.js';

vi.mock('../src/server/storage/migrations.js', () => ({
  runMigrations: vi.fn(),
}));

describe('schema readiness gate', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    resetSchemaReadinessForTests();
    vi.mocked(runMigrations).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetSchemaReadinessForTests();
  });

  it('shares one migration attempt among concurrent callers', async () => {
    let finishMigration!: () => void;
    vi.mocked(runMigrations).mockImplementationOnce(() => new Promise<void>(resolve => {
      finishMigration = resolve;
    }));

    const first = ensureSchemaReady();
    const second = ensureSchemaReady();
    const third = ensureSchemaReady();

    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(getSchemaReadiness()).toEqual({
      state: 'migrating',
      ready: false,
      lastFailureAt: null,
    });

    finishMigration();
    await Promise.all([first, second, third]);

    expect(getSchemaReadiness()).toEqual({
      state: 'ready',
      ready: true,
      lastFailureAt: null,
    });
    await ensureSchemaReady();
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });

  it('records a failure without poisoning a later retry', async () => {
    vi.mocked(runMigrations)
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(undefined);

    await expect(ensureSchemaReady()).rejects.toThrow('connection refused');
    expect(getSchemaReadiness()).toMatchObject({ state: 'failed', ready: false });
    expect(getSchemaReadiness().lastFailureAt).toEqual(expect.any(String));

    await ensureSchemaReady();

    expect(runMigrations).toHaveBeenCalledTimes(2);
    expect(getSchemaReadiness()).toEqual({
      state: 'ready',
      ready: true,
      lastFailureAt: null,
    });
  });

  it('redacts database URLs from migration failure logs', async () => {
    vi.mocked(runMigrations).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED postgres://database-user:database-password@db.example.com:5432/agent')
    );

    await expect(ensureSchemaReady()).rejects.toThrow('connect ECONNREFUSED');

    const loggedMessage = errorSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain('[REDACTED_DATABASE_URL]');
    expect(loggedMessage).not.toContain('database-user');
    expect(loggedMessage).not.toContain('database-password');
  });
});
