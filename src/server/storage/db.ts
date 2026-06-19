import { Pool, PoolConfig } from 'pg';
import { Connector } from '@google-cloud/cloud-sql-connector';

let pool: Pool | null = null;
let adminPool: Pool | null = null;
let connector: Connector | null = null;

export async function getAdminDbPool(): Promise<Pool> {
  if (adminPool) return adminPool;

  const config: PoolConfig = {
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  if (process.env.SQL_HOST) {
    console.log('Initializing Admin DB connection using SQL_HOST/Unix socket path...');
    adminPool = new Pool({
      ...config,
      host: process.env.SQL_HOST,
      user: process.env.SQL_ADMIN_USER || process.env.SQL_USER || process.env.DB_USER,
      password: process.env.SQL_ADMIN_PASSWORD || process.env.SQL_PASSWORD || process.env.DB_PASSWORD,
      database: process.env.SQL_DB_NAME || process.env.DB_NAME,
    });
  } else if (process.env.CLOUD_SQL_CONNECTION_NAME) {
    console.log('Initializing Admin DB connection using Cloud SQL Connector...');
    connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_CONNECTION_NAME,
    });
    
    adminPool = new Pool({
      ...config,
      ...clientOpts,
      user: process.env.SQL_ADMIN_USER || process.env.DB_USER || process.env.SQL_USER,
      password: process.env.SQL_ADMIN_PASSWORD || process.env.DB_PASSWORD || process.env.SQL_PASSWORD,
      database: process.env.DB_NAME || process.env.SQL_DB_NAME,
    });
  } else if (process.env.DATABASE_URL) {
    console.log('Initializing Admin DB connection using DATABASE_URL...');
    adminPool = new Pool({
      ...config,
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  } else {
    throw new Error('No database configuration found for admin pool.');
  }

  adminPool.on('error', (err) => {
    console.error('Unexpected error on admin idle client', err);
  });

  return adminPool;
}

export async function getDbPool(): Promise<Pool> {
  if (pool) return pool;

  const config: PoolConfig = {
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  if (process.env.SQL_HOST) {
    console.log('Initializing DB connection using SQL_HOST/Unix socket path...');
    pool = new Pool({
      ...config,
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER || process.env.DB_USER,
      password: process.env.SQL_PASSWORD || process.env.DB_PASSWORD,
      database: process.env.SQL_DB_NAME || process.env.DB_NAME,
    });
  } else if (process.env.CLOUD_SQL_CONNECTION_NAME) {
    console.log('Initializing DB connection using Cloud SQL Connector...');
    connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_CONNECTION_NAME,
    });
    
    pool = new Pool({
      ...config,
      ...clientOpts,
      user: process.env.DB_USER || process.env.SQL_USER,
      password: process.env.DB_PASSWORD || process.env.SQL_PASSWORD,
      database: process.env.DB_NAME || process.env.SQL_DB_NAME,
    });
  } else if (process.env.DATABASE_URL) {
    console.log('Initializing DB connection using DATABASE_URL...');
    pool = new Pool({
      ...config,
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  } else {
    throw new Error('No database configuration found. Set DATABASE_URL, CLOUD_SQL_CONNECTION_NAME, or SQL_HOST.');
  }

  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });

  return pool;
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
  if (connector) {
    connector.close();
    connector = null;
  }
}

export async function isDbAvailable(): Promise<boolean> {
  try {
    const p = await getDbPool();
    const client = await p.connect();
    client.release();
    return true;
  } catch (e) {
    return false;
  }
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const p = await getDbPool();
  const res = await p.query(text, params);
  return res.rows;
}

export async function withTransaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
  const p = await getDbPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
