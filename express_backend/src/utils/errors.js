/* eslint-disable no-console */

/**
 * Shared error helpers for consistent API error responses.
 *
 * ErrorResponse schema (OpenAPI):
 * {
 *   error: string,
 *   message?: string | null,
 *   details?: object | null
 * }
 */

/**
 * Convert a thrown error into a standardized ErrorResponse payload.
 *
 * - Never throws.
 * - Avoids leaking sensitive info by default.
 */
function _toErrorResponse(err, fallbackCode, fallbackMessage) {
  const message =
    err && typeof err.message === 'string'
      ? err.message
      : fallbackMessage || 'An unexpected error occurred.';

  const errorCode =
    (err && typeof err.error === 'string' && err.error) ||
    (err && typeof err.code === 'string' && err.code) ||
    fallbackCode ||
    'internal_server_error';

  const details =
    err && typeof err.details === 'object' && err.details !== null ? err.details : null;

  return {
    error: errorCode,
    message: message || null,
    details
  };
}

/**
 * Best-effort extraction of Zod error details in a stable shape.
 */
function _zodDetails(zodErr) {
  try {
    if (typeof zodErr.flatten === 'function') return zodErr.flatten();
  } catch (_) {
    // ignore
  }
  // Fallback: preserve issues array if present
  if (Array.isArray(zodErr.issues)) return { issues: zodErr.issues };
  return null;
}

/**
 * Maps known error types/codes to an HTTP status consistent with OpenAPI:
 * 400 / 404 / 422 / 500.
 *
 * - 400: request validation / bad request (e.g. Zod input parse failures)
 * - 404: resource not found
 * - 422: domain/semantic validation failures (request is well-formed but cannot be processed)
 * - 500: internal errors
 */
function _statusForError(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;

  if (err && err.name === 'ZodError') return 400;

  // Explicit not-found mapping
  if (code === 'NOT_FOUND') return 404;

  // Domain/semantic validation errors (unprocessable entity)
  if (
    code === 'NO_DOCUMENTS' ||
    code === 'NO_EXTRACTED_TEXT' ||
    code === 'NO_SOURCE_TEXT' ||
    code === 'NO_DRAFT' ||
    code === 'INVALID_WORKFLOW_TRANSITION'
  ) {
    return 422;
  }

  /**
   * Bedrock / upstream dependency error mapping.
   *
   * Why:
   * - /api/recommendations/initial runs in strict mode (no fallback) by design.
   * - Many Bedrock failures are *not* programmer bugs and should not look like opaque 500s.
   * - We still return a 5xx, but with a consistent ErrorResponse JSON and a more accurate status:
   *   - 503 for missing configuration needed to reach Bedrock
   *   - 502 for Bedrock output/availability problems
   */
  if (code === 'missing_aws_region') return 503;

  // Bedrock timeout should map to gateway timeout.
  if (code === 'bedrock_timeout') return 504;

  // Common “bedrock_*” codes thrown by bedrockService parsing/validation.
  if (typeof code === 'string' && (code.startsWith('bedrock_') || code.startsWith('BEDROCK_'))) {
    return 502;
  }

  // Route/service-level contract violation but still an upstream/generation failure.
  if (code === 'initial_recommendations_invalid_count') return 502;

  // Allow route/service to specify httpStatus directly (kept narrow + controlled)
  if (err && Number.isInteger(err.httpStatus) && [400, 404, 422, 500].includes(err.httpStatus)) {
    return err.httpStatus;
  }

  // Default internal
  return 500;
}

/**
 * PUBLIC_INTERFACE
 * Send a standardized ErrorResponse JSON with an OpenAPI-aligned status code.
 *
 * @param {import('express').Response} res
 * @param {unknown} err
 * @param {{ defaultStatus?: 400|404|422|500, defaultErrorCode?: string }} [opts]
 * @returns {import('express').Response}
 */
export function sendError(res, err, opts = {}) {
  const status = _statusForError(err) || opts.defaultStatus || 500;

  // Shape the payload based on error type
  if (err && err.name === 'ZodError') {
    const details = _zodDetails(err);
    return res.status(400).json({
      error: 'validation_error',
      message: 'Request validation failed.',
      details
    });
  }

  if (status === 404) {
    // If caller didn't provide a message, keep it generic.
    const payload = _toErrorResponse(err, 'not_found', 'Not found.');
    return res.status(404).json(payload);
  }

  if (status === 422) {
    const payload = _toErrorResponse(err, 'validation_error', 'Unprocessable entity.');
    // Ensure OpenAPI ErrorResponse fields exist consistently.
    return res.status(422).json(payload);
  }

  if (status === 400) {
    const payload = _toErrorResponse(err, 'validation_error', 'Bad request.');
    return res.status(400).json(payload);
  }

  /**
   * Upstream dependency failures (Bedrock, etc).
   * These should not be reported as generic 500s because:
   * - they are often configuration/runtime issues (region/model access/throttle)
   * - callers need actionable details (requestId, validation stats) to debug
   */
  if (status === 502) {
    const payload = _toErrorResponse(err, 'bad_gateway', 'Upstream dependency returned an invalid response.');
    return res.status(502).json(payload);
  }

  if (status === 503) {
    const payload = _toErrorResponse(err, 'service_unavailable', 'Upstream dependency is unavailable.');
    return res.status(503).json(payload);
  }

  if (status === 504) {
    const payload = _toErrorResponse(err, 'gateway_timeout', 'Upstream dependency timed out.');
    return res.status(504).json(payload);
  }

  // 500
  const payload = _toErrorResponse(err, 'internal_server_error', 'Internal server error.');
  return res.status(500).json(payload);
}


