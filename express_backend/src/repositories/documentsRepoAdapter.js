'use strict';

const pgRepo = require('./documentsRepo');
const mysqlRepo = require('./mysql/documentsRepo.mysql');
const memRepo = require('./memory/documentsMemoryRepo');
const { selectRepo } = require('./_repoSelector');

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
async function createDocument(input) {
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
async function listDocuments(options = {}) {
  return _repo().listDocuments(options);
}

// PUBLIC_INTERFACE
async function getDocumentById(documentId) {
  /** Get a document using configured persistence (memory by default). */
  return _repo().getDocumentById(documentId);
}

// PUBLIC_INTERFACE
async function upsertExtractedText(documentId, input) {
  /** Store extracted text using configured persistence (memory by default). */
  return _repo().upsertExtractedText(documentId, input);
}

// PUBLIC_INTERFACE
async function getLatestExtractedText(documentId) {
  /** Get the latest extracted text using configured persistence (memory by default). */
  return _repo().getLatestExtractedText(documentId);
}

module.exports = {
  createDocument,
  listDocuments,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText
};
