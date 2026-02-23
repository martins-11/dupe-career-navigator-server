'use strict';

/**
 * MySQL migration: documents + extracted_text tables
 *
 * This repo already has a MySQL init migration that creates:
 * - documents
 * - document_extracted_text (historically as a TABLE in some installations)
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
 * IMPORTANT:
 * - We MUST NOT clobber an existing TABLE named `document_extracted_text`.
 * - MySQL does NOT support: CREATE VIEW IF NOT EXISTS ...
 * - The migration runner splits SQL on semicolons and executes sequentially.
 *
 * Therefore we:
 * - Only drop/recreate the VIEW if (and only if) there is NOT a TABLE with that name.
 * - Use INFORMATION_SCHEMA + prepared statements to conditionally execute DDL.
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

  -- Additive: category used to auto-select latest docs for orchestration
  -- Canonical values: resume | job_description | performance_review
  category VARCHAR(64) NULL,

  source VARCHAR(255) NULL,
  storage_provider VARCHAR(64) NULL,
  storage_path VARCHAR(1024) NULL,
  sha256 VARCHAR(64) NULL,
  file_size_bytes BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Backfill: if the documents table already existed from a prior migration/run, ensure category exists.
-- We cannot rely on ADD COLUMN IF NOT EXISTS because it is not supported on all MySQL versions.
-- Instead, use information_schema.columns + prepared statement to conditionally add the column.
SET @kavia_db_name := DATABASE();

SET @kavia_sql_add_category := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = @kavia_db_name
        AND table_name = 'documents'
        AND column_name = 'category'
    ),
    'SELECT 1',
    'ALTER TABLE documents ADD COLUMN category VARCHAR(64) NULL AFTER mime_type'
  )
);

PREPARE kavia_stmt_add_category FROM @kavia_sql_add_category;
EXECUTE kavia_stmt_add_category;
DEALLOCATE PREPARE kavia_stmt_add_category;

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
--
-- Requirements:
-- 1) If a TABLE exists named document_extracted_text: do nothing (do not clobber).
-- 2) Else: ensure the VIEW exists and points to extracted_text.
--
-- We implement this using INFORMATION_SCHEMA and prepared statements so each
-- statement is standalone for the semicolon-splitting migration runner.

-- If there is NO TABLE named document_extracted_text, drop the VIEW (if any) to allow recreation.
SET @kavia_sql_drop_view := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = @kavia_db_name
        AND table_name = 'document_extracted_text'
        AND table_type = 'BASE TABLE'
    ),
    'SELECT 1',
    'DROP VIEW IF EXISTS document_extracted_text'
  )
);

PREPARE kavia_stmt_drop_view FROM @kavia_sql_drop_view;
EXECUTE kavia_stmt_drop_view;
DEALLOCATE PREPARE kavia_stmt_drop_view;

-- If there is NO TABLE named document_extracted_text, create the VIEW.
SET @kavia_sql_create_view := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = @kavia_db_name
        AND table_name = 'document_extracted_text'
        AND table_type = 'BASE TABLE'
    ),
    'SELECT 1',
    'CREATE VIEW document_extracted_text AS
      SELECT
        id,
        document_id,
        extractor,
        extractor_version,
        language,
        text_content,
        metadata_json,
        created_at
      FROM extracted_text'
  )
);

PREPARE kavia_stmt_create_view FROM @kavia_sql_create_view;
EXECUTE kavia_stmt_create_view;
DEALLOCATE PREPARE kavia_stmt_create_view;
`;
}

module.exports = { getMigrationSql };
