'use strict';

const { getPool } = require('./pool');

/**
 * Small query helper that standardizes errors and keeps callsites concise.
 */

// PUBLIC_INTERFACE
async function query(text, params) {
  /** Execute a SQL query using the configured Pool. */
  const pool = getPool();
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Improve common misconfig errors while preserving original error for logs.
    if (
      String(err && err.message || '').toLowerCase().includes('password') ||
      String(err && err.message || '').toLowerCase().includes('authentication')
    ) {
      const wrapped = new Error('Database authentication failed (check env vars for PostgreSQL/AWS RDS).');
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

module.exports = { query };
