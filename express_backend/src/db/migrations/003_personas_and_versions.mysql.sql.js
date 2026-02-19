'use strict';

/**
 * MySQL migration: personas + persona_versions tables
 *
 * Purpose:
 * - Ensure persona storage tables exist for the MySQL repository layer.
 * - Keep tables compatible with current repository expectations:
 *   - personas: id (CHAR(36)), user_id (nullable), title (nullable), created_at/updated_at
 *   - persona_versions: id, persona_id FK -> personas(id), version (int), persona_json (JSON), created_at
 *
 * Notes:
 * - This file only exports SQL strings; execution is handled by src/db/migrate.js.
 * - The migration runner splits SQL on semicolons and runs statements sequentially.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating personas + persona_versions tables in MySQL. */
  return `
-- 003_personas_and_versions (mysql)

CREATE TABLE IF NOT EXISTS personas (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  title TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS persona_versions (
  id CHAR(36) PRIMARY KEY,
  persona_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  persona_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_persona_versions_persona_id_version (persona_id, version),
  INDEX idx_persona_versions_persona_id (persona_id),
  CONSTRAINT fk_persona_versions_persona_id
    FOREIGN KEY (persona_id) REFERENCES personas(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
`;
}

module.exports = { getMigrationSql };

