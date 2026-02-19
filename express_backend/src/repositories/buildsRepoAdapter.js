'use strict';

const pgRepo = require('./buildsRepo');
const memRepo = require('./memory/buildsMemoryRepo');

/**
 * Builds repository adapter:
 * - Uses in-memory persistence by default
 * - Uses Postgres implementation when env vars are configured
 *
 * Keeps services runnable without DB credentials while preserving Postgres scaffolding for RDS.
 */

function _isDbConfigured() {
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

function _repo() {
  return _isDbConfigured() ? pgRepo : memRepo;
}

// PUBLIC_INTERFACE
function isDbConfigured() {
  /** Returns true if PostgreSQL appears configured. */
  return _isDbConfigured();
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
  isDbConfigured,
  createBuild,
  getBuildById,
  updateBuild
};
