import { getAdminDbPool } from './db.js';
import { migrations } from './schema.js';

export async function runMigrations() {
  console.log('Running database migrations with Admin Pool...');
  const pool = await getAdminDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        migrated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const res = await client.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(res.rows.map((m: any) => m.version));

    for (const migration of migrations) {
      if (!appliedSet.has(migration.version)) {
        console.log(`Applying migration ${migration.version}: ${migration.name}`);
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
      }
    }

    const appUser = process.env.SQL_USER;
    if (appUser && appUser !== process.env.SQL_ADMIN_USER) {
      console.log(`Granting privileges on all tables & sequences to ${appUser}...`);
      await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${appUser}"`);
      await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${appUser}"`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO "${appUser}"`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO "${appUser}"`);
    }

    await client.query('COMMIT');
    console.log('Database migrations completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in runMigrations transaction:', error);
    throw error;
  } finally {
    client.release();
  }
}
