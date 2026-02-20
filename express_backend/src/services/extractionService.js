'use strict';

let pdfParse = null;
try {
  // Optional dependency.
  // eslint-disable-next-line global-require
  pdfParse = require('pdf-parse');
} catch (e) {
  pdfParse = null;
}

let mammoth = null;
try {
  // Optional dependency for DOCX text extraction.
  // eslint-disable-next-line global-require
  mammoth = require('mammoth');
} catch (e) {
  mammoth = null;
}

/**
 * Extraction service that can operate entirely in-process and without DB/AI credentials.
 *
 * Supported:
 * - PDF buffers -> text via pdf-parse (if installed)
 * - TXT buffers -> utf8 decode
 * - DOCX buffers -> text via mammoth (if installed) (best-effort)
 * - DOC buffers -> NOT reliably supported without external tooling (best-effort returns empty with warnings)
 *
 * Returns a stable shape that routes can persist (extractor, version, metadata).
 */

function _decodeToText(buffer) {
  // Best-effort UTF-8 decode; for binary types this will be garbage, so only use for actual text.
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
}

function _normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// PUBLIC_INTERFACE
async function extractTextFromUploadedFile({ filename, mimeType, buffer }) {
  /**
   * Extract text from an uploaded file buffer.
   *
   * @param {{filename?: string, mimeType?: string, buffer: Buffer}} params
   * @returns {Promise<{
   *   extractor: string,
   *   extractorVersion: string,
   *   sourceType: 'pdf'|'txt'|'doc'|'docx',
   *   language: string|null,
   *   text: string,
   *   warnings: string[],
   *   metadata: object
   * }|null>}
   */
  const mt = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();

  const isPdf = mt.includes('pdf') || name.endsWith('.pdf');

  const isDocx =
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mt.includes('officedocument.wordprocessingml.document') ||
    name.endsWith('.docx');

  // NOTE: .doc is a legacy binary format; we do not add heavy/native deps here.
  const isDoc = mt === 'application/msword' || mt.includes('application/msword') || name.endsWith('.doc');

  const isTxt =
    mt.includes('text/plain') ||
    (mt.startsWith('text/') && !mt.includes('text/html')) ||
    name.endsWith('.txt') ||
    name.endsWith('.md');

  if (isPdf) {
    if (!pdfParse) {
      return {
        extractor: 'pdf-parse',
        extractorVersion: 'missing_dependency',
        sourceType: 'pdf',
        language: null,
        text: '',
        warnings: ['PDF parsing dependency not installed; no text extracted.'],
        metadata: { filename: filename ?? null, mimeType: mimeType ?? null }
      };
    }

    try {
      const data = await pdfParse(buffer);
      const text = _normalizeNewlines(data.text || '');

      return {
        extractor: 'pdf-parse',
        extractorVersion: '1.x',
        sourceType: 'pdf',
        language: null,
        text,
        warnings: [],
        metadata: {
          filename: filename ?? null,
          mimeType: mimeType ?? null,
          numpages: data.numpages ?? null,
          numrender: data.numrender ?? null,
          info: data.info ?? null,
          metadata: data.metadata ?? null
        }
      };
    } catch (err) {
      return {
        extractor: 'pdf-parse',
        extractorVersion: '1.x',
        sourceType: 'pdf',
        language: null,
        text: '',
        warnings: ['PDF parsing failed; no text extracted.'],
        metadata: {
          filename: filename ?? null,
          mimeType: mimeType ?? null,
          error: String(err && err.message ? err.message : err)
        }
      };
    }
  }

  if (isDocx) {
    if (!mammoth) {
      return {
        extractor: 'mammoth',
        extractorVersion: 'missing_dependency',
        sourceType: 'docx',
        language: null,
        text: '',
        warnings: ['DOCX parsing dependency not installed; no text extracted.'],
        metadata: { filename: filename ?? null, mimeType: mimeType ?? null }
      };
    }

    try {
      // mammoth extracts raw text from docx; we keep best-effort extraction.
      const result = await mammoth.extractRawText({ buffer });
      const text = _normalizeNewlines(result && result.value ? result.value : '');
      const warnings = [];

      if (result && Array.isArray(result.messages) && result.messages.length) {
        // Preserve mammoth messages as warnings for debugging.
        warnings.push(
          ...result.messages.map((m) => (m && m.message ? String(m.message) : String(m))).filter(Boolean)
        );
      }

      return {
        extractor: 'mammoth',
        extractorVersion: '1.x',
        sourceType: 'docx',
        language: null,
        text,
        warnings,
        metadata: { filename: filename ?? null, mimeType: mimeType ?? null }
      };
    } catch (err) {
      return {
        extractor: 'mammoth',
        extractorVersion: '1.x',
        sourceType: 'docx',
        language: null,
        text: '',
        warnings: ['DOCX parsing failed; no text extracted.'],
        metadata: {
          filename: filename ?? null,
          mimeType: mimeType ?? null,
          error: String(err && err.message ? err.message : err)
        }
      };
    }
  }

  if (isDoc) {
    // Best-effort only: without external converters, DOC parsing is unreliable.
    return {
      extractor: 'doc_unsupported',
      extractorVersion: '1.0.0',
      sourceType: 'doc',
      language: null,
      text: '',
      warnings: [
        'Legacy .doc (binary) extraction is not supported in this service without external tooling; no text extracted.'
      ],
      metadata: { filename: filename ?? null, mimeType: mimeType ?? null }
    };
  }

  if (isTxt) {
    const text = _normalizeNewlines(_decodeToText(buffer));
    return {
      extractor: 'plain-text',
      extractorVersion: '1.0.0',
      sourceType: 'txt',
      language: null,
      text,
      warnings: [],
      metadata: { filename: filename ?? null, mimeType: mimeType ?? null, length: text.length }
    };
  }

  // Unknown type: return null (caller can decide what to do).
  return null;
}

module.exports = { extractTextFromUploadedFile };
