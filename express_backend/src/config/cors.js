'use strict';

/**
 * Build CORS options from environment variables already present in the container .env.
 */

// PUBLIC_INTERFACE
function buildCorsOptions() {
  /** Build CORS options used by the Express app. */
  const originsRaw = process.env.ALLOWED_ORIGINS || '';
  const allowedOrigins = originsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Always allow local frontend dev origin (explicit requirement).
  // This is additive; if ALLOWED_ORIGINS is set, localhost:3000 will still be allowed.
  if (!allowedOrigins.includes('http://localhost:3000')) {
    allowedOrigins.push('http://localhost:3000');
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
  //
  // We accept both host shapes.
  const kaviaPreviewFrontendOriginRe =
    /^https:\/\/vscode-internal-[a-z0-9-]+(?:\.beta\.beta01)?\.cloud\.kavia\.ai:3000$/i;

  return {
    origin: (origin, cb) => {
      // Allow non-browser clients or same-origin
      if (!origin) return cb(null, true);

      // If ALLOWED_ORIGINS isn't set, default to permissive behavior
      // (useful for internal tooling / non-browser clients).
      if (allowedOrigins.length === 0) return cb(null, true);

      // Explicit allowlist (env + localhost)
      if (allowedOrigins.includes(origin)) return cb(null, true);

      // Dynamic preview allowlist
      if (kaviaPreviewFrontendOriginRe.test(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: allowedMethods,
    allowedHeaders,
    maxAge,
    credentials: true
  };
}

module.exports = { buildCorsOptions };
