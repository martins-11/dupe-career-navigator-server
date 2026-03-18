import { dbQuery, isDbConfigured, getDbEngine } from './connection.js';

/**
 * Runtime-safe, best-effort schema self-healing for MySQL.
 *
 * Why this exists:
 * - Production DBs can drift from expected schema (manual edits, partial migrations, etc.).
 * - Our MySQL repo code expects persona-scoped persistence:
 *     - persona_drafts.persona_id
 *     - persona_final.persona_id
 * - When missing, /orchestration/run-all and /api/recommendations/initial can 500 with:
 *     "Unknown column 'persona_id' in 'where clause'"
 *
 * Design:
 * - Non-destructive checks via information_schema.
 * - Best-effort ALTER TABLE when safe.
 * - Never throws in a way that prevents the server from starting (DB-optional mode).
 */

/**
 * Query information_schema to check for a column.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @returns {Promise<boolean>}
 */
async function _mysqlHasColumn(tableName, columnName) {
  const res = await dbQuery(
    `
    SELECT 1 AS ok
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND column_name = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );
  return Boolean(res?.rows?.length);
}

/**
 * Query information_schema to check for an index by name.
 *
 * @param {string} tableName
 * @param {string} indexName
 * @returns {Promise<boolean>}
 */
async function _mysqlHasIndex(tableName, indexName) {
  const res = await dbQuery(
    `
    SELECT 1 AS ok
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND index_name = ?
    LIMIT 1
    `,
    [tableName, indexName]
  );
  return Boolean(res?.rows?.length);
}

/**
 * Query information_schema to check for a table.
 *
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
async function _mysqlHasTable(tableName) {
  const res = await dbQuery(
    `
    SELECT 1 AS ok
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = ?
    LIMIT 1
    `,
    [tableName]
  );
  return Boolean(res?.rows?.length);
}

/**
 * Best-effort schema fix for persona_drafts:
 * - add persona_id CHAR(36) NOT NULL (with a conservative default)
 * - add index (persona_id, created_at)
 *
 * Note:
 * - Adding NOT NULL to an existing table can fail if rows already exist.
 * - To keep this runtime-safe, we add the column with NOT NULL DEFAULT '' so
 *   existing rows are compatible. Repo writes set persona_id explicitly.
 *
 * If you want stricter constraints later, do it via an explicit offline migration.
 */
async function _ensurePersonaDraftsPersonaIdColumnMysql() {
  const hasPersonaId = await _mysqlHasColumn('persona_drafts', 'persona_id');
  if (!hasPersonaId) {
    await dbQuery(
      `
      ALTER TABLE persona_drafts
      ADD COLUMN persona_id CHAR(36) NOT NULL DEFAULT ''
      `
    );
  }

  const hasCreatedAt = await _mysqlHasColumn('persona_drafts', 'created_at');
  if (hasCreatedAt) {
    const idxName = 'idx_persona_drafts_persona_id_created_at';
    const hasIdx = await _mysqlHasIndex('persona_drafts', idxName);
    if (!hasIdx) {
      await dbQuery(
        `
        ALTER TABLE persona_drafts
        ADD INDEX idx_persona_drafts_persona_id_created_at (persona_id, created_at)
        `
      );
    }
  }
}

/**
 * Best-effort schema fix for persona_final:
 * - add persona_id CHAR(36) NOT NULL (with a conservative default)
 * - add index (persona_id, created_at)
 */
async function _ensurePersonaFinalPersonaIdColumnMysql() {
  const hasPersonaId = await _mysqlHasColumn('persona_final', 'persona_id');
  if (!hasPersonaId) {
    await dbQuery(
      `
      ALTER TABLE persona_final
      ADD COLUMN persona_id CHAR(36) NOT NULL DEFAULT ''
      `
    );
  }

  const hasCreatedAt = await _mysqlHasColumn('persona_final', 'created_at');
  if (hasCreatedAt) {
    const idxName = 'idx_persona_final_persona_id_created_at';
    const hasIdx = await _mysqlHasIndex('persona_final', idxName);
    if (!hasIdx) {
      await dbQuery(
        `
        ALTER TABLE persona_final
        ADD INDEX idx_persona_final_persona_id_created_at (persona_id, created_at)
        `
      );
    }
  }
}

// PUBLIC_INTERFACE
export async function ensureMysqlSchemaCompatible() {
  /**
   * Ensure the MySQL schema is compatible with the repository expectations.
   *
   * Runtime-safe behavior:
   * - If DB is not configured, this is a no-op.
   * - If DB_ENGINE != mysql, this is a no-op.
   * - If checks/ALTER fail (permissions, missing tables, etc.), it logs and returns.
   *
   * @returns {Promise<{attempted: boolean, applied: string[], warnings: string[]}>}
   */
  const engine = getDbEngine();
  if (engine !== 'mysql') return { attempted: false, applied: [], warnings: [] };
  if (!isDbConfigured()) return { attempted: false, applied: [], warnings: [] };

  const applied = [];
  const warnings = [];

  try {
    const draftsExists = await _mysqlHasTable('persona_drafts');
    if (draftsExists) {
      const hadPersonaId = await _mysqlHasColumn('persona_drafts', 'persona_id');
      await _ensurePersonaDraftsPersonaIdColumnMysql();
      if (!hadPersonaId) applied.push('persona_drafts.persona_id');
    } else {
      warnings.push('persona_drafts table missing; skipping persona_id self-heal.');
    }

    const finalExists = await _mysqlHasTable('persona_final');
    if (finalExists) {
      const hadPersonaId = await _mysqlHasColumn('persona_final', 'persona_id');
      await _ensurePersonaFinalPersonaIdColumnMysql();
      if (!hadPersonaId) applied.push('persona_final.persona_id');
    } else {
      warnings.push('persona_final table missing; skipping persona_id self-heal.');
    }

    return { attempted: true, applied, warnings };
  } catch (err) {
    warnings.push(err?.message || String(err));
    // eslint-disable-next-line no-console
    console.warn('[db:self-heal] ensureMysqlSchemaCompatible warning:', err?.message || err);
    return { attempted: true, applied, warnings };
  }
}

// Kept for convenience/compat with any default-import usage.
export default {
  ensureMysqlSchemaCompatible
};
