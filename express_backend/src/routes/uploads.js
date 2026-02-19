'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { uuidV4 } = require('../utils/uuid');
const documentsRepo = require('../repositories/documentsRepoAdapter');
const { extractTextFromUploadedFile } = require('../services/extractionService');
const { normalizeText } = require('../services/normalizationService');

const router = express.Router();

/**
 * Upload APIs (real implementation with in-memory persistence).
 *
 * Maintains existing API contract:
 * - POST /uploads/documents -> { uploadId, receivedFiles, message }
 * - POST /uploads/text      -> { uploadId, receivedFiles, message }
 *
 * Enhancements (side effects are now real, but response stays stable):
 * - Compute sha256 for each file
 * - Create document metadata record (memory by default; Postgres if configured)
 * - Extract text for txt/pdf where possible
 * - Normalize extracted text and persist as document_extracted_text
 */

// Conservative defaults; can be tuned via env.
const maxFileSizeBytes = Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || 15 * 1024 * 1024); // 15MB
const maxFiles = Number(process.env.UPLOAD_MAX_FILES || 10);

// Memory storage keeps it disk-free; we still persist metadata/text to repositories.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFiles
  }
});

function mapFiles(files) {
  return (files || []).map((f) => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size
  }));
}

function multerErrorToResponse(err) {
  const message = String(err && err.message ? err.message : 'Upload failed');
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, body: { error: 'payload_too_large', message } };
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return { status: 400, body: { error: 'too_many_files', message } };
  }
  return { status: 400, body: { error: 'upload_error', message } };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function persistOneFile({ file, userId, source }) {
  const fileBytes = file.buffer || Buffer.alloc(0);
  const hash = fileBytes.length ? sha256Hex(fileBytes) : null;

  const doc = await documentsRepo.createDocument({
    userId: userId ?? null,
    originalFilename: file.originalname,
    mimeType: file.mimetype || null,
    source: source ?? null,
    storageProvider: 'memory',
    storagePath: null,
    fileSizeBytes: Number.isFinite(file.size) ? file.size : fileBytes.length,
    sha256: hash
  });

  // Best-effort extract; if fails, we still keep the document metadata.
  const extraction = await extractTextFromUploadedFile({
    filename: file.originalname,
    mimeType: file.mimetype,
    buffer: fileBytes
  });

  if (extraction && extraction.text && String(extraction.text).trim()) {
    const normalized = normalizeText(extraction.text, {
      removeExtraWhitespace: true,
      normalizeLineBreaks: true
    });

    await documentsRepo.upsertExtractedText(doc.id, {
      extractor: extraction.extractor,
      extractorVersion: extraction.extractorVersion,
      language: extraction.language ?? null,
      textContent: normalized.text,
      metadataJson: {
        ...extraction.metadata,
        normalization: normalized.stats
      }
    });
  }

  return doc;
}

/**
 * POST /uploads/documents
 * Accepts multipart/form-data with field "files" (multiple).
 */
router.post('/documents', (req, res) => {
  upload.array('files', maxFiles)(req, res, async (err) => {
    if (err) {
      const mapped = multerErrorToResponse(err);
      return res.status(mapped.status).json(mapped.body);
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res
        .status(400)
        .json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
    }

    const uploadId = uuidV4();

    // Keep response contract stable; do real persistence in background of request.
    try {
      const userId = req.body?.userId || null;
      const source = req.body?.source || null;

      // Persist sequentially to keep memory usage predictable.
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await persistOneFile({ file, userId, source });
      }
    } catch (persistErr) {
      // If persistence fails, still return stable response but make message explicit.
      return res.status(200).json({
        uploadId,
        receivedFiles: mapFiles(files),
        message:
          'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)'
      });
    }

    return res.json({
      uploadId,
      receivedFiles: mapFiles(files),
      message: 'Files received and persisted (memory by default). Extracted text stored when possible.'
    });
  });
});

/**
 * POST /uploads/text
 * Same behavior as /uploads/documents, kept separate to allow future content-type validation.
 */
router.post('/text', (req, res) => {
  upload.array('files', maxFiles)(req, res, async (err) => {
    if (err) {
      const mapped = multerErrorToResponse(err);
      return res.status(mapped.status).json(mapped.body);
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res
        .status(400)
        .json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
    }

    const uploadId = uuidV4();

    try {
      const userId = req.body?.userId || null;
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await persistOneFile({ file, userId, source: 'text_upload' });
      }
    } catch (persistErr) {
      return res.status(200).json({
        uploadId,
        receivedFiles: mapFiles(files),
        message:
          'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)'
      });
    }

    return res.json({
      uploadId,
      receivedFiles: mapFiles(files),
      message: 'Files received and persisted (memory by default). Extracted text stored when possible.'
    });
  });
});

module.exports = router;
