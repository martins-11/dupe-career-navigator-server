'use strict';

/**
 * Verify roles seed data via application DB driver (no MySQL CLI).
 *
 * Uses the same env-driven DB connection as the backend (src/db/connection.js),
 * and runs:
 *   SELECT role_title, industry FROM roles LIMIT 5;
 *
 * Usage:
 *   node scripts/verify-roles.js
 *
 * Exit codes:
 *   0 = success (printed rows)
 *   2 = DB not configured
 *   1 = failure (connect/query error)
 */

const path = require('path');

// Load env vars from express_backend/.env regardless of CWD (matches server.js behavior)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { isDbConfigured, getDbEngine, dbQuery, dbClose } = require('../src/db/connection');

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
            'DB env vars not detected. Configure MySQL connection env vars (see scripts/test-db.js for expected names).'
        },
        null,
        2
      )
    );
    process.exitCode = 2;
    return;
  }

  try {
    const res = await dbQuery('SELECT role_title, industry FROM roles LIMIT 5;');

    console.log(
      JSON.stringify(
        {
          ok: true,
          engine,
          query: 'SELECT role_title, industry FROM roles LIMIT 5;',
          rows: res?.rows || [],
          rowCount: Array.isArray(res?.rows) ? res.rows.length : 0
        },
        null,
        2
      )
    );
    process.exitCode = 0;
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          engine,
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
