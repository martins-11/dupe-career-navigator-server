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
const { DOCUMENT_CATEGORY_VALUES, normalizeDocumentCategory } = require('../models/documentCategories');
const userTargetsRepo = require('../repositories/userTargetsRepoAdapter');
const bedrockService = require('../services/bedrockService');

const router = express.Router();

/**
 * Upload APIs (MVP: local file save + metadata + extracted text).
 *
 * Maintains existing API contract:
 * - POST /uploads/documents -> { uploadId, receivedFiles, message }
 * - POST /uploads/text      -> { uploadId, receivedFiles, message }
 *
 * Additive behavior (non-breaking):
 * - Responses may include `fileSummaries` with inferred category + extracted employee name (perf reviews).
 *
 * Category tagging rules:
 * - Canonical categories: resume, job_description, performance_review
 * - Client MAY provide categories via fields (category, categoriesJson, categoryByIndexJson, categoryByOriginalnameJson).
 * - If client does NOT provide categories, the server classifies documents based on extracted text.
 *
 * IMPORTANT CONSTRAINT (per product requirement):
 * - We MUST NOT infer categories from filename or upload index.
 * - If classification fails (can't determine required set), return a graceful 400 explaining what went wrong.
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
 * Resolve per-file category using additive request fields (explicit client tagging).
 *
 * Supported patterns (all optional):
 * 1) category (single value): applies to all files
 * 2) categoriesJson: JSON array of category strings aligned with upload order
 * 3) categoryByOriginalnameJson: JSON object { "<originalname>": "<category>" }
 * 4) categoryByIndexJson: JSON object { "0": "resume", "1": "job_description", ... }
 *
 * If none are provided, returns null category (server will classify by extracted text).
 */
function resolveExplicitCategoryForFile(req, file, index) {
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
 * Classify category based on extracted text.
 *
 * This is a lightweight, explainable heuristic classifier (no AI dependency).
 * Returns:
 * - category: canonical category string or null
 * - reasons: array of strings describing scores/why classification failed
 */
function classifyCategoryFromExtractedText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { category: null, reasons: ['no_text_extracted'] };

  const lower = raw.toLowerCase();

  const evidence = {
    resume: 0,
    job_description: 0,
    performance_review: 0
  };

  // Resume signals
  if (/\bexperience\b/.test(lower)) evidence.resume += 1;
  if (/\beducation\b/.test(lower)) evidence.resume += 1;
  if (/\bskills\b/.test(lower)) evidence.resume += 1;
  if (/\bcertifications?\b/.test(lower)) evidence.resume += 1;
  if (/\bprofessional summary\b/.test(lower) || /\bsummary\b/.test(lower)) evidence.resume += 1;

  // Job description signals
  if (/\bresponsibilities\b/.test(lower)) evidence.job_description += 1;
  if (/\brequirements?\b/.test(lower)) evidence.job_description += 1;
  if (/\bqualifications?\b/.test(lower)) evidence.job_description += 1;
  if (/\bwe are looking for\b/.test(lower)) evidence.job_description += 2;
  if (/\byou will\b/.test(lower) && /\brole\b/.test(lower)) evidence.job_description += 2;

  // Performance review signals
  if (/\bperformance\b/.test(lower)) evidence.performance_review += 1;
  if (/\bgoals?\b/.test(lower)) evidence.performance_review += 1;
  if (/\bstrengths?\b/.test(lower)) evidence.performance_review += 1;
  if (/\bareas for improvement\b/.test(lower)) evidence.performance_review += 2;
  if (/\bfeedback\b/.test(lower)) evidence.performance_review += 1;
  if (/\bmanager\b/.test(lower) && /\bfeedback\b/.test(lower)) evidence.performance_review += 2;

  const scored = Object.entries(evidence).sort((a, b) => b[1] - a[1]);
  const [topCat, topScore] = scored[0];
  const [, secondScore] = scored[1];

  // Confidence rule: require >=2 evidence points and strictly above runner-up.
  if (topScore < 2 || topScore === secondScore) {
    return {
      category: null,
      reasons: ['insufficient_confidence', `scores=${JSON.stringify(evidence)}`]
    };
  }

  return {
    category: topCat,
    reasons: [`scores=${JSON.stringify(evidence)}`]
  };
}

/**
 * Validate that we have at least one file for each canonical category.
 * Returns a structured error payload listing which files were categorized as what,
 * and which files could not be categorized.
 */
