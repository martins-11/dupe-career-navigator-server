'use strict';

/**
 * MySQL migration: persona_drafts table
 *
 * Required by integration test and orchestration:
 * - Persist a generated persona draft JSON into `persona_drafts`
 * - Store alignment_score alongside the draft
 * - Support persona-scoped draft retrieval for /orchestration and persona workflows
 *
 * Notes:
 * - UUID stored as CHAR(36) for consistency with other scaffold tables.
 * - persona_id stored as CHAR(36) and is required for persona-scoped queries.
 * - persona_draft_json stored as JSON.
 * - alignment_score stored as DOUBLE.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating persona_drafts table in MySQL. */
  return `
-- 004_persona_drafts (mysql)

CREATE TABLE IF NOT EXISTS persona_drafts (
  id CHAR(36) PRIMARY KEY,

  -- Links drafts to the owning persona. This must exist because the MySQL repo
  -- (src/repositories/mysql/personasRepo.mysql.js) uses persona_id in INSERTs
  -- and WHERE clauses for strict persona-scoped draft retrieval.
  persona_id CHAR(36) NOT NULL,

  persona_draft_json JSON NOT NULL,
  alignment_score DOUBLE NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_persona_drafts_persona_id_created_at (persona_id, created_at),
  INDEX idx_persona_drafts_created_at (created_at)
) ENGINE=InnoDB;
`;
}

module.exports = { getMigrationSql };

