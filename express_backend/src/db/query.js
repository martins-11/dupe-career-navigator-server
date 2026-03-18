/**
 * Small query helper that standardizes errors and keeps callsites concise.
 *
 * NOTE: This uses the engine-agnostic dbQuery() helper so the codebase can
 * support MySQL (AWS RDS) as primary while preserving Postgres scaffolding.
 */

import { dbQuery } from './connection.js';

/**
 * PUBLIC_INTERFACE
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<{rows: any[]}>}
 */
export async function query(text, params) {
  /** Execute a SQL query using the configured DB engine. */
  return await dbQuery(text, params || []);
}
