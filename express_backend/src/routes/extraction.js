'use strict';

const express = require('express');
const { z } = require('zod');
const { uuidV4 } = require('../utils/uuid');

const router = express.Router();

/**
 * Extraction APIs (placeholder).
 *
 * Goals:
 * - Define stable HTTP contracts for PDF/TXT extraction and normalization.
 * - Keep implementations safe and side-effect-free (no DB access, no external services).
 * - Provide deterministic placeholder responses suitable for front-end integration.
 *
 * Notes:
 * - This does NOT parse real PDFs yet.
 * - This does NOT persist extracted text; that is handled via /documents/:id/extracted-text (existing scaffold).
 */

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
  const parsed = ExtractTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();

  // Safe placeholder "extraction": just echo content with minimal normalization.
  const extractedText = String(parsed.data.content).replace(/\r\n/g, '\n');

  return res.status(200).json({
    requestId,
    extractor: 'placeholder',
    extractorVersion: '0.1.0',
    sourceType: 'pdf',
    language: parsed.data.languageHint ?? null,
    text: extractedText,
    warnings: [
      'Placeholder implementation: no real PDF parsing performed. Submit plain text in `content` for now.'
    ],
    metadata: {
      filename: parsed.data.filename ?? null,
      mimeType: parsed.data.mimeType ?? 'application/pdf',
      length: extractedText.length
    }
  });
});

// PUBLIC_INTERFACE
router.post('/txt/extract-text', async (req, res) => {
  /**
   * Extract text from a TXT payload (placeholder).
   *
   * For plain text this is close to "real" behavior; we just normalize line breaks.
   */
  const parsed = ExtractTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();
  const extractedText = String(parsed.data.content).replace(/\r\n/g, '\n');

  return res.status(200).json({
    requestId,
    extractor: 'placeholder',
    extractorVersion: '0.1.0',
    sourceType: 'txt',
    language: parsed.data.languageHint ?? null,
    text: extractedText,
    warnings: [],
    metadata: {
      filename: parsed.data.filename ?? null,
      mimeType: parsed.data.mimeType ?? 'text/plain',
      length: extractedText.length
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
  const parsed = NormalizeTextRequest.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed);

  const requestId = uuidV4();
  const opts = parsed.data.options || {};

  let normalized = String(parsed.data.text);

  if (opts.normalizeLineBreaks !== false) {
    normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  if (opts.removeExtraWhitespace !== false) {
    // Collapse multiple spaces/tabs but keep line breaks meaningful.
    normalized = normalized
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (opts.maxLength && normalized.length > opts.maxLength) {
    normalized = normalized.slice(0, opts.maxLength);
  }

  return res.status(200).json({
    requestId,
    text: normalized,
    stats: {
      originalLength: parsed.data.text.length,
      normalizedLength: normalized.length
    }
  });
});

module.exports = router;
