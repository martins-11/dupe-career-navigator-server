'use strict';

const { getPool } = require('./pool');
const { getMigrationSql } = require('./migrations/001_init.sql');

/**
 * Lightweight migration runner placeholder.
 * Intended use once AWS RDS env credentials are available.
 *
 * It executes the init SQL inside a transaction.
 */

async function main() {
  const pool = getPool();
  const sql = getMigrationSql();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log('Migration applied: 001_init (placeholder)');
  } catch (err) {
    await client.query('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
