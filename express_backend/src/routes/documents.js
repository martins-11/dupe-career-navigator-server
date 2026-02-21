'use strict';

const express = require('express');
const { DocumentCreateRequest, ExtractedTextUpsertRequest } = require('../models/documents');
const documentsRepo = require('../repositories/documentsRepoAdapter');

const router = express.Router();

/**
 * Document APIs (scaffold).
 *
 * This intentionally focuses on:
 * - document metadata storage
 * - extracted text persistence/retrieval (required for AI persona generation)
 *
 * Uploading raw file bytes (PDF parsing, etc.) is out of scope for this step.
 */

router.get('/', async (req, res) => {
  /**
   * List documents.
   *
   * Query params:
   * - limit (optional, default 100, max 1000)
   * - offset (optional, default 0)
   */
  try {
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const offset = req.query.offset != null ? Number(req.query.offset) : undefined;

    if ((limit != null && Number.isNaN(limit)) || (offset != null && Number.isNaN(offset))) {
      return res.status(400).json({ error: 'validation_error', message: 'limit/offset must be numbers' });
    }

    const docs = await documentsRepo.listDocuments({ limit, offset });
    return res.json(docs);
  } catch (err) {
    return res.status(503).json({ error: 'db_unavailable', message: err.message });
  }
});

router.post('/', async (req, res) => {
  const parsed = DocumentCreateRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    const doc = await documentsRepo.createDocument(parsed.data);
    return res.status(201).json(doc);
  } catch (err) {
    // Usually DB not configured yet
    return res.status(503).json({ error: 'db_unavailable', message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await documentsRepo.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    return res.json(doc);
  } catch (err) {
    return res.status(503).json({ error: 'db_unavailable', message: err.message });
  }
});

router.post('/:id/extracted-text', async (req, res) => {
  const parsed = ExtractedTextUpsertRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
  }

  try {
    // Ensure document exists first (nicer error)
    const doc = await documentsRepo.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document_not_found' });

    const row = await documentsRepo.upsertExtractedText(req.params.id, parsed.data);
    return res.status(201).json(row);
  } catch (err) {
    return res.status(503).json({ error: 'db_unavailable', message: err.message });
  }
});

/**
 * Shared handler for "latest extracted text" routes.
 * Kept as an internal helper so both routes stay perfectly consistent.
 */
async function _getLatestExtractedTextHandler(req, res) {
  try {
    const doc = await documentsRepo.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document_not_found' });

    const row = await documentsRepo.getLatestExtractedText(req.params.id);
    if (!row) return res.status(404).json({ error: 'extracted_text_not_found' });

    return res.json(row);
  } catch (err) {
    return res.status(503).json({ error: 'db_unavailable', message: err.message });
  }
}

router.get('/:id/extracted-text/latest', _getLatestExtractedTextHandler);

/**
 * Alias route for backwards compatibility:
 * GET /documents/:id/extracted-text -> same as /documents/:id/extracted-text/latest
 */
router.get('/:id/extracted-text', _getLatestExtractedTextHandler);

module.exports = router;
