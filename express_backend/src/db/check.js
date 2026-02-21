'use strict';

const path = require('path');
const dotenv = require('dotenv');

/**
 * Ensure environment variables are loaded from express_backend/.env even when
 * the script is executed with a different working directory (common in CI).
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { getDbEngine, isDbConfigured, dbQuery, dbClose } = require('./connection');

function _safeConnDiagnostics() {
  const engine = getDbEngine();

  // Prefer DB_* when present (as requested), otherwise fall back to MYSQL_*/PG*.
  const host =
    process.env.DB_HOST ||
    process.env.MYSQL_HOST ||
    process.env.PGHOST ||
    '(not set)';

  const port =
    process.env.DB_PORT ||
    process.env.MYSQL_PORT ||
    process.env.PGPORT ||
    '(not set)';

  const database =
    process.env.DB_NAME ||
    process.env.MYSQL_DATABASE ||
    process.env.PGDATABASE ||
    '(not set)';

  const user =
    process.env.DB_USERNAME ||
    process.env.MYSQL_USER ||
    process.env.PGUSER ||
    '(not set)';

  return { engine, host, port, database, user };
}

/**
 * Simple connectivity check.
 * Non-destructive (SELECT 1) and safe to run.
 */
async function main() {
  const diag = _safeConnDiagnostics();

  // eslint-disable-next-line no-console
  console.log(
    `[db:check] engine=${diag.engine} host=${diag.host} port=${diag.port} db=${diag.database} user=${diag.user}`
  );

  if (!isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.error(
      '[db:check] DB is not configured. Set DB_ENGINE and DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD (or MYSQL_* / PG* equivalents) in express_backend/.env'
    );
    process.exitCode = 1;
    return;
  }

  try {
    const res = await dbQuery('SELECT 1 as ok');
    const okVal = res && res.rows && res.rows[0] ? res.rows[0] : res;

    // eslint-disable-next-line no-console
    console.log('[db:check] DB OK:', okVal);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db:check] DB CHECK FAILED:', err && err.message ? err.message : err);
    if (err && err.cause && err.cause.message) {
      // eslint-disable-next-line no-console
      console.error('[db:check] CAUSE:', err.cause.message);
    }
    process.exitCode = 1;
  } finally {
    await dbClose();
  }
}

main();
