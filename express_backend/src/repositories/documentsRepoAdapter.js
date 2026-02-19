'use strict';

const pgRepo = require('./documentsRepo');
const mysqlRepo = require('./mysql/documentsRepo.mysql');
const memRepo = require('./memory/documentsMemoryRepo');
const { getDbEngine, isDbConfigured, isPostgresConfigured, isMysqlConfigured } = require('../db/connection');

/**
 * Repository adapter that chooses memory by default and a real DB only when configured.
 *
 * Priority:
 * - If DB_ENGINE=mysql (default): use MySQL repo only when MYSQL_* env vars are present.
 * - If DB_ENGINE=postgres: use Postgres repo only when PG_* env vars are present.
 *
 * IMPORTANT:
 * - Ensures service can run without DB credentials.
 * - Keeps existing Postgres scaffolding intact (do NOT remove).
 */

function _repo() {
  const engine = getDbEngine();

  if (engine === 'mysql') {
    return isDbConfigured() && isMysqlConfigured() ? mysqlRepo : memRepo;
  }

  return isDbConfigured() && isPostgresConfigured() ? pgRepo : memRepo;
}

// PUBLIC_INTERFACE
async function createDocument(input) {
  /** Create a document using configured persistence (memory by default). */
  return _repo().createDocument(input);
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
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText
};
