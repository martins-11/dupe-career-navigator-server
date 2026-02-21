'use strict';

const { dbQuery } = require('./connection');

/**
 * Small query helper that standardizes errors and keeps callsites concise.
 *
 * NOTE: This uses the engine-agnostic dbQuery() helper so the codebase can
 * support MySQL (AWS RDS) as primary while preserving Postgres scaffolding.
 */

// PUBLIC_INTERFACE
async function query(text, params) {
  /** Execute a SQL query using the configured DB engine. */
  return await dbQuery(text, params || []);
}

module.exports = { query };
