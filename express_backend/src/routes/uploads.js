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
const {
  DOCUMENT_CATEGORY_VALUES,
  normalizeDocumentCategory
} = require('../models/documentCategories');

const router = express.Router();

/**
 * Upload APIs (MVP: local file save + metadata + extracted text).
 *
 * Maintains existing API contract:
 * - POST /uploads/documents -> { uploadId, receivedFiles, message }
 * - POST /uploads/text      -> { uploadId, receivedFiles, message }
 *
 * Improvements:
 * - Better multi-file validation reporting (identify offending file names) for:
 *   - file size (413 payload_too_large)
 *   - unsupported types (415 unsupported_media_type)
 * - Enhanced server-side logging for:
 *   - multer parsing issues
 *   - persistence/extraction failures (per file)
 *
 * Notes:
 * - Multer typically aborts at the first fileFilter/limits error. To provide better UX for
 *   multi-file uploads, we perform a proactive validation pass using `memoryStorage()` to
 *   inspect ALL files and produce an aggregated error payload listing the offending files.
 * - We then persist the files ourselves (write to disk and call existing persistence/extraction).
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
    // If we cannot create the dir, later file writes will fail; allow request to error.
  }
}

function safeBasename(originalname) {
  // Prevent path traversal and normalize to a simple file name.
  const base = path.basename(String(originalname || 'file'));
  // Replace characters that commonly cause issues across platforms.
  return base.replace(/[^\w.\-()+\s]/g, '_');
}

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const allowedExtensions = new Set(['.pdf', '.txt', '.md', '.doc', '.docx']);

/**
 * Decide whether a file is allowed based on mimetype OR extension.
 * Some clients send generic mimetypes so extension is used as fallback.
 */
function isAllowedType(file) {
  const mt = String(file?.mimetype || '').toLowerCase();
  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  const allowedByMime = allowedMimeTypes.has(mt);
  const allowedByExt = allowedExtensions.has(ext);
  return { ok: allowedByMime || allowedByExt, mt, ext };
}

function mapFiles(files) {
  return (files || []).map((f) => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size
  }));
}

/**
 * Convert multer error into a basic API response.
 * NOTE: For multi-file validation we attempt to avoid this by proactively validating all files.
 */
function multerErrorToResponse(err) {
  const message = String(err && err.message ? err.message : 'Upload failed');
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, body: { error: 'payload_too_large', message } };
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return { status: 400, body: { error: 'too_many_files', message } };
  }
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return { status: 400, body: { error: 'validation_error', message } };
  }
  if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
    return { status: 415, body: { error: 'unsupported_media_type', message } };
  }
  return { status: 400, body: { error: 'upload_error', message } };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve per-file category using additive request fields.
 *
 * Supported patterns:
 * 1) category (single value): applies to all files
 * 2) categoriesJson: JSON array of category strings aligned with upload order
 * 3) categoryByOriginalnameJson: JSON object { "<originalname>": "<category>" }
 * 4) categoryByIndexJson: JSON object { "0": "resume", "1": "job_description", ... }
 *
 * If none are provided, returns null category.
 */
function resolveCategoryForFile(req, file, index) {
  const single = normalizeDocumentCategory(req.body?.category);
  if (single) return single;

  const byIndexJson = req.body?.categoryByIndexJson;
  if (byIndexJson) {
    try {
      const obj = JSON.parse(byIndexJson);
      const value = obj != null ? obj[String(index)] : null;
      const norm = normalizeDocumentCategory(value);
      if (norm) return norm;
    } catch (_) {
      // ignore
    }
  }

  const categoriesJson = req.body?.categoriesJson;
  if (categoriesJson) {
    try {
      const arr = JSON.parse(categoriesJson);
      if (Array.isArray(arr) && index >= 0 && index < arr.length) {
        const norm = normalizeDocumentCategory(arr[index]);
        if (norm) return norm;
      }
    } catch (_) {
      // ignore
    }
  }

  const byNameJson = req.body?.categoryByOriginalnameJson;
  if (byNameJson) {
    try {
      const obj = JSON.parse(byNameJson);
      const value = obj != null ? obj[String(file.originalname)] : null;
      const norm = normalizeDocumentCategory(value);
      if (norm) return norm;
    } catch (_) {
      // ignore
    }
  }

  return null;
}

