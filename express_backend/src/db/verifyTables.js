import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { getDbEngine, isDbConfigured, dbQuery, dbClose } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ensure environment variables are loaded from express_backend/.env even when
 * the script is executed with a different working directory (common in CI).
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_TABLES = [
  'builds',
  'ai_runs',
  'documents',
  'extracted_text',
  'personas',
  'persona_versions',
  'persona_drafts',
  'persona_final',
  'roles',
];

function _formatList(arr) {
  return arr.map((s) => `'${s}'`).join(', ');
}

/**
 * Fetch table names present for the current database/schema.
 *
 * We prefer information_schema because it is:
 * - non-destructive
 * - stable across MySQL versions
 * - easy to filter by current database via DATABASE()
 */
async function _getExistingTablesMysql(tableNames) {
  const inList = _formatList(tableNames);
  const sql =
    `SELECT table_name AS tableName ` +
    `FROM information_schema.tables ` +
    `WHERE table_schema = DATABASE() AND table_name IN (${inList})`;

  const res = await dbQuery(sql);

  // mysql2 returns uppercase keys by default (e.g. TABLE_NAME), but we alias to tableName.
  const rows = (res && res.rows) || [];
  return rows
    .map((r) =>
      r && (r.tableName || r.TABLENAME || r.TABLE_NAME || r.table_name)
        ? String(r.tableName || r.TABLENAME || r.TABLE_NAME || r.table_name)
        : null
    )
    .filter(Boolean);
}

async function _getExistingTablesPostgres(tableNames) {
  // Preserve engine-agnostic behavior: if DB_ENGINE=postgres, run an equivalent check.
  // In Postgres, "schema" is typically "public" (or current_schema()).
  const sql =
    `SELECT table_name AS "tableName" ` +
    `FROM information_schema.tables ` +
    `WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`;

  const res = await dbQuery(sql, [tableNames]);
  const rows = (res && res.rows) || [];
  return rows.map((r) => String(r.tableName));
}

// PUBLIC_INTERFACE
export async function verifyRequiredTables() {
  /**
   * Verify that required tables exist in the configured database.
   *
   * Output:
   * - Exit code 0 when all required tables exist.
   * - Exit code 1 when DB is not configured or any table is missing.
   */
  const engine = getDbEngine();

  // eslint-disable-next-line no-console
  console.log(`[db:verify] engine=${engine} requiredTables=${REQUIRED_TABLES.join(',')}`);

  if (!isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.error(
      '[db:verify] FAIL: DB is not configured. Set DB_ENGINE and DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD (or MYSQL_* / PG* equivalents) in express_backend/.env'
    );
    process.exitCode = 1;
    return;
  }

  try {
    let existing = [];
    if (engine === 'mysql') {
      existing = await _getExistingTablesMysql(REQUIRED_TABLES);
    } else {
      existing = await _getExistingTablesPostgres(REQUIRED_TABLES);
    }

    const existingSet = new Set(existing.map((t) => t.toLowerCase()));
    const missing = REQUIRED_TABLES.filter((t) => !existingSet.has(t.toLowerCase()));

    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[db:verify] FAIL: Missing tables: ${missing.join(', ')}. ` +
          `Found: ${existing.length ? existing.join(', ') : '(none of required tables)'}`
      );
      process.exitCode = 1;
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[db:verify] PASS: All required tables exist: ${REQUIRED_TABLES.join(', ')}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db:verify] ERROR:', err && err.message ? err.message : err);
    if (err && err.cause && err.cause.message) {
      // eslint-disable-next-line no-console
      console.error('[db:verify] CAUSE:', err.cause.message);
    }
    process.exitCode = 1;
  } finally {
    await dbClose();
  }
}

void verifyRequiredTables();

export default { verifyRequiredTables };
