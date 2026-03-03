'use strict';

/**
 * Temporary live DB connectivity script.
 *
 * Attempts to run a trivial `SELECT 1 as ok` query using the same env-driven
 * configuration as the backend (src/db/connection.js).
 *
 * Usage:
 *   node scripts/test-db.js
 *
 * Exit codes:
 *   0 = success
 *   2 = DB not configured
 *   1 = failure (connect/query error)
 */

const path = require('path');

// Load env vars from express_backend/.env regardless of CWD (matches server.js behavior)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { isDbConfigured, getDbEngine, dbQuery, dbClose } = require('../src/db/connection');

function nowMs() {
  return Date.now();
}

async function main() {
  const engine = getDbEngine();

  if (!isDbConfigured()) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          engine,
          error: 'DB_NOT_CONFIGURED',
          message:
            'DB env vars not detected. Set MYSQL_CONNECTION_STRING or MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE (or DB_* aliases).'
        },
        null,
        2
      )
    );
    process.exitCode = 2;
    return;
  }

  const start = nowMs();
  try {
    const res = await dbQuery('SELECT 1 as ok');
    const latencyMs = nowMs() - start;

    console.log(
      JSON.stringify(
        {
          ok: true,
          engine,
          latencyMs,
          result: res?.rows?.[0] ?? null
        },
        null,
        2
      )
    );
    process.exitCode = 0;
  } catch (err) {
    const latencyMs = nowMs() - start;

    console.error(
      JSON.stringify(
        {
          ok: false,
          engine,
          latencyMs,
          error: err?.code || 'DB_ERROR',
          message: err?.message || String(err),
          cause: err?.cause ? { message: err.cause.message, code: err.cause.code } : null
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await dbClose();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: 'UNHANDLED', message: e?.message || String(e) }, null, 2));
  process.exitCode = 1;
});
