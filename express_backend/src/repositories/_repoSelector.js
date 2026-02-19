'use strict';

const { getDbEngine, isDbConfigured, isPostgresConfigured, isMysqlConfigured } = require('../db/connection');

/**
 * Shared repository selection helper for adapters.
 *
 * Priority:
 * - If DB_ENGINE=mysql (default): use MySQL repo only when MYSQL_* env vars are present.
 * - If DB_ENGINE=postgres: use Postgres repo only when PG_* env vars are present.
 * - Otherwise: fall back to in-memory repository.
 *
 * IMPORTANT:
 * - Ensures service can run without any DB credentials.
 * - Keeps PostgreSQL scaffolding intact (do NOT remove PG repositories).
 */

/**
 * PUBLIC_INTERFACE
 * Selects the active repository implementation for the configured DB engine.
 *
 * @param {object} deps
 * @param {object} deps.pgRepo Postgres repository implementation
 * @param {object} deps.mysqlRepo MySQL repository implementation
 * @param {object} deps.memRepo In-memory repository implementation
 * @returns {object} The chosen repository implementation
 */
function selectRepo({ pgRepo, mysqlRepo, memRepo }) {
  const engine = getDbEngine();

  if (engine === 'mysql') {
    return isDbConfigured() && isMysqlConfigured() ? mysqlRepo : memRepo;
  }

  // postgres
  return isDbConfigured() && isPostgresConfigured() ? pgRepo : memRepo;
}

module.exports = { selectRepo };

