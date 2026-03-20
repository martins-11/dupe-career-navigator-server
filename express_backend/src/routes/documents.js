import express from 'express';
import { DocumentCreateRequest, ExtractedTextUpsertRequest } from '../models/documents.js';
import documentsRepo from '../repositories/documentsRepoAdapter.js';
import { sendError } from '../utils/errors.js';

const router = express.Router();

/**
 * Document APIs (MVP).
 *
 * Supports DB-backed storage when configured, and in-memory fallback when DB is not configured.
 * Route handlers should:
 * - validate request inputs
 * - return OpenAPI-aligned ErrorResponse shapes on errors
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
    return res.json(Array.isArray(docs) ? docs : []);
  } catch (err) {
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await documentsRepo.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    return res.json(doc);
  } catch (err) {
    return sendError(res, err);
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
    if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found.' });

    const row = await documentsRepo.upsertExtractedText(req.params.id, parsed.data);
    return res.status(201).json(row);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * Shared handler for "latest extracted text" routes.
 * Kept as an internal helper so both routes stay perfectly consistent.
 */
async function _getLatestExtractedTextHandler(req, res) {
  try {
    const doc = await documentsRepo.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not_found', message: 'Document not found.' });

    const row = await documentsRepo.getLatestExtractedText(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Extracted text not found.' });

    return res.json(row);
  } catch (err) {
    return sendError(res, err);
  }
}

router.get('/:id/extracted-text/latest', _getLatestExtractedTextHandler);

/**
 * Alias route for backwards compatibility:
 * GET /documents/:id/extracted-text -> same as /documents/:id/extracted-text/latest
 */
router.get('/:id/extracted-text', _getLatestExtractedTextHandler);

export default router;
