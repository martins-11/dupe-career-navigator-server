'use strict';

const { query } = require('./query');

/**
 * Simple connectivity check.
 * Safe to run now; will just error until DB env vars are provided.
 */
async function main() {
  try {
    // Non-destructive connectivity check, safe for MySQL and Postgres.
    const res = await query('SELECT 1 as ok');
    // eslint-disable-next-line no-console
    console.log('DB OK:', res && res.rows && res.rows[0] ? res.rows[0] : res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('DB CHECK FAILED:', err && err.message ? err.message : err);
    if (err && err.cause && err.cause.message) {
      // eslint-disable-next-line no-console
      console.error('CAUSE:', err.cause.message);
    }
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}

main();
