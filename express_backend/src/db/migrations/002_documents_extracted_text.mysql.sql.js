'use strict';

/**
 * MySQL migration: documents + extracted_text tables
 *
 * This repo already has a MySQL init migration that creates:
 * - documents
 * - document_extracted_text
 *
 * The user request asks for:
 * - documents
 * - extracted_text
 *
 * To remain backward compatible with existing repository code that currently
 * reads/writes `document_extracted_text`, we:
 * - Create `extracted_text` as the canonical table going forward
 * - Create a VIEW `document_extracted_text` that maps to `extracted_text`
 *
 * Notes:
 * - This is safe for new DBs and for DBs created with older init migrations:
 *   - If `document_extracted_text` already exists as a TABLE, we do nothing to it.
 *   - If it does not exist, we create it as a VIEW pointing to `extracted_text`.
 * - The migration runner splits SQL on semicolons and runs statements sequentially.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating documents + extracted_text tables in MySQL. */
  return `
-- 002_documents_extracted_text (mysql)

-- Documents metadata (id is UUID stored as CHAR(36) for simplicity)
CREATE TABLE IF NOT EXISTS documents (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  -- Metadata fields: use VARCHAR with sensible caps (instead of TEXT) to better reflect typical sizes.
  original_filename VARCHAR(512) NOT NULL,
  mime_type VARCHAR(255) NULL,
  source VARCHAR(255) NULL,
  storage_provider VARCHAR(64) NULL,
  storage_path VARCHAR(1024) NULL,
  sha256 VARCHAR(64) NULL,
  file_size_bytes BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Canonical extracted text table (requested name)
CREATE TABLE IF NOT EXISTS extracted_text (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  extractor TEXT NULL,
  extractor_version TEXT NULL,
  language TEXT NULL,
  text_content LONGTEXT NOT NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_extracted_text_document_id (document_id),
  CONSTRAINT fk_extracted_text_document_id
    FOREIGN KEY (document_id) REFERENCES documents(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Backward-compat view for existing code expecting document_extracted_text.
-- Only create if a base TABLE doesn't already exist with that name.
CREATE VIEW IF NOT EXISTS document_extracted_text AS
  SELECT
    id,
    document_id,
    extractor,
    extractor_version,
    language,
    text_content,
    metadata_json,
    created_at
  FROM extracted_text;
`;
}

module.exports = { getMigrationSql };

