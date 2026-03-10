'use strict';

/**
 * Helpers for propagating Bedrock errors to API consumers in a safe, consistent way.
 *
 * This is meant to solve a specific failure mode observed in logs:
 * routes were taking ~12–17s (Bedrock invoked) yet returning `[]` with HTTP 200,
 * which hid the failure from the UI and made debugging difficult.
 */

/**
 * PUBLIC_INTERFACE
 * Build a safe error meta payload from a thrown error or a Bedrock "safe wrapper" result.
 *
 * Notes:
 * - Do not include prompts or full raw model outputs (may be sensitive / huge).
 * - Include error code/message + minimal details if present.
 *
 * @param {unknown} err
 * @param {object} [extra]
 * @returns {{ code: string, message: string, details?: object, requestId?: string, modelId?: string }}
 */
function buildBedrockErrorMeta(err, extra = {}) {
  const code =
    (err && typeof err === 'object' && typeof err.code === 'string' && err.code) ||
    (err && typeof err === 'object' && typeof err.name === 'string' && err.name) ||
    'BEDROCK_FAILED';

  const message =
    (err && typeof err === 'object' && typeof err.message === 'string' && err.message) ||
    'Bedrock request failed';

  // Prefer err.details when present, but keep it shallow and reasonably sized.
  const details =
    err && typeof err === 'object' && err.details && typeof err.details === 'object' ? err.details : undefined;

  const meta = {
    code,
    message,
  };

  // Attach non-sensitive known fields.
  if (details && Object.keys(details).length) meta.details = details;
  if (extra && typeof extra === 'object') {
    if (typeof extra.requestId === 'string') meta.requestId = extra.requestId;
    if (typeof extra.modelId === 'string') meta.modelId = extra.modelId;
  }

  return meta;
}

/**
 * PUBLIC_INTERFACE
 * Extract Bedrock error meta from the bedrockService.generateTargetedRolesSafe(...) return shape.
 *
 * @param {object} safeResult
 * @returns {null | { code: string, message: string, details?: object, modelId?: string }}
 */
function bedrockErrorMetaFromSafeResult(safeResult) {
  if (!safeResult || typeof safeResult !== 'object') return null;

  // bedrockService.generateTargetedRolesSafe returns `error: { code, message }` in both strict and fallback paths.
  const errObj = safeResult.error && typeof safeResult.error === 'object' ? safeResult.error : null;
  if (!errObj) return null;

  const code = typeof errObj.code === 'string' && errObj.code ? errObj.code : 'BEDROCK_FAILED';
  const message = typeof errObj.message === 'string' && errObj.message ? errObj.message : 'Bedrock request failed';

  const meta = { code, message };
  if (typeof safeResult.modelId === 'string') meta.modelId = safeResult.modelId;

  return meta;
}

module.exports = {
  buildBedrockErrorMeta,
  bedrockErrorMetaFromSafeResult,
};