/**
 * MVP validation helper: if client supplies `requireCategories=true`, ensure at least
 * one file exists for each of the primary categories.
 *
 * This is additive: default is not required.
 */
function validateRequiredCategoriesIfRequested(files, requireCategoriesRaw, categoriesByIndex) {
  const requireCategories = String(requireCategoriesRaw || '').toLowerCase() === 'true';
  if (!requireCategories) return { ok: true };

  const present = new Set();
  for (const c of categoriesByIndex) {
    if (c) present.add(c);
  }

  const missing = DOCUMENT_CATEGORY_VALUES.filter((c) => !present.has(c));
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    error: {
      error: 'validation_error',
      message: `Missing required document categories: ${missing.join(', ')}`,
      details: {
        requiredCategories: DOCUMENT_CATEGORY_VALUES,
        receivedCategories: Array.from(present)
      }
    }
  };
}

/**
 * Write uploaded file buffer to local disk, returning the absolute path.
 */
function writeUploadToLocalDisk({ originalname, buffer }) {
  ensureLocalUploadsDir();
  const ext = path.extname(originalname || '');
  const stem = safeBasename(path.basename(originalname || 'file', ext));
  const unique = uuidV4();
  const filename = `${unique}__${stem}${ext}`;
  const absPath = path.resolve(localUploadsDir, filename);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

/**
 * Persist a single uploaded file (metadata + extraction).
 * Expects a "memory storage" file object with `.buffer`.
 */
async function persistOneMemoryFile({ file, userId, source, category }) {
  const fileBytes = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);
  const absPath = writeUploadToLocalDisk({ originalname: file.originalname, buffer: fileBytes });
  const hash = fileBytes.length ? sha256Hex(fileBytes) : null;

  // Persist ONLY metadata (no blobs).
  const doc = await documentsRepo.createDocument({
    userId: userId ?? null,
    originalFilename: file.originalname,
    mimeType: file.mimetype || null,

    // Additive: category is used by orchestration auto-selection.
    category: category ?? null,

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

  // Always persist an extracted_text row when we recognize the type (extraction != null),
  // even if the extracted text is empty. This guarantees "one extracted_text row per upload".
  if (extraction) {
    const rawText = extraction.text || '';
    const hasMeaningfulText = Boolean(String(rawText).trim());

    const normalized = normalizeText(rawText, {
      removeExtraWhitespace: true,
      normalizeLineBreaks: true
    });

    const warnings = Array.isArray(extraction.warnings) ? extraction.warnings : [];

    await documentsRepo.upsertExtractedText(doc.id, {
      extractor: extraction.extractor,
      extractorVersion: extraction.extractorVersion,
      language: extraction.language ?? null,
      textContent: hasMeaningfulText ? normalized.text : '',
      metadataJson: {
        ...extraction.metadata,
        warnings,
        normalization: normalized.stats,
        extractedTextEmpty: !hasMeaningfulText,
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
 * Validate ALL uploaded files and return aggregated offending info.
 * This is what enables multi-file requests to return "which file(s) failed" rather
 * than failing at the first one.
 */
function validateAllFiles(files) {
  const tooLarge = [];
  const unsupported = [];

  for (const f of files || []) {
    const size = Number.isFinite(f.size) ? f.size : null;
    if (size != null && size > maxFileSizeBytes) {
      tooLarge.push({
        originalname: f.originalname,
        size,
        maxSizeBytes: maxFileSizeBytes
      });
      continue;
    }

    const allowed = isAllowedType(f);
    if (!allowed.ok) {
      unsupported.push({
        originalname: f.originalname,
        mimetype: f.mimetype || null,
        extension: allowed.ext || null
      });
    }
  }

  if (tooLarge.length > 0) {
    return {
      ok: false,
      status: 413,
      body: {
        error: 'payload_too_large',
        message: `One or more files exceed the max file size (${maxFileSizeBytes} bytes).`,
        details: { offendingFiles: tooLarge }
      }
    };
  }

  if (unsupported.length > 0) {
    return {
      ok: false,
      status: 415,
      body: {
        error: 'unsupported_media_type',
        message: 'One or more files have an unsupported media type or extension.',
        details: { offendingFiles: unsupported }
      }
    };
  }

  return { ok: true };
}

/**
 * Central handler used by both /documents and /text.
 * Uses memory storage so we can validate all files and report all offenders.
 */
function handleMultiUpload({ routeName, sourceDefault }) {
  const uploadMemory = multer({
    storage: multer.memoryStorage(),
    // Allow multer itself to accept files; we will do our own full validation
    // to return aggregated per-file errors.
    fileFilter: (req, file, cb) => cb(null, true),
    limits: {
      fileSize: maxFileSizeBytes,
      files: maxFiles
    }
  }).array('files', maxFiles);

  return (req, res) => {
    const requestId = req.headers['x-request-id'] || uuidV4();

    uploadMemory(req, res, async (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error(`[uploads:${routeName}] Multer error`, {
          requestId,
          code: err.code,
          message: err.message
        });
        const mapped = multerErrorToResponse(err);
        return res.status(mapped.status).json(mapped.body);
      }

      const files = req.files;
      if (!files || files.length === 0) {
        return res
          .status(400)
          .json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
      }

      // Proactive validation to identify all offenders.
      const validation = validateAllFiles(files);
      if (!validation.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[uploads:${routeName}] Validation failed`, {
          requestId,
          status: validation.status,
          error: validation.body?.error,
          offendingCount: validation.body?.details?.offendingFiles?.length,
          offendingFiles: validation.body?.details?.offendingFiles
        });
        return res.status(validation.status).json(validation.body);
      }

      const uploadId = uuidV4();

      // Keep response contract stable; do real persistence within request for MVP.
      const perFileFailures = [];
      try {
        const userId = req.body?.userId || null;
        const source = req.body?.source || sourceDefault || null;

        // Resolve categories per file (additive semantics).
        const categoriesByIndex = files.map((f, idx) => resolveCategoryForFile(req, f, idx));

        const requiredCategoryValidation = validateRequiredCategoriesIfRequested(
          files,
          req.body?.requireCategories,
          categoriesByIndex
        );
        if (!requiredCategoryValidation.ok) return res.status(400).json(requiredCategoryValidation.error);

        // Persist sequentially to keep memory usage predictable.
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          const category = categoriesByIndex[i] || null;

          try {
            // eslint-disable-next-line no-await-in-loop
            await persistOneMemoryFile({ file, userId, source, category });
          } catch (persistErr) {
            perFileFailures.push({
              originalname: file.originalname,
              message: String(persistErr?.message || 'Persistence/extraction failed')
            });

            // eslint-disable-next-line no-console
            console.error(`[uploads:${routeName}] Persistence/extraction failed for file`, {
              requestId,
              uploadId,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
              errorMessage: persistErr?.message,
              stack: persistErr?.stack
            });
          }
        }
      } catch (persistErr) {
        // eslint-disable-next-line no-console
        console.error(`[uploads:${routeName}] Unexpected persistence/extraction error`, {
          requestId,
          uploadId,
          errorMessage: persistErr?.message,
          stack: persistErr?.stack
        });

        // If persistence fails, still return stable response but make message explicit.
        return res.status(200).json({
          uploadId,
          receivedFiles: mapFiles(files),
          message:
            'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)'
        });
      }

      if (perFileFailures.length > 0) {
        // Preserve current behavior (200 + warning) but include offending file details.
        return res.status(200).json({
          uploadId,
          receivedFiles: mapFiles(files),
          message:
            'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)',
          warnings: [
            {
              code: 'persistence_or_extraction_failed',
              message: 'One or more files could not be persisted/extracted.',
              details: { offendingFiles: perFileFailures }
            }
          ]
        });
      }

      return res.json({
        uploadId,
        receivedFiles: mapFiles(files),
        message: 'Files received and persisted (local disk). Extracted text stored when possible.'
      });
    });
  };
}

/**
 * POST /uploads/documents
 * Accepts multipart/form-data with field "files" (multiple).
 */
router.post('/documents', handleMultiUpload({ routeName: 'documents', sourceDefault: null }));

/**
 * POST /uploads/text
 * Same behavior as /uploads/documents, kept separate to allow future content-type validation.
 */
router.post('/text', handleMultiUpload({ routeName: 'text', sourceDefault: 'text_upload' }));

module.exports = router;
