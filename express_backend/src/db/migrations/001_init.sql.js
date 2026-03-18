

/**
 * Placeholder "migration" representing the documented PostgreSQL schema.
 *
 * IMPORTANT:
 * - This file intentionally exports SQL strings rather than running automatically.
 * - When AWS RDS credentials are available, a proper migration runner (node-pg-migrate, knex, prisma, etc.)
 *   can be introduced, or this SQL can be applied via psql.
 *
 * This schema is designed for:
 * - document storage metadata
 * - extracted text persistence
 * - persona generation/version history (placeholder tables)
 */

// PUBLIC_INTERFACE
export function getMigrationSql() {
  /** Returns SQL statements for initializing the database schema (placeholder). */

  // Note: Keep to conservative Postgres types, UUID primary keys, and timestamps.
  // Using "gen_random_uuid()" requires pgcrypto extension; we keep UUID generation app-side by default.
  return `
-- 001_init (placeholder)

-- Documents uploaded by a user/session (metadata only; file bytes stored elsewhere, e.g., S3 in future)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  user_id UUID NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NULL,

  -- Additive: category used to auto-select latest docs for orchestration
  -- Canonical values: resume | job_description | performance_review
  category TEXT NULL,

  source TEXT NULL,
  storage_provider TEXT NULL,
  storage_path TEXT NULL,
  file_size_bytes BIGINT NULL,
  sha256 TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extracted text from a document (for AI persona generation)
CREATE TABLE IF NOT EXISTS document_extracted_text (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extractor TEXT NULL,
  extractor_version TEXT NULL,
  language TEXT NULL,
  text_content TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_extracted_text_document_id
  ON document_extracted_text(document_id);

-- Persona drafts / versions (placeholder)
CREATE TABLE IF NOT EXISTS personas (
  id UUID PRIMARY KEY,
  user_id UUID NULL,
  title TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS persona_versions (
  id UUID PRIMARY KEY,
  persona_id UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  persona_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_persona_versions_persona_id_version
  ON persona_versions(persona_id, version);
`;
}

export default { getMigrationSql };
