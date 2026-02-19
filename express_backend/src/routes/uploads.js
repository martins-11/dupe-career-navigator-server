'use strict';

const express = require('express');
const multer = require('multer');
const { uuidV4 } = require('../utils/uuid');

const router = express.Router();

/**
 * Upload APIs (placeholder).
 *
 * Goals:
 * - Provide real multipart/form-data endpoints for multi-file uploads
 * - Keep behavior safe even when DB/storage env vars are not configured
 * - Return deterministic metadata about received files
 *
 * This scaffold intentionally uses memoryStorage so no files are written to disk.
 * In a future iteration, the handler can stream to S3 (or persist to DB).
 */

// Conservative defaults; can be tuned via env.
const maxFileSizeBytes = Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || 15 * 1024 * 1024); // 15MB
const maxFiles = Number(process.env.UPLOAD_MAX_FILES || 10);

// Memory storage keeps this endpoint side-effect-free.
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
  // Default to 400 for malformed multipart requests.
  return { status: 400, body: { error: 'upload_error', message } };
}

/**
 * POST /uploads/documents
 * Accepts multipart/form-data with field "files" (multiple).
 */
router.post('/documents', (req, res) => {
  // Multer parsing is callback-style; we translate errors to safe JSON.
  upload.array('files', maxFiles)(req, res, (err) => {
    if (err) {
      const mapped = multerErrorToResponse(err);
      return res.status(mapped.status).json(mapped.body);
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
    }

    const uploadId = uuidV4();
    return res.json({
      uploadId,
      receivedFiles: mapFiles(files),
      message:
        'Files received (placeholder). No persistence performed; integrate storage/DB in a later step.'
    });
  });
});

/**
 * POST /uploads/text
 * Same behavior as /uploads/documents, kept separate to allow future content-type validation.
 */
router.post('/text', (req, res) => {
  upload.array('files', maxFiles)(req, res, (err) => {
    if (err) {
      const mapped = multerErrorToResponse(err);
      return res.status(mapped.status).json(mapped.body);
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
    }

    const uploadId = uuidV4();
    return res.json({
      uploadId,
      receivedFiles: mapFiles(files),
      message:
        'Files received (placeholder). No persistence performed; integrate storage/DB in a later step.'
    });
  });
});

module.exports = router;
