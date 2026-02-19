'use strict';

const { query } = require('./query');

/**
 * Simple connectivity check.
 * Safe to run now; will just error until DB env vars are provided.
 */
async function main() {
  try {
    const res = await query('SELECT NOW() as now');
    // eslint-disable-next-line no-console
    console.log('DB OK:', res.rows[0]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('DB CHECK FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}

main();