function validateRequiredCategoriesFromClassification(classificationResults) {
  const present = new Set();
  const unclassifiedFiles = [];

  for (const r of classificationResults) {
    if (r.category) present.add(r.category);
    else {
      unclassifiedFiles.push({
        filename: r.filename,
        index: r.index,
        reason: 'could_not_classify_from_text',
        details: { classificationReasons: r.reasons }
      });
    }
  }

  const missing = DOCUMENT_CATEGORY_VALUES.filter((c) => !present.has(c));
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    error: {
      error: 'validation_error',
      message: `Unable to determine required document categories from uploaded content. Missing: ${missing.join(
        ', '
      )}.`,
      details: {
        requiredCategories: DOCUMENT_CATEGORY_VALUES,
        receivedCategories: Array.from(present),
        unclassifiedFiles,
        note:
          'Please upload one Resume, one Job Description, and one Performance Review. If classification fails, ensure the documents contain recognizable headings (e.g., "Experience", "Responsibilities", "Feedback").'
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
 * Persist a single uploaded file (metadata + extraction + extracted_text).
 * Expects a "memory storage" file object with `.buffer`.
 *
 * Returns { doc, extraction, normalizedText, extractedEmployeeName }.
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

    // Category is used by orchestration auto-selection.
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
  let normalizedText = '';
  let extractedEmployeeName = '';

  if (extraction) {
    const rawText = extraction.text || '';
    const hasMeaningfulText = Boolean(String(rawText).trim());

    const normalized = normalizeText(rawText, {
      removeExtraWhitespace: true,
      normalizeLineBreaks: true
    });

    normalizedText = hasMeaningfulText ? normalized.text : '';

    // Best-effort name extraction for performance reviews
    if (category === 'performance_review' && normalizedText.trim()) {
      try {
        const { extractNameAndCurrentRole } = require('../utils/nameRoleExtraction');
        const extracted = extractNameAndCurrentRole(normalizedText);
        extractedEmployeeName = extracted?.name ? String(extracted.name) : '';
      } catch (_) {
        extractedEmployeeName = '';
      }
    }

    const warnings = Array.isArray(extraction.warnings) ? extraction.warnings : [];

    await documentsRepo.upsertExtractedText(doc.id, {
      extractor: extraction.extractor,
      extractorVersion: extraction.extractorVersion,
      language: extraction.language ?? null,
      textContent: normalizedText,
      metadataJson: {
        ...extraction.metadata,
        warnings,
        normalization: normalized.stats,
        extractedTextEmpty: !hasMeaningfulText,
        extractedEmployeeName: extractedEmployeeName || null,
        localFile: {
          storageProvider: 'local',
          storagePath: absPath
        }
      }
    });

    /**
     * Current role extraction/persistence (best-effort, non-blocking):
     * - Only attempt when we have a userId and meaningful text.
     * - Prefer resume/performance_review categories (most likely to include a current title).
     * - Persist into user_targets as a "current role" record so Mindmap/Personas can show it.
     *
     * ENV REQUIRED for real Bedrock:
     * - AWS_REGION/AWS credentials as per bedrockService docs.
     */
    if (userId && normalizedText.trim() && (category === 'resume' || category === 'performance_review')) {
      try {
        const extracted = await bedrockService.extractCurrentRoleFromText({
          text: normalizedText,
          hints: { name: extractedEmployeeName || null },
          options: { modelId: process.env.BEDROCK_ROLE_MODEL_ID || process.env.BEDROCK_MODEL_ID || null }
        });

        if (extracted?.currentRoleTitle) {
          await userTargetsRepo.upsertUserCurrentRole({
            userId: String(userId),
            currentRoleTitle: extracted.currentRoleTitle,
            source: 'bedrock'
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[uploads] current role extraction skipped/failed (best-effort)', {
          userId,
          category,
          message: e?.message,
          code: e?.code
        });
      }
    }
  }

  return { doc, extraction, normalizedText, extractedEmployeeName };
}

/**
 * Validate ALL uploaded files and return aggregated offending info.
 * This enables multi-file requests to return "which file(s) failed".
 */
function validateAllFiles(files) {
  const tooLarge = [];
  const unsupported = [];

  for (let i = 0; i < (files || []).length; i += 1) {
    const f = files[i];
    const size = Number.isFinite(f.size) ? f.size : null;

    if (size != null && size > maxFileSizeBytes) {
      tooLarge.push({
        filename: f.originalname,
        index: i,
        reason: 'file_too_large',
        size,
        maxSizeBytes: maxFileSizeBytes
      });
      continue;
    }

    const allowed = isAllowedType(f);
    if (!allowed.ok) {
      unsupported.push({
        filename: f.originalname,
        index: i,
        reason: 'unsupported_file_type',
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
          method: req.method,
          path: req.originalUrl,
          ip: req.ip,
          code: err.code,
          message: err.message,
          stack: err.stack
        });
        const mapped = multerErrorToResponse(err);
        return res.status(mapped.status).json(mapped.body);
      }

      const files = req.files;
      if (!files || files.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[uploads:${routeName}] No files received`, {
          requestId,
          method: req.method,
          path: req.originalUrl,
          contentType: req.headers['content-type']
        });

        return res
          .status(400)
          .json({ error: 'validation_error', message: 'No files received. Use field name "files".' });
      }

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
      const perFileFailures = [];

      // We'll attach this additively to the final response.
      let fileSummaries;

      try {
        const userId = req.body?.userId || null;
        const source = req.body?.source || sourceDefault || null;

        // eslint-disable-next-line no-console
        console.info(`[uploads:${routeName}] Upload received`, {
          requestId,
          uploadId,
          fileCount: files.length,
          userId,
          source
        });

        // Step 1: For each file, extract text (best-effort), decide category:
        // - explicit client tag wins
        // - otherwise classify from extracted text
        const classifications = [];
        const persisted = [];

        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];

          // We want classification to be based on extracted text, which may require actual extraction.
          // We do a lightweight extraction pass first; persistence does another extraction during persistOneMemoryFile,
          // but that's acceptable for now to keep changes minimal and avoid refactoring extraction/persistence pipeline.
          const fileBytes = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);

          let extraction = null;
          try {
            // eslint-disable-next-line no-await-in-loop
            extraction = await extractTextFromUploadedFile({
              filename: file.originalname,
              mimeType: file.mimetype,
              buffer: fileBytes
            });
          } catch (_) {
            extraction = null;
          }

          const extractedText = extraction && typeof extraction.text === 'string' ? extraction.text : '';

          const explicit = resolveExplicitCategoryForFile(req, file, i);
          if (explicit) {
            classifications[i] = { index: i, filename: file.originalname, category: explicit, reasons: ['explicit'] };
          } else {
            const inferred = classifyCategoryFromExtractedText(extractedText);
            classifications[i] = {
              index: i,
              filename: file.originalname,
              category: inferred.category,
              reasons: inferred.reasons
            };
          }
        }

        // Step 2: if requireCategories=true, ensure we have at least one of each canonical category.
        const requireCategories = String(req.body?.requireCategories || '').toLowerCase() === 'true';
        if (requireCategories) {
          const requiredCategoryValidation = validateRequiredCategoriesFromClassification(classifications);
          if (!requiredCategoryValidation.ok) {
            // eslint-disable-next-line no-console
            console.warn(`[uploads:${routeName}] Category classification validation failed`, {
              requestId,
              uploadId,
              error: requiredCategoryValidation.error
            });
            return res.status(400).json(requiredCategoryValidation.error);
          }
        }

        // Step 3: Persist each file with its classified category.
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          const category = classifications[i]?.category || null;

          try {
            // eslint-disable-next-line no-await-in-loop
            const persistedOne = await persistOneMemoryFile({ file, userId, source, category });
            persisted.push(persistedOne);
          } catch (persistErr) {
            perFileFailures.push({
              filename: file.originalname,
              index: i,
              reason: 'persistence_or_extraction_failed',
              message: String(persistErr?.message || 'Persistence/extraction failed')
            });

            // eslint-disable-next-line no-console
            console.error(`[uploads:${routeName}] Persistence/extraction failed for file`, {
              requestId,
              uploadId,
              index: i,
              filename: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
              category,
              errorMessage: persistErr?.message,
              stack: persistErr?.stack
            });
          }
        }

        fileSummaries = persisted.map((p) => ({
          documentId: p?.doc?.id || null,
          originalFilename: p?.doc?.originalFilename || null,
          category: p?.doc?.category || null,
          extractedEmployeeName: p?.extractedEmployeeName || null
        }));

        // eslint-disable-next-line no-console
        console.info(`[uploads:${routeName}] fileSummaries`, { requestId, uploadId, fileSummaries });
      } catch (persistErr) {
        // eslint-disable-next-line no-console
        console.error(`[uploads:${routeName}] Unexpected persistence/extraction error`, {
          requestId,
          uploadId,
          errorMessage: persistErr?.message,
          stack: persistErr?.stack
        });

        return res.status(200).json({
          uploadId,
          receivedFiles: mapFiles(files),
          message:
            'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)',
          ...(Array.isArray(fileSummaries) ? { fileSummaries } : {})
        });
      }

      if (perFileFailures.length > 0) {
        return res.status(200).json({
          uploadId,
          receivedFiles: mapFiles(files),
          message:
            'Files received. Persistence/extraction partially failed; check server logs. (API contract preserved.)',
          ...(Array.isArray(fileSummaries) ? { fileSummaries } : {}),
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
        message: 'Files received and persisted (local disk). Extracted text stored when possible.',
        ...(Array.isArray(fileSummaries) ? { fileSummaries } : {})
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
