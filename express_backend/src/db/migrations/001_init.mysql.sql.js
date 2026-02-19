'use strict';

/**
 * Placeholder "migration" representing a MySQL schema roughly equivalent to the Postgres scaffold.
 *
 * IMPORTANT:
 * - This file intentionally exports SQL strings rather than running automatically.
 * - MySQL JSON type exists in MySQL 5.7+ / 8.0.
 * - UUIDs are stored as CHAR(36) for simplicity in scaffold.
 *
 * When AWS RDS credentials are available, a proper migration runner can be introduced.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for initializing the MySQL database schema (placeholder). */
  return `
-- 001_init (mysql placeholder)

CREATE TABLE IF NOT EXISTS documents (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NULL,
  source TEXT NULL,
  storage_provider TEXT NULL,
  storage_path TEXT NULL,
  file_size_bytes BIGINT NULL,
  sha256 TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS document_extracted_text (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  extractor TEXT NULL,
  extractor_version TEXT NULL,
  language TEXT NULL,
  text_content LONGTEXT NOT NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_document_extracted_text_document_id (document_id),
  CONSTRAINT fk_document_extracted_text_document_id
    FOREIGN KEY (document_id) REFERENCES documents(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personas (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  title TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_versions (
  id CHAR(36) PRIMARY KEY,
  persona_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  persona_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_persona_versions_persona_id_version (persona_id, version),
  CONSTRAINT fk_persona_versions_persona_id
    FOREIGN KEY (persona_id) REFERENCES personas(id)
    ON DELETE CASCADE
);
`;
}

module.exports = { getMigrationSql };
