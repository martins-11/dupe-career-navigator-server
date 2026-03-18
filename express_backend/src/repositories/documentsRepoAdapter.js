import pgRepo from './documentsRepo.js';
import mysqlRepo from './mysql/documentsRepo.mysql.js';
import memRepo from './memory/documentsMemoryRepo.js';
import { selectRepo } from './_repoSelector.js';

/**
 * Documents repository adapter:
 * - Uses in-memory persistence by default
 * - Uses MySQL implementation when DB_ENGINE=mysql AND MySQL env vars are configured
 * - Can use Postgres implementation when DB_ENGINE=postgres AND Postgres env vars are configured
 *
 * Keeps API routes stable and avoids requiring DB credentials to run.
 */

function _repo() {
  return selectRepo({ pgRepo, mysqlRepo, memRepo });
}

// PUBLIC_INTERFACE
export async function createDocument(input) {
  /** Create a document using configured persistence (memory by default). */
  return _repo().createDocument(input);
}

/**
 * PUBLIC_INTERFACE
 * Lists documents using configured persistence (memory by default).
 *
 * @param {object} [options]
 * @param {number} [options.limit] Maximum number of documents to return.
 * @param {number} [options.offset] Offset for pagination.
 * @returns {Promise<Array<object>>} Documents list.
 */
export async function listDocuments(options = {}) {
  return _repo().listDocuments(options);
}

// PUBLIC_INTERFACE
export async function getDocumentById(documentId) {
  /** Get a document using configured persistence (memory by default). */
  return _repo().getDocumentById(documentId);
}

// PUBLIC_INTERFACE
export async function upsertExtractedText(documentId, input) {
  /** Store extracted text using configured persistence (memory by default). */
  return _repo().upsertExtractedText(documentId, input);
}

/**
 * PUBLIC_INTERFACE
 * Get latest document for a user by category (used by orchestration auto-selection).
 *
 * @param {string|null} userId - User ID (uuid) or null for anonymous.
 * @param {string} category - Canonical document category.
 * @returns {Promise<object|null>} Latest document row or null if none exists.
 */
export async function getLatestDocumentForUserByCategory(userId, category) {
  return _repo().getLatestDocumentForUserByCategory(userId, category);
}

// PUBLIC_INTERFACE
export async function getLatestExtractedText(documentId) {
  /** Get the latest extracted text using configured persistence (memory by default). */
  return _repo().getLatestExtractedText(documentId);
}

// PUBLIC_INTERFACE
export default {
  createDocument,
  listDocuments,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText,
  getLatestDocumentForUserByCategory
};
