'use strict';

const { query } = require('../db/query');
const { uuidV4 } = require('../utils/uuid');

/**
 * Repository functions aligned to the placeholder schema:
 * - documents
 * - document_extracted_text
 */

// PUBLIC_INTERFACE
async function createDocument(input) {
  /** Create a document row in PostgreSQL and return the created record. */
  const id = uuidV4();

  const nowRes = await query(
    `
    INSERT INTO documents (
      id, user_id, original_filename, mime_type, source,
      storage_provider, storage_path, file_size_bytes, sha256
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING
      id,
      user_id as "userId",
      original_filename as "originalFilename",
      mime_type as "mimeType",
      source,
      storage_provider as "storageProvider",
      storage_path as "storagePath",
      file_size_bytes as "fileSizeBytes",
      sha256,
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    [
      id,
      input.userId ?? null,
      input.originalFilename,
      input.mimeType ?? null,
      input.source ?? null,
      input.storageProvider ?? null,
      input.storagePath ?? null,
      input.fileSizeBytes ?? null,
      input.sha256 ?? null
    ]
  );

  return nowRes.rows[0];
}

// PUBLIC_INTERFACE
async function getDocumentById(documentId) {
  /** Fetch a document by id. Returns null if not found. */
  const res = await query(
    `
    SELECT
      id,
      user_id as "userId",
      original_filename as "originalFilename",
      mime_type as "mimeType",
      source,
      storage_provider as "storageProvider",
      storage_path as "storagePath",
      file_size_bytes as "fileSizeBytes",
      sha256,
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM documents
    WHERE id = $1
    `,
    [documentId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function upsertExtractedText(documentId, input) {
  /**
   * Persist extracted text for a document.
   *
   * This scaffold uses INSERT (not true UPSERT) to preserve extraction history.
   * A future iteration can add uniqueness constraints if needed.
   */
  const id = uuidV4();

  const res = await query(
    `
    INSERT INTO document_extracted_text (
      id, document_id, extractor, extractor_version, language, text_content, metadata_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    RETURNING
      id,
      document_id as "documentId",
      extractor,
      extractor_version as "extractorVersion",
      language,
      text_content as "textContent",
      metadata_json as "metadataJson",
      created_at as "createdAt"
    `,
    [
      id,
      documentId,
      input.extractor ?? null,
      input.extractorVersion ?? null,
      input.language ?? null,
      input.textContent,
      JSON.stringify(input.metadataJson ?? {})
    ]
  );

  return res.rows[0];
}

// PUBLIC_INTERFACE
async function getLatestExtractedText(documentId) {
  /** Retrieve the latest extracted text blob for a given document. */
  const res = await query(
    `
    SELECT
      id,
      document_id as "documentId",
      extractor,
      extractor_version as "extractorVersion",
      language,
      text_content as "textContent",
      metadata_json as "metadataJson",
      created_at as "createdAt"
    FROM document_extracted_text
    WHERE document_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [documentId]
  );

  return res.rows[0] || null;
}

module.exports = {
  createDocument,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText
};
