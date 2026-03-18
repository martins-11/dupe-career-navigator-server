import { uuidV4 } from '../../utils/uuid.js';

/**
 * In-memory documents repository.
 *
 * This is the default persistence mode until PostgreSQL (AWS RDS) credentials are available.
 * It mirrors the shape of the DB-backed repository responses so routes can remain stable.
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _documents = new Map(); // documentId -> document
const _extractedTextRows = new Map(); // documentId -> rows[] (append-only)

// PUBLIC_INTERFACE
export async function createDocument(input) {
  /** Create a document record in memory and return it. */
  const id = uuidV4();
  const now = new Date().toISOString();

  const doc = {
    id,
    userId: input.userId ?? null,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType ?? null,

    // Additive: category enables orchestration auto-selection
    category: input.category ?? null,

    source: input.source ?? null,
    storageProvider: input.storageProvider ?? null,
    storagePath: input.storagePath ?? null,
    fileSizeBytes: input.fileSizeBytes ?? null,
    sha256: input.sha256 ?? null,
    createdAt: now,
    updatedAt: now
  };

  _documents.set(id, doc);
  return doc;
}

/**
 * PUBLIC_INTERFACE
 * Lists documents in memory.
 *
 * @param {object} [options]
 * @param {number} [options.limit] Maximum number of documents to return (default: 100, max: 1000).
 * @param {number} [options.offset] Offset for pagination (default: 0).
 * @returns {Promise<Array<object>>} Documents list ordered by createdAt desc.
 */
export async function listDocuments(options = {}) {
  const limitRaw = options.limit ?? 100;
  const offsetRaw = options.offset ?? 0;

  const limit = Math.min(Math.max(Number(limitRaw) || 0, 0), 1000);
  const offset = Math.max(Number(offsetRaw) || 0, 0);

  const all = Array.from(_documents.values());

  // Newest first, deterministic for UI.
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return all.slice(offset, offset + limit);
}

// PUBLIC_INTERFACE
export async function getDocumentById(documentId) {
  /** Fetch a document by id. Returns null if not found. */
  return _documents.get(documentId) || null;
}

// PUBLIC_INTERFACE
export async function upsertExtractedText(documentId, input) {
  /**
   * Persist extracted text history for a document in memory.
   * We keep INSERT-only semantics (append-only) to match the DB scaffold behavior.
   */
  const id = uuidV4();
  const now = new Date().toISOString();

  const row = {
    id,
    documentId,
    extractor: input.extractor ?? null,
    extractorVersion: input.extractorVersion ?? null,
    language: input.language ?? null,
    textContent: input.textContent,
    metadataJson: input.metadataJson ?? {},
    createdAt: now
  };

  const arr = _extractedTextRows.get(documentId) || [];
  arr.push(row);
  _extractedTextRows.set(documentId, arr);

  return row;
}

// PUBLIC_INTERFACE
export async function getLatestExtractedText(documentId) {
  /** Retrieve the latest extracted text blob for a given document. */
  const arr = _extractedTextRows.get(documentId) || [];
  if (arr.length === 0) return null;
  return arr[arr.length - 1];
}

/**
 * PUBLIC_INTERFACE
 * Get the latest document for a user and category (newest by createdAt).
 *
 * @param {string|null} userId
 * @param {string} category canonical category string
 * @returns {Promise<object|null>}
 */
export async function getLatestDocumentForUserByCategory(userId, category) {
  const all = Array.from(_documents.values());

  const filtered = all.filter(
    (d) => (userId ? d.userId === userId : d.userId == null) && d.category === category
  );

  filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return filtered[0] || null;
}

const documentsMemoryRepo = {
  createDocument,
  listDocuments,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText,
  getLatestDocumentForUserByCategory
};

export default documentsMemoryRepo;
