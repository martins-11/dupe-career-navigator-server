/**
 * Normalization service used throughout the workflow.
 *
 * Provides consistent cleanup:
 * - normalize line breaks
 * - collapse extra whitespace
 * - optional truncation
 */

// PUBLIC_INTERFACE
export function normalizeText(text, options) {
  /**
   * Normalize a text blob for downstream processing.
   *
   * @param {string} text
   * @param {{removeExtraWhitespace?: boolean, normalizeLineBreaks?: boolean, maxLength?: number}|undefined} options
   * @returns {{text: string, stats: {originalLength: number, normalizedLength: number}}}
   */
  const opts = options || {};
  const original = String(text || '');
  let normalized = original;

  if (opts.normalizeLineBreaks !== false) {
    normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  if (opts.removeExtraWhitespace !== false) {
    normalized = normalized
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (opts.maxLength && Number.isFinite(opts.maxLength) && opts.maxLength > 0 && normalized.length > opts.maxLength) {
    normalized = normalized.slice(0, opts.maxLength);
  }

  return {
    text: normalized,
    stats: { originalLength: original.length, normalizedLength: normalized.length }
  };
}
