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

const { getDbEngine, isDbConfigured, dbExecRaw, dbQuery, dbClose } = require('./connection');
const { getMigrationSql: getPgInitSql } = require('./migrations/001_init.sql');
const { getMigrationSql: getMysqlInitSql } = require('./migrations/001_init.mysql.sql');
const {
  getMigrationSql: getMysqlDocumentsExtractedTextSql
} = require('./migrations/002_documents_extracted_text.mysql.sql');
const {
  getMigrationSql: getMysqlPersonasAndVersionsSql
} = require('./migrations/003_personas_and_versions.mysql.sql');
const { getMigrationSql: getMysqlPersonaDraftsSql } = require('./migrations/004_persona_drafts.mysql.sql');

function _splitSqlStatements(sql) {
  /**
   * Splits a SQL migration string into individual statements.
   *
   * This is intentionally simple for our migration style:
   * - Statements are separated by semicolons.
   * - We strip out full-line and inline `-- ...` comments.
   * - We do not attempt to parse semicolons inside quoted strings (not used in our DDL).
   */
  const noLineComments = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      if (idx === -1) return line;
      return line.slice(0, idx);
    })
    .join('\n');

  return noLineComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

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

  try {
    if (engine === 'mysql') {
      // Apply MySQL migrations in order. Keep them as separate payloads because
      // mysql2 rejects multi-statements unless explicitly enabled.
      const migrations = [
        { name: '001_init', sql: getMysqlInitSql() },
        { name: '002_documents_extracted_text', sql: getMysqlDocumentsExtractedTextSql() },
        { name: '003_personas_and_versions', sql: getMysqlPersonasAndVersionsSql() },
        { name: '004_persona_drafts', sql: getMysqlPersonaDraftsSql() }
      ];

      for (const m of migrations) {
        const statements = _splitSqlStatements(m.sql);
        for (const stmt of statements) {
          await dbExecRaw(stmt);
        }
        // eslint-disable-next-line no-console
        console.log(`[db:migrate] Migration applied: ${m.name} (${engine})`);
      }
    } else {
      // Postgres driver can execute our init SQL as a single payload.
      const sql = getPgInitSql();
      await dbQuery(sql);

      // eslint-disable-next-line no-console
      console.log(`[db:migrate] Migration applied: 001_init (${engine})`);
    }
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
