'use strict';

const { Pool: PgPool } = require('pg');
const mysql = require('mysql2/promise');

/**
 * This module provides a lightweight, engine-agnostic DB connection helper.
 *
 * Goals:
 * - Support AWS RDS MySQL as the primary target.
 * - Preserve existing PostgreSQL scaffolding (do NOT remove).
 * - Do NOT require any DB env vars to be present for the service to run
 *   (repositories will default to in-memory when not configured).
 *
 * Configuration:
 * - DB_ENGINE: 'mysql' | 'postgres' (default: 'mysql' for new deployments)
 *
 * MySQL:
 * - MYSQL_CONNECTION_STRING: mysql://user:pass@host:3306/db?ssl=true
 * - or MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * - MYSQL_SSL: 'true'|'false' (optional)
 *
 * Postgres (existing scaffolding):
 * - PG_CONNECTION_STRING or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
 * - PGSSLMODE / PGSSL
 */

let _pgPool = null;
let _mysqlPool = null;

// PUBLIC_INTERFACE
function getDbEngine() {
  /** Returns configured DB engine. Defaults to 'mysql'. */
  const v = String(process.env.DB_ENGINE || 'mysql').toLowerCase().trim();
  if (v === 'postgres' || v === 'postgresql' || v === 'pg') return 'postgres';
  if (v === 'mysql') return 'mysql';
  return 'mysql';
}

// PUBLIC_INTERFACE
function isMysqlConfigured() {
  /** Returns true if MySQL env vars appear to be configured. */
  return Boolean(
    (process.env.MYSQL_CONNECTION_STRING && process.env.MYSQL_CONNECTION_STRING.trim()) ||
      (process.env.MYSQL_HOST && process.env.MYSQL_HOST.trim()) ||
      (process.env.MYSQL_DATABASE && process.env.MYSQL_DATABASE.trim()) ||
      (process.env.MYSQL_USER && process.env.MYSQL_USER.trim()) ||
      (process.env.DB_HOST && process.env.DB_HOST.trim()) ||
      (process.env.DB_NAME && process.env.DB_NAME.trim()) ||
      (process.env.DB_USERNAME && process.env.DB_USERNAME.trim())
  );
}

// PUBLIC_INTERFACE
function isPostgresConfigured() {
  /** Returns true if Postgres env vars appear to be configured. */
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

// PUBLIC_INTERFACE
function isDbConfigured() {
  /** Returns true if the configured engine appears to have env vars set. */
  const engine = getDbEngine();
  return engine === 'mysql' ? isMysqlConfigured() : isPostgresConfigured();
}

function _mysqlSslOptions() {
  const mysqlSsl = String(process.env.MYSQL_SSL || '').toLowerCase().trim();
  if (mysqlSsl === 'true') {
    // For scaffolding, avoid CA enforcement. Production should provide CA and verify.
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function _firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function _mysqlConfigFromEnv() {
  // Support both MYSQL_* (preferred) and DB_* (used by some deployment setups).
  const host = _firstNonEmpty(process.env.MYSQL_HOST, process.env.DB_HOST);
  const portRaw = _firstNonEmpty(process.env.MYSQL_PORT, process.env.DB_PORT);
  const port = portRaw ? Number(portRaw) : undefined;

  const user = _firstNonEmpty(process.env.MYSQL_USER, process.env.DB_USERNAME, process.env.DB_USER);
  const password = _firstNonEmpty(process.env.MYSQL_PASSWORD, process.env.DB_PASSWORD);
  const database = _firstNonEmpty(process.env.MYSQL_DATABASE, process.env.DB_NAME);

  return { host, port, user, password, database };
}

function _ensureMysqlPool() {
  if (_mysqlPool) return _mysqlPool;

  const connectionString = process.env.MYSQL_CONNECTION_STRING;
  if (connectionString && connectionString.trim()) {
    _mysqlPool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: 10,
      ssl: _mysqlSslOptions()
    });
    return _mysqlPool;
  }

  const cfg = _mysqlConfigFromEnv();

  _mysqlPool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: _mysqlSslOptions()
  });

  return _mysqlPool;
}

function _pgSslOptions() {
  const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
  const pgssl = (process.env.PGSSL || '').toLowerCase();

  const sslEnabled =
    sslMode === 'require' || sslMode === 'verify-full' || sslMode === 'verify-ca' || pgssl === 'true';

  return sslEnabled
    ? {
        rejectUnauthorized: false
      }
    : undefined;
}

function _ensurePgPool() {
  if (_pgPool) return _pgPool;

  const connectionString = process.env.PG_CONNECTION_STRING;
  const ssl = _pgSslOptions();

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

  _pgPool = new PgPool(poolConfig);
  return _pgPool;
}

// PUBLIC_INTERFACE
async function dbQuery(sql, params = []) {
  /**
   * Execute a SQL query for the configured engine.
   *
   * Returns a normalized object:
   * - { rows: any[] } for both mysql and postgres.
   *
   * IMPORTANT: Only call this when isDbConfigured() is true, otherwise callers
   * should fallback to in-memory repos.
   */
  const engine = getDbEngine();

  try {
    if (engine === 'mysql') {
      const pool = _ensureMysqlPool();

      // mysql2 note:
      // - pool.execute() is for prepared statements and expects a single statement.
      // - pool.query() is appropriate for raw SQL (incl DDL) and is what we want for migrations.
      const [rows] = await pool.query(sql, params);

      // MySQL returns RowDataPacket[] for SELECT; OkPacket for INSERT/UPDATE/DDL.
      // We normalize to { rows } for SELECT-like queries.
      return { rows: Array.isArray(rows) ? rows : [rows] };
    }

    const pool = _ensurePgPool();
    const res = await pool.query(sql, params);
    return res;
  } catch (err) {
    // Improve common misconfig errors while preserving original error as cause.
    const msg = String((err && err.message) || '');
    const lower = msg.toLowerCase();

    if (lower.includes('access denied') || lower.includes('authentication') || lower.includes('password')) {
      const wrapped = new Error(
        engine === 'mysql'
          ? 'Database authentication failed (check env vars for MySQL/AWS RDS).'
          : 'Database authentication failed (check env vars for PostgreSQL/AWS RDS).'
      );
      wrapped.cause = err;
      throw wrapped;
    }

    throw err;
  }
}

// PUBLIC_INTERFACE
async function dbClose() {
  /** Close the configured engine pool (best-effort). */
  const engine = getDbEngine();
  try {
    if (engine === 'mysql') {
      if (_mysqlPool) await _mysqlPool.end();
      _mysqlPool = null;
      return;
    }
    if (_pgPool) await _pgPool.end();
    _pgPool = null;
  } catch (_) {
    // ignore close errors
  }
}

async function dbExecRaw(sql) {
  /**
   * Execute raw SQL without parameters for the configured engine.
   *
   * This is primarily intended for migration execution where statements are
   * already constructed and split safely.
   */
  return dbQuery(sql);
}

module.exports = {
  getDbEngine,
  isMysqlConfigured,
  isPostgresConfigured,
  isDbConfigured,
  dbQuery,
  dbExecRaw,
  dbClose
};
