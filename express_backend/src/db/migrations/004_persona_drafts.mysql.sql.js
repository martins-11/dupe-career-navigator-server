

/**
 * MySQL migration: persona_drafts table
 *
 * Required by integration test and orchestration:
 * - Persist a generated persona draft JSON into `persona_drafts`
 * - Store alignment_score alongside the draft
 * - Support persona-scoped draft retrieval for /orchestration and persona workflows
 *
 * Important:
 * - CREATE TABLE IF NOT EXISTS will NOT add missing columns to an existing table.
 * - This migration therefore includes a safe, idempotent "ALTER-if-missing" block
 *   using information_schema + prepared statements.
 */

// PUBLIC_INTERFACE
export function getMigrationSql() {
  /** Returns SQL statements for creating persona_drafts table in MySQL (plus idempotent alterations). */
  return `
-- 004_persona_drafts (mysql)

CREATE TABLE IF NOT EXISTS persona_drafts (
  id CHAR(36) PRIMARY KEY,
  persona_id CHAR(36) NOT NULL,
  persona_draft_json JSON NOT NULL,
  alignment_score DOUBLE NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_persona_drafts_persona_id_created_at (persona_id, created_at),
  INDEX idx_persona_drafts_created_at (created_at)
) ENGINE=InnoDB;

-- Idempotent: ensure persona_id exists (for drifted DBs where table was created without persona_id)
SET @cn_pd := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'persona_drafts'
    AND column_name = 'persona_id'
);
SET @sql_pd := IF(@cn_pd = 0,
  'ALTER TABLE persona_drafts ADD COLUMN persona_id CHAR(36) NOT NULL DEFAULT \\'\\'',
  'SELECT 1'
);
PREPARE stmt_pd FROM @sql_pd;
EXECUTE stmt_pd;
DEALLOCATE PREPARE stmt_pd;

-- Idempotent: ensure composite index exists (for persona-scoped latest draft lookup)
SET @ix_pd := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'persona_drafts'
    AND index_name = 'idx_persona_drafts_persona_id_created_at'
);
SET @sql_ix_pd := IF(@ix_pd = 0,
  'ALTER TABLE persona_drafts ADD INDEX idx_persona_drafts_persona_id_created_at (persona_id, created_at)',
  'SELECT 1'
);
PREPARE stmt_ix_pd FROM @sql_ix_pd;
EXECUTE stmt_ix_pd;
DEALLOCATE PREPARE stmt_ix_pd;
`;
}

export default { getMigrationSql };

