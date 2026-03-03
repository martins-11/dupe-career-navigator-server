'use strict';

/**
 * Quick verification: run a roles search query and print results.
 *
 * Usage:
 *   node scripts/verify-roles-search.js
 *
 * Notes:
 * - Requires DB configured (DB_ENGINE=mysql + MYSQL_* env vars).
 * - This script is intentionally simple and uses the repository adapter.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const rolesRepo = require('../src/repositories/rolesRepoAdapter');

async function main() {
  const q = process.argv[2] || 'Senior Product Manager';
  const res = await rolesRepo.searchRoles({ q, limit: 10 });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ q, count: res.length, results: res }, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[verify-roles-search] failed:', e);
  process.exitCode = 1;
});
