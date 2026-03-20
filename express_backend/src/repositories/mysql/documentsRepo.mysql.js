import { dbQuery } from '../../db/connection.js';
import { uuidV4 } from '../../utils/uuid.js';

/**
 * MySQL repository for:
 * - documents
 * - document_extracted_text
 *
 * Notes:
 * - Uses MySQL parameter placeholders '?'
 * - Expects a MySQL-equivalent schema to exist when enabled.
 * - This module is NOT used unless env indicates DB configured.
 */

// PUBLIC_INTERFACE
export async function createDocument(input) {
  /** Create a document row in MySQL and return the created record. */
  const id = uuidV4();

  const now = new Date();

  // MySQL doesn't support RETURNING broadly, so we insert then re-select.
  await dbQuery(
    `
    INSERT INTO documents (
      id, user_id, original_filename, mime_type, category, source,
      storage_provider, storage_path, file_size_bytes, sha256,
      created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      id,
      input.userId ?? null,
      input.originalFilename,
      input.mimeType ?? null,
      input.category ?? null,
      input.source ?? null,
      input.storageProvider ?? null,
      input.storagePath ?? null,
      input.fileSizeBytes ?? null,
      input.sha256 ?? null,
      now,
      now
    ]
  );

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      original_filename as originalFilename,
      mime_type as mimeType,
      category,
      source,
      storage_provider as storageProvider,
      storage_path as storagePath,
      file_size_bytes as fileSizeBytes,
      sha256,
      created_at as createdAt,
      updated_at as updatedAt
    FROM documents
    WHERE id = ?
    `,
    [id]
  );

  return res.rows[0] || null;
}

/**
 * PUBLIC_INTERFACE
 * Lists documents from MySQL.
 *
 * @param {object} [options]
 * @param {number} [options.limit] Maximum number of documents to return (default: 100, max: 1000).
 * @param {number} [options.offset] Offset for pagination (default: 0).
 * @returns {Promise<Array<object>>} Documents list ordered by created_at desc.
 */
export async function listDocuments(options = {}) {
  const limitRaw = options.limit ?? 100;
  const offsetRaw = options.offset ?? 0;

  const limit = Math.min(Math.max(Number(limitRaw) || 0, 0), 1000);
  const offset = Math.max(Number(offsetRaw) || 0, 0);

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      original_filename as originalFilename,
      mime_type as mimeType,
      category,
      source,
      storage_provider as storageProvider,
      storage_path as storagePath,
      file_size_bytes as fileSizeBytes,
      sha256,
      created_at as createdAt,
      updated_at as updatedAt
    FROM documents
    ORDER BY created_at DESC
    LIMIT ?
    OFFSET ?
    `,
    [limit, offset]
  );

  return res.rows;
}

// PUBLIC_INTERFACE
export async function getDocumentById(documentId) {
  /** Fetch a document by id. Returns null if not found. */
  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      original_filename as originalFilename,
      mime_type as mimeType,
      category,
      source,
      storage_provider as storageProvider,
      storage_path as storagePath,
      file_size_bytes as fileSizeBytes,
      sha256,
      created_at as createdAt,
      updated_at as updatedAt
    FROM documents
    WHERE id = ?
    `,
    [documentId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
export async function upsertExtractedText(documentId, input) {
  /**
   * Upsert extracted text for a document (exactly one row per document).
   *
   * Implementation note:
   * - Uses the canonical MySQL table `extracted_text` created by migration 002.
   * - Enforces single-row semantics by using the document_id as the primary key.
   */
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO extracted_text (
      id, document_id, extractor, extractor_version, language, text_content, metadata_json, created_at
    )
    VALUES (?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      extractor = VALUES(extractor),
      extractor_version = VALUES(extractor_version),
      language = VALUES(language),
      text_content = VALUES(text_content),
      metadata_json = VALUES(metadata_json),
      created_at = VALUES(created_at)
    `,
    [
      documentId, // id == document_id (single-row per document)
      documentId,
      input.extractor ?? null,
      input.extractorVersion ?? null,
      input.language ?? null,
      input.textContent,
      JSON.stringify(input.metadataJson ?? {}),
      now
    ]
  );

  const res = await dbQuery(
    `
    SELECT
      id,
      document_id as documentId,
      extractor,
      extractor_version as extractorVersion,
      language,
      text_content as textContent,
      metadata_json as metadataJson,
      created_at as createdAt
    FROM extracted_text
    WHERE document_id = ?
    LIMIT 1
    `,
    [documentId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
export async function getLatestExtractedText(documentId) {
  /** Retrieve the extracted text blob for a given document (single-row semantics). */
  const res = await dbQuery(
    `
    SELECT
      id,
      document_id as documentId,
      extractor,
      extractor_version as extractorVersion,
      language,
      text_content as textContent,
      metadata_json as metadataJson,
      created_at as createdAt
    FROM extracted_text
    WHERE document_id = ?
    LIMIT 1
    `,
    [documentId]
  );

  return res.rows[0] || null;
}

/**
 * PUBLIC_INTERFACE
 * Get latest document for a user and category.
 *
 * @param {string|null} userId
 * @param {string} category canonical category string
 * @returns {Promise<object|null>}
 */
export async function getLatestDocumentForUserByCategory(userId, category) {
  // If userId is null, match NULL user_id documents (useful for anonymous flows).
  const whereUser = userId ? 'user_id = ?' : 'user_id IS NULL';
  const params = userId ? [userId, category] : [category];

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      original_filename as originalFilename,
      mime_type as mimeType,
      category,
      source,
      storage_provider as storageProvider,
      storage_path as storagePath,
      file_size_bytes as fileSizeBytes,
      sha256,
      created_at as createdAt,
      updated_at as updatedAt
    FROM documents
    WHERE ${whereUser}
      AND category = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    params
  );

  return res.rows[0] || null;
}

const documentsRepoMysql = {
  createDocument,
  listDocuments,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText,
  getLatestDocumentForUserByCategory
};

export default documentsRepoMysql;
