'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { uuidV4 } = require('../utils/uuid');
const documentsRepo = require('../repositories/documentsRepoAdapter');
const { extractTextFromUploadedFile } = require('../services/extractionService');
const { normalizeText } = require('../services/normalizationService');

const router = express.Router();

/**
 * Upload APIs (MVP: local file save + metadata + extracted text).
 *
 * Maintains existing API contract:
 * - POST /uploads/documents -> { uploadId, receivedFiles, message }
 * - POST /uploads/text      -> { uploadId, receivedFiles, message }
 *
 * MVP behavior (side effects; response stays stable):
 * - Multi-file upload in one request (field: "files")
 * - Save raw files to local disk (NO S3)
 * - Persist ONLY metadata to DB (no blobs)
 * - Immediately extract + normalize and create 1 extracted_text row per document
 *
 * Notes:
 * - Repository adapter still chooses memory when DB is not configured.
 * - When DB is configured (MySQL by default), metadata + extracted text are persisted there.
 */

// Conservative defaults; can be tuned via env.
const maxFileSizeBytes = Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || 15 * 1024 * 1024); // 15MB
const maxFiles = Number(process.env.UPLOAD_MAX_FILES || 10);

// Where raw files are stored locally.
// ENV (optional): UPLOAD_LOCAL_DIR (default: <repo>/express_backend/.local_uploads)
const localUploadsDir = path.resolve(__dirname, '../../.local_uploads');

function ensureLocalUploadsDir() {
  try {
    fs.mkdirSync(localUploadsDir, { recursive: true });
  } catch (e) {
    // If we cannot create the dir, multer will fail later; let the request error.
  }
}

function safeBasename(originalname) {
  // Prevent path traversal and normalize to a simple file name.
  const base = path.basename(String(originalname || 'file'));
  // Replace characters that commonly cause issues across platforms.
  return base.replace(/[^\w.\-()+\s]/g, '_');
}

function diskStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      ensureLocalUploadsDir();
      cb(null, localUploadsDir);
    },
    filename: (req, file, cb) => {
      // Create collision-resistant names while keeping the original basename.
      const ext = path.extname(file.originalname || '');
      const stem = safeBasename(path.basename(file.originalname || 'file', ext));
      const unique = uuidV4();
      cb(null, `${unique}__${stem}${ext}`);
    }
  });
}

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const allowedExtensions = new Set(['.pdf', '.txt', '.md', '.doc', '.docx']);

/**
 * Multer file filter.
 * Best-effort allow based on mime type OR file extension (some clients send generic mime types).
 */
function fileFilter(req, file, cb) {
  const mt = String(file.mimetype || '').toLowerCase();
  const ext = path.extname(String(file.originalname || '')).toLowerCase();

  const allowedByMime = allowedMimeTypes.has(mt);
  const allowedByExt = allowedExtensions.has(ext);

  if (allowedByMime || allowedByExt) return cb(null, true);

  return cb(
    Object.assign(new Error(`Unsupported file type: ${file.mimetype || 'unknown'} (${ext || 'no extension'})`), {
      code: 'UNSUPPORTED_FILE_TYPE'
    })
  );
}

// Disk storage saves files locally per MVP. We still persist metadata/text to repositories.
const upload = multer({
  storage: diskStorage(),
  fileFilter,
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
  if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
    return { status: 415, body: { error: 'unsupported_media_type', message } };
  }
  return { status: 400, body: { error: 'upload_error', message } };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readFileBufferOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

async function persistOneFile({ file, userId, source }) {
  // With diskStorage, multer provides file.path.
  const absPath = file.path ? path.resolve(file.path) : null;
  const fileBytes = absPath ? readFileBufferOrEmpty(absPath) : Buffer.alloc(0);

  const hash = fileBytes.length ? sha256Hex(fileBytes) : null;

  // Persist ONLY metadata (no blobs).
  const doc = await documentsRepo.createDocument({
    userId: userId ?? null,
    originalFilename: file.originalname,
    mimeType: file.mimetype || null,
    source: source ?? null,
    storageProvider: 'local',
    storagePath: absPath, // Local path only; never store file contents in DB.
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

    // Create ONE extracted_text row per document upload (MVP). This repo keeps history via INSERT.
    await documentsRepo.upsertExtractedText(doc.id, {
      extractor: extraction.extractor,
      extractorVersion: extraction.extractorVersion,
      language: extraction.language ?? null,
      textContent: normalized.text,
      metadataJson: {
        ...extraction.metadata,
        normalization: normalized.stats,
        localFile: {
          storageProvider: 'local',
          storagePath: absPath
        }
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

    // Keep response contract stable; do real persistence within request for MVP.
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
      message: 'Files received and persisted (local disk). Extracted text stored when possible.'
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
      message: 'Files received and persisted (local disk). Extracted text stored when possible.'
    });
  });
});

module.exports = router;
