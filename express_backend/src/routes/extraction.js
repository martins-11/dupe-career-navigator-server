'use strict';

const express = require('express');
const { getZod } = require('../utils/zod');
const { uuidV4 } = require('../utils/uuid');
const { extractTextFromUploadedFile } = require('../services/extractionService');
const { normalizeText } = require('../services/normalizationService');

const router = express.Router();

/**
 * Extraction APIs (real implementation; no DB required).
 *
 * Maintains existing HTTP contracts, but now performs:
 * - real PDF extraction (when pdf-parse dependency is present)
 * - real text decoding for TXT payloads
 * - shared normalization logic via normalizationService
 *
 * Still does NOT persist extracted text; persistence remains via /documents/:id/extracted-text.
 *
 * IMPORTANT:
 * This router runs in a CommonJS Node 18 process. Direct `require('zod')` may resolve
 * an ESM entrypoint and crash at startup. We therefore lazily initialize all Zod
 * schemas via `await getZod()` inside request handlers.
 */

let _schemasPromise;

async function getSchemas() {
  if (_schemasPromise) return _schemasPromise;

  _schemasPromise = (async () => {
    const { z } = await getZod();

    const ExtractTextRequest = z.object({
      /**
       * Optional: client-side known filename (for tracing / UI).
       * In real extractor, might inform parsing heuristics.
       */
      filename: z.string().min(1).optional(),
      /**
       * Optional: hint for mime type (e.g., application/pdf, text/plain).
       */
      mimeType: z.string().min(1).optional(),
      /**
       * The raw content as a string.
       * For PDFs this is a placeholder; a future version should accept multipart or base64 bytes.
       */
      content: z.string().min(1),
      /**
       * Optional language hint (BCP-47-ish, e.g., "en").
       */
      languageHint: z.string().min(1).optional()
    });

    const NormalizeTextRequest = z.object({
      /**
       * Free-form text to normalize (cleanup whitespace, unify line breaks, etc.).
       */
      text: z.string().min(1),
      /**
       * Optional normalization options (placeholder).
       */
      options: z
        .object({
          removeExtraWhitespace: z.boolean().optional(),
          normalizeLineBreaks: z.boolean().optional(),
          maxLength: z.number().int().positive().optional()
        })
        .optional()
    });

    return { ExtractTextRequest, NormalizeTextRequest };
  })();

  return _schemasPromise;
}

function validationError(res, parsed) {
  return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
}

// PUBLIC_INTERFACE
router.post('/pdf/extract-text', async (req, res) => {
  /**
   * Extract text from a PDF payload (placeholder).
   *
   * IMPORTANT: This placeholder expects "content" as a string, not bytes.
   * A future implementation should use multipart/form-data or base64-encoded bytes,
   * then run a real PDF parser (e.g., pdf-parse) safely with file size limits.
   */
  const { ExtractTextRequest } = await getSchemas();

  const parsed = ExtractTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();

  // Contract still expects `content` as a string (not bytes). We support two modes:
  // 1) If content looks like base64 and mimeType indicates PDF, decode and parse as PDF
  // 2) Otherwise treat content as plain text fallback (with warning)
  const content = String(parsed.data.content || '');
  const mimeType = parsed.data.mimeType ?? 'application/pdf';

  let warnings = [];
  let extractedText = '';
  let extractor = 'plain-text';
  let extractorVersion = '1.0.0';
  let metadata = {
    filename: parsed.data.filename ?? null,
    mimeType,
    length: 0
  };

  const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(content) && content.length > 256;
  if (looksBase64) {
    try {
      const buf = Buffer.from(content, 'base64');
      const extraction = await extractTextFromUploadedFile({
        filename: parsed.data.filename,
        mimeType,
        buffer: buf
      });

      if (extraction) {
        extractedText = extraction.text || '';
        extractor = extraction.extractor;
        extractorVersion = extraction.extractorVersion;
        warnings = extraction.warnings || [];
        metadata = { ...metadata, ...extraction.metadata, length: extractedText.length };
      } else {
        warnings.push('Content provided, but could not determine file type for extraction.');
        extractedText = '';
      }
    } catch (e) {
      warnings.push('Base64 decode/PDF parse failed; no text extracted.');
      extractedText = '';
    }
  } else {
    // Fallback: treat as already-extracted plain text.
    extractedText = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    warnings.push(
      'PDF endpoint received non-base64 `content`; treated as plain text fallback. For real PDF extraction, submit base64 PDF bytes in `content`.'
    );
  }

  return res.status(200).json({
    requestId,
    extractor,
    extractorVersion,
    sourceType: 'pdf',
    language: parsed.data.languageHint ?? null,
    text: extractedText,
    warnings,
    metadata
  });
});

// PUBLIC_INTERFACE
router.post('/txt/extract-text', async (req, res) => {
  /**
   * Extract text from a TXT payload (placeholder).
   *
   * For plain text this is close to "real" behavior; we just normalize line breaks.
   */
  const { ExtractTextRequest } = await getSchemas();

  const parsed = ExtractTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();
  const extractedText = String(parsed.data.content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const normalized = normalizeText(extractedText, {
    removeExtraWhitespace: true,
    normalizeLineBreaks: true
  });

  return res.status(200).json({
    requestId,
    extractor: 'plain-text',
    extractorVersion: '1.0.0',
    sourceType: 'txt',
    language: parsed.data.languageHint ?? null,
    text: normalized.text,
    warnings: [],
    metadata: {
      filename: parsed.data.filename ?? null,
      mimeType: parsed.data.mimeType ?? 'text/plain',
      length: normalized.text.length,
      normalization: normalized.stats
    }
  });
});

// PUBLIC_INTERFACE
router.post('/normalize', async (req, res) => {
  /**
   * Normalize document text (placeholder).
   *
   * Intended for:
   * - cleaning up extracted text before downstream AI usage
   * - standardizing whitespace/line breaks
   */
  const { NormalizeTextRequest } = await getSchemas();

  const parsed = NormalizeTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();
  const opts = parsed.data.options || {};

  const out = normalizeText(parsed.data.text, {
    removeExtraWhitespace: opts.removeExtraWhitespace,
    normalizeLineBreaks: opts.normalizeLineBreaks,
    maxLength: opts.maxLength
  });

  return res.status(200).json({
    requestId,
    text: out.text,
    stats: out.stats
  });
});

module.exports = router;
