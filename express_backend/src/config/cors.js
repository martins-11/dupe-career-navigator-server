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

  const allowedHeaders = (process.env.ALLOWED_HEADERS || 'Content-Type,Authorization')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedMethods = (process.env.ALLOWED_METHODS || 'GET,POST,PUT,DELETE,OPTIONS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxAge = Number(process.env.CORS_MAX_AGE || 3600);

  return {
    origin: (origin, cb) => {
      // Allow non-browser clients or same-origin
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: allowedMethods,
    allowedHeaders,
    maxAge,
    credentials: true
  };
}

module.exports = { buildCorsOptions };
