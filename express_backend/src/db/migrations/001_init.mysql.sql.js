

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
export function getMigrationSql() {
  /** Returns SQL statements for initializing the MySQL database schema (placeholder). */
  return `
-- 001_init (mysql placeholder)

CREATE TABLE IF NOT EXISTS documents (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NULL,

  -- Additive: category used to auto-select latest docs for orchestration
  -- Canonical values: resume | job_description | performance_review
  category VARCHAR(64) NULL,

  source TEXT NULL,
  storage_provider TEXT NULL,
  storage_path TEXT NULL,
  file_size_bytes BIGINT NULL,
  sha256 TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS document_extracted_text (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  extractor TEXT NULL,
  extractor_version TEXT NULL,
  language TEXT NULL,
  text_content LONGTEXT NOT NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_document_extracted_text_document_id (document_id),
  CONSTRAINT fk_document_extracted_text_document_id
    FOREIGN KEY (document_id) REFERENCES documents(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

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
  CONSTRAINT fk_persona_versions_persona_id
    FOREIGN KEY (persona_id) REFERENCES personas(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Builds: orchestration progress tracker (aligned with repositories/mysql/buildsRepo.mysql.js)
CREATE TABLE IF NOT EXISTS builds (
  id CHAR(36) PRIMARY KEY,
  persona_id CHAR(36) NULL,
  document_id CHAR(36) NULL,
  status VARCHAR(50) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  message TEXT NULL,
  current_step TEXT NULL,
  steps_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_builds_persona_id (persona_id),
  INDEX idx_builds_document_id (document_id),
  INDEX idx_builds_status (status)
) ENGINE=InnoDB;

-- AI runs: per-step/request tracking (aligned with repositories/mysql/aiRunsRepo.mysql.js)
CREATE TABLE IF NOT EXISTS ai_runs (
  id CHAR(36) PRIMARY KEY,
  build_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  status VARCHAR(50) NOT NULL,
  provider VARCHAR(100) NOT NULL,
  model VARCHAR(255) NULL,
  request_json JSON NOT NULL,
  response_json JSON NULL,
  error_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_ai_runs_build_id (build_id),
  INDEX idx_ai_runs_persona_id (persona_id),
  INDEX idx_ai_runs_status (status),
  CONSTRAINT fk_ai_runs_build_id
    FOREIGN KEY (build_id) REFERENCES builds(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
`;
}

export default { getMigrationSql };
