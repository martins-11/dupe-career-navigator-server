'use strict';

let pdfParse = null;
try {
  // Optional dependency; we add it to package.json in this change.
  // eslint-disable-next-line global-require
  pdfParse = require('pdf-parse');
} catch (e) {
  pdfParse = null;
}

/**
 * Extraction service that can operate entirely in-process and without DB/AI credentials.
 *
 * Supported:
 * - PDF buffers -> text via pdf-parse (if installed)
 * - TXT buffers -> utf8 decode
 *
 * Returns a stable shape that routes can persist (extractor, version, metadata).
 */

function _decodeToText(buffer) {
  // Best-effort UTF-8 decode; for binary PDFs this will be garbage, which is why we use pdf-parse when possible.
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
}

// PUBLIC_INTERFACE
async function extractTextFromUploadedFile({ filename, mimeType, buffer }) {
  /**
   * Extract text from an uploaded file buffer.
   *
   * @param {{filename?: string, mimeType?: string, buffer: Buffer}} params
   * @returns {Promise<{extractor: string, extractorVersion: string, sourceType: 'pdf'|'txt', language: string|null, text: string, warnings: string[], metadata: object}|null>}
   */
  const mt = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();

  const isPdf = mt.includes('pdf') || name.endsWith('.pdf');
  const isTxt =
    mt.includes('text/plain') ||
    mt.includes('text/') ||
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
      const text = String(data.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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

  if (isTxt) {
    const text = _decodeToText(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
