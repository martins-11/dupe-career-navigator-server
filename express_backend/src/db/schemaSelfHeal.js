'use strict';

const { dbQuery, isDbConfigured, getDbEngine } = require('./connection');

/**
 * Runtime-safe, best-effort schema self-healing for MySQL.
 *
 * Why this exists:
 * - Production DBs can drift from expected schema (manual edits, partial migrations, etc.).
 * - Our MySQL repo code expects persona_drafts.persona_id to exist.
 * - When missing, /orchestration/run-all can 500 with:
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
 * Best-effort schema fix for persona_drafts:
 * - add persona_id CHAR(36) NOT NULL (with a conservative default)
 * - add index (persona_id, created_at)
 *
 * Note:
 * - Adding NOT NULL to an existing table can fail if rows already exist.
 * - To keep this runtime-safe, we:
 *   1) add the column with NOT NULL DEFAULT '' so existing rows are compatible
 *   2) keep repo queries working for newly inserted rows (they set persona_id explicitly)
 *
 * If you want stricter constraints later, do it via an explicit offline migration.
 */
async function _ensurePersonaDraftsPersonaIdColumnMysql() {
  const hasPersonaId = await _mysqlHasColumn('persona_drafts', 'persona_id');
  if (!hasPersonaId) {
    // Add column. Keep it minimal and safe for existing rows.
    await dbQuery(
      `
      ALTER TABLE persona_drafts
      ADD COLUMN persona_id CHAR(36) NOT NULL DEFAULT ''
      `
    );
  }

  const hasCreatedAt = await _mysqlHasColumn('persona_drafts', 'created_at');
  // Only add the composite index if created_at exists (older drift might have different timestamp column).
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

// PUBLIC_INTERFACE
async function ensureMysqlSchemaCompatible() {
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
    const draftsExists = await (async () => {
      const res = await dbQuery(
        `
        SELECT 1 AS ok
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'persona_drafts'
        LIMIT 1
        `
      );
      return Boolean(res?.rows?.length);
    })();

    if (!draftsExists) {
      // Do not attempt to create tables here; migrate.js is the table-creation mechanism.
      warnings.push('persona_drafts table missing; skipping persona_id self-heal.');
      return { attempted: true, applied, warnings };
    }

    const hadPersonaId = await _mysqlHasColumn('persona_drafts', 'persona_id');
    await _ensurePersonaDraftsPersonaIdColumnMysql();
    if (!hadPersonaId) applied.push('persona_drafts.persona_id');

    return { attempted: true, applied, warnings };
  } catch (err) {
    warnings.push(err?.message || String(err));
    // eslint-disable-next-line no-console
    console.warn('[db:self-heal] ensureMysqlSchemaCompatible warning:', err?.message || err);
    return { attempted: true, applied, warnings };
  }
}

module.exports = {
  ensureMysqlSchemaCompatible
};
