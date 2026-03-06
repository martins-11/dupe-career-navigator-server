'use strict';

/**
 * MySQL migration: persona_final table
 *
 * Requirement:
 * - Create persona_final table that mirrors schema of persona_drafts.
 *
 * Important:
 * - CREATE TABLE IF NOT EXISTS will NOT add missing columns to an existing table.
 * - This migration therefore includes safe, idempotent "ALTER-if-missing" blocks
 *   using information_schema + prepared statements.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating persona_final table in MySQL (plus idempotent alterations). */
  return `
-- 005_persona_final (mysql)

CREATE TABLE IF NOT EXISTS persona_final (
  id CHAR(36) PRIMARY KEY,
  persona_id CHAR(36) NOT NULL,
  persona_final_json JSON NOT NULL,
  alignment_score DOUBLE NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_persona_final_persona_id_created_at (persona_id, created_at)
) ENGINE=InnoDB;

-- Idempotent: ensure persona_id exists (for drifted DBs where table was created without persona_id)
SET @cn_pf := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'persona_final'
    AND column_name = 'persona_id'
);
SET @sql_pf := IF(@cn_pf = 0,
  'ALTER TABLE persona_final ADD COLUMN persona_id CHAR(36) NOT NULL DEFAULT \\'\\'',
  'SELECT 1'
);
PREPARE stmt_pf FROM @sql_pf;
EXECUTE stmt_pf;
DEALLOCATE PREPARE stmt_pf;

-- Idempotent: ensure composite index exists (for persona-scoped latest final lookup)
SET @ix_pf := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'persona_final'
    AND index_name = 'idx_persona_final_persona_id_created_at'
);
SET @sql_ix_pf := IF(@ix_pf = 0,
  'ALTER TABLE persona_final ADD INDEX idx_persona_final_persona_id_created_at (persona_id, created_at)',
  'SELECT 1'
);
PREPARE stmt_ix_pf FROM @sql_ix_pf;
EXECUTE stmt_ix_pf;
DEALLOCATE PREPARE stmt_ix_pf;
`;
}

module.exports = { getMigrationSql };

