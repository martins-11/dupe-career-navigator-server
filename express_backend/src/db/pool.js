import { Pool } from 'pg';

/**
 * PostgreSQL connection pool.
 *
 * Env options supported (intentionally optional for now):
 * - PG_CONNECTION_STRING (recommended for AWS RDS): postgresql://user:pass@host:5432/db?sslmode=require
 * - PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 * - PGSSLMODE (e.g., 'require') / PGSSL ('true'/'false')
 *
 * If env vars are not provided, the pool will still be created but connection attempts will fail.
 * This is expected at this scaffolding stage.
 */

let _pool = null;

// PUBLIC_INTERFACE
export function getPool() {
  /** Returns a singleton pg Pool configured from environment variables. */
  if (_pool) return _pool;

  const connectionString = process.env.PG_CONNECTION_STRING;

  const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
  const pgssl = (process.env.PGSSL || '').toLowerCase();

  // For RDS you typically want SSL; however we keep this env-driven and default to false to avoid surprises locally.
  const sslEnabled =
    sslMode === 'require' || sslMode === 'verify-full' || sslMode === 'verify-ca' || pgssl === 'true';

  const ssl = sslEnabled
    ? {
        // For early scaffolding, do not enforce CA verification unless provided.
        // Production should set proper CA / rejectUnauthorized=true.
        rejectUnauthorized: false
      }
    : undefined;

  const poolConfig = connectionString
    ? { connectionString, ssl }
    : {
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        ssl
      };

  _pool = new Pool(poolConfig);
  return _pool;
}

export default { getPool };
