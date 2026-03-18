'use strict';

/**
 * Build CORS options from environment variables already present in the container .env.
 */

/**
 * PUBLIC_INTERFACE
 * buildCorsOptions
 *
 * Builds the CORS options used by the Express app.
 *
 * Design goals:
 * - Be strict when an allowlist is explicitly provided.
 * - Be robust in Kavia preview environments where the vscode-internal hostname changes.
 * - Always allow localhost:3000 for local dev.
 * - Always allow the configured FRONTEND_URL origin when present.
 */
function buildCorsOptions() {
  /** Build CORS options used by the Express app. */

  // If ALLOWED_ORIGINS is set, we enforce it (plus additive safe origins below).
  // If it is NOT set, we default to permissive behavior for dev/preview friendliness.
  const originsRaw = (process.env.ALLOWED_ORIGINS || '').trim();
  const allowlistEnabled = originsRaw.length > 0;

  const allowedOrigins = originsRaw
    ? originsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Always allow local frontend dev origin (explicit requirement).
  if (!allowedOrigins.includes('http://localhost:3000')) {
    allowedOrigins.push('http://localhost:3000');
  }

  // Also allow the active frontend origin derived from FRONTEND_URL.
  // This prevents stale ALLOWED_ORIGINS values from breaking the preview.
  try {
    const frontendUrl = (process.env.FRONTEND_URL || '').trim();
    if (frontendUrl) {
      const frontendOrigin = new URL(frontendUrl).origin;
      if (!allowedOrigins.includes(frontendOrigin)) {
        allowedOrigins.push(frontendOrigin);
      }
    }
  } catch {
    // Ignore invalid FRONTEND_URL
  }

  const allowedHeaders = (process.env.ALLOWED_HEADERS || 'Content-Type,Authorization')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedMethods = (process.env.ALLOWED_METHODS || 'GET,POST,PUT,DELETE,OPTIONS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxAge = Number(process.env.CORS_MAX_AGE || 3600);

  // Allow dynamic Kavia preview origins for the frontend (port 3000).
  // Observed examples:
  //   https://vscode-internal-17827.cloud.kavia.ai:3000
  //   https://vscode-internal-17827-beta.beta01.cloud.kavia.ai:3000
  const kaviaPreviewFrontendOriginRe =
    /^https:\/\/vscode-internal-[a-z0-9-]+(?:-beta\.beta01)?\.cloud\.kavia\.ai:3000$/i;

  return {
    origin: (origin, cb) => {
      // Allow non-browser clients (curl/postman/server-to-server) or same-origin
      if (!origin) return cb(null, true);

      // If no explicit allowlist is configured, be permissive.
      if (!allowlistEnabled) return cb(null, true);

      // Explicit allowlist (env + localhost + FRONTEND_URL-derived)
      if (allowedOrigins.includes(origin)) return cb(null, true);

      // Dynamic preview allowlist
      if (kaviaPreviewFrontendOriginRe.test(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: allowedMethods,
    allowedHeaders,
    maxAge,
    credentials: true,
  };
}

module.exports = { buildCorsOptions };
