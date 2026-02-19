'use strict';

const { uuidV4 } = require('../../utils/uuid');

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
async function createDocument(input) {
  /** Create a document record in memory and return it. */
  const id = uuidV4();
  const now = new Date().toISOString();

  const doc = {
    id,
    userId: input.userId ?? null,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType ?? null,
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

// PUBLIC_INTERFACE
async function getDocumentById(documentId) {
  /** Fetch a document by id. Returns null if not found. */
  return _documents.get(documentId) || null;
}

// PUBLIC_INTERFACE
async function upsertExtractedText(documentId, input) {
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
async function getLatestExtractedText(documentId) {
  /** Retrieve the latest extracted text blob for a given document. */
  const arr = _extractedTextRows.get(documentId) || [];
  if (arr.length === 0) return null;
  return arr[arr.length - 1];
}

module.exports = {
  createDocument,
  getDocumentById,
  upsertExtractedText,
  getLatestExtractedText
};
