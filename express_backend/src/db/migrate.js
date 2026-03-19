import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { getDbEngine, isDbConfigured, dbExecRaw, dbQuery, dbClose } from './connection.js';

import { getMigrationSql as getPgInitSql } from './migrations/001_init.sql.js';
import { getMigrationSql as getMysqlInitSql } from './migrations/001_init.mysql.sql.js';
import { getMigrationSql as getMysqlDocumentsExtractedTextSql } from './migrations/002_documents_extracted_text.mysql.sql.js';
import { getMigrationSql as getMysqlPersonasAndVersionsSql } from './migrations/003_personas_and_versions.mysql.sql.js';
import { getMigrationSql as getMysqlPersonaDraftsSql } from './migrations/004_persona_drafts.mysql.sql.js';
import { getMigrationSql as getMysqlPersonaFinalSql } from './migrations/005_persona_final.mysql.sql.js';
import { getMigrationSql as getMysqlHolisticPersonaApiSql } from './migrations/006_holistic_persona_api.mysql.sql.js';
import { getMigrationSql as getMysqlRolesCatalogSql } from './migrations/007_roles_catalog.mysql.sql.js';
import { getMigrationSql as getMysqlUserTargetsSql } from './migrations/008_user_targets.mysql.sql.js';
import { getMigrationSql as getMysqlMindmapViewStateSql } from './migrations/009_mindmap_view_state.mysql.sql.js';
import { getMigrationSql as getMysqlMultiverseBookmarksSql } from './migrations/010_multiverse_bookmarks.mysql.sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function _splitSqlStatements(sql) {
  /**
   * Splits a SQL migration string into individual statements.
   *
   * This is intentionally simple for our migration style:
   * - Statements are separated by semicolons.
   * - We strip out full-line and inline `-- ...` comments.
   * - We do not attempt to parse semicolons inside quoted strings (not used in our DDL).
   */
  const noLineComments = String(sql || '')
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
export async function runMigrations() {
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
        { name: '004_persona_drafts', sql: getMysqlPersonaDraftsSql() },
        { name: '005_persona_final', sql: getMysqlPersonaFinalSql() },
        { name: '006_holistic_persona_api', sql: getMysqlHolisticPersonaApiSql() },
        { name: '007_roles_catalog', sql: getMysqlRolesCatalogSql() },
        { name: '008_user_targets', sql: getMysqlUserTargetsSql() },
        { name: '009_mindmap_view_state', sql: getMysqlMindmapViewStateSql() },
        { name: '010_multiverse_bookmarks', sql: getMysqlMultiverseBookmarksSql() }
      ];

      for (const m of migrations) {
        const statements = _splitSqlStatements(m.sql);
        for (const stmt of statements) {
          // eslint-disable-next-line no-await-in-loop
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

void runMigrations();

export default { runMigrations };
