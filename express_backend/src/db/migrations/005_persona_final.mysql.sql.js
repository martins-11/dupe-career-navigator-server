'use strict';

/**
 * MySQL migration: persona_final table
 *
 * Requirement:
 * - Create persona_final table that mirrors schema of persona_drafts.
 *
 * Notes:
 * - UUID stored as CHAR(36)
 * - final persona JSON stored as JSON
 * - alignment_score stored as DOUBLE (mirrors persona_drafts for parity)
 */

 // PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating persona_final table in MySQL. */
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
`;
}

module.exports = { getMigrationSql };
