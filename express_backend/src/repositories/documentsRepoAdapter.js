'use strict';

const pgRepo = require('./documentsRepo');
const memRepo = require('./memory/documentsMemoryRepo');

/**
 * Repository adapter that chooses memory by default and PostgreSQL only when configured.
 *
 * IMPORTANT:
 * - Keeps existing documentsRepo.js (Postgres scaffold) intact.
 * - Ensures service can run without DB credentials.
 */

function _isDbConfigured() {
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

function _repo() {
  return _isDbConfigured() ? pgRepo : memRepo;
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
