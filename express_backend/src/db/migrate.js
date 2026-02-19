'use strict';

const path = require('path');
const dotenv = require('dotenv');

/**
 * Migration runner (lightweight scaffold).
 *
 * Goals:
 * - Execute the initial schema migration for the configured DB engine.
 * - Do NOT break DB-optional mode: if DB isn't configured, exit 0 with a message.
 * - Keep the implementation dependency-light (no external migration framework).
 *
 * Usage:
 * - node src/db/migrate.js
 *
 * Env:
 * - DB_ENGINE: 'mysql' | 'postgres' (default: mysql)
 * - For DB configuration vars, see src/db/connection.js
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { getDbEngine, isDbConfigured, dbQuery, dbClose } = require('./connection');
const { getMigrationSql: getPgInitSql } = require('./migrations/001_init.sql');
const { getMigrationSql: getMysqlInitSql } = require('./migrations/001_init.mysql.sql');

// PUBLIC_INTERFACE
async function runMigrations() {
  /**
   * Runs the initial migration for the configured DB engine.
   *
   * If DB is not configured, this function returns without error to preserve
   * "DB-optional mode" (service can run using memory repositories).
   */
  const engine = getDbEngine();

  if (!isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.log(
      `[db:migrate] Skipping migrations: DB is not configured (engine=${engine}). ` +
        'Configure DB_* / MYSQL_* / PG* env vars to enable.'
    );
    return;
  }

  const sql = engine === 'mysql' ? getMysqlInitSql() : getPgInitSql();

  try {
    // NOTE: For this scaffold, we apply the exported SQL as a single statement.
    // MySQL driver supports multi-statement only when enabled; our init SQL is
    // written to be safe as a single multi-line command for mysql2.
    //
    // If this becomes an issue, we can split statements and execute sequentially.
    await dbQuery(sql);

    // eslint-disable-next-line no-console
    console.log(`[db:migrate] Migration applied: 001_init (${engine})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db:migrate] Migration failed:', err && err.message ? err.message : err);
    if (err && err.cause && err.cause.message) {
      // eslint-disable-next-line no-console
      console.error('[db:migrate] CAUSE:', err.cause.message);
    }
    process.exitCode = 1;
  } finally {
    await dbClose();
  }
}

runMigrations();

module.exports = { runMigrations };
