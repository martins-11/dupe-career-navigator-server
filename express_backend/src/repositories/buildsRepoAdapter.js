'use strict';

const pgRepo = require('./buildsRepo');
const mysqlRepo = require('./mysql/buildsRepo.mysql');
const memRepo = require('./memory/buildsMemoryRepo');
const { getDbEngine, isDbConfigured, isPostgresConfigured, isMysqlConfigured } = require('../db/connection');

/**
 * Builds repository adapter:
 * - Uses in-memory persistence by default
 * - Uses MySQL implementation when configured (default engine)
 * - Can use Postgres implementation when DB_ENGINE=postgres and configured
 *
 * Keeps services runnable without DB credentials while preserving DB scaffolding.
 */

function _repo() {
  const engine = getDbEngine();

  if (engine === 'mysql') {
    return isDbConfigured() && isMysqlConfigured() ? mysqlRepo : memRepo;
  }

  return isDbConfigured() && isPostgresConfigured() ? pgRepo : memRepo;
}

// PUBLIC_INTERFACE
function isDbConfiguredPublic() {
  /** Returns true if configured DB engine appears configured. */
  return isDbConfigured();
}

// PUBLIC_INTERFACE
async function createBuild(input) {
  /** Create a build using configured persistence (memory by default). */
  return _repo().createBuild(input);
}

// PUBLIC_INTERFACE
async function getBuildById(buildId) {
  /** Get build by id using configured persistence (memory by default). */
  return _repo().getBuildById(buildId);
}

// PUBLIC_INTERFACE
async function updateBuild(buildId, patch) {
  /** Update build using configured persistence (memory by default). */
  return _repo().updateBuild(buildId, patch);
}

module.exports = {
  isDbConfigured: isDbConfiguredPublic,
  createBuild,
  getBuildById,
  updateBuild
};
