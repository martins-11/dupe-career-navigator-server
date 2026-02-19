'use strict';

const pgRepo = require('./aiRunsRepo');
const memRepo = require('./memory/aiRunsMemoryRepo');

/**
 * AI Runs repository adapter:
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
async function createAiRun(input) {
  /** Create an AI run using configured persistence (memory by default). */
  return _repo().createAiRun(input);
}

// PUBLIC_INTERFACE
async function getAiRunById(aiRunId) {
  /** Get AI run by id using configured persistence (memory by default). */
  return _repo().getAiRunById(aiRunId);
}

// PUBLIC_INTERFACE
async function updateAiRun(aiRunId, patch) {
  /** Update AI run using configured persistence (memory by default). */
  return _repo().updateAiRun(aiRunId, patch);
}

// PUBLIC_INTERFACE
async function listAiRunsByBuildId(buildId) {
  /** List AI runs for a build using configured persistence (memory by default). */
  return _repo().listAiRunsByBuildId(buildId);
}

module.exports = {
  isDbConfigured,
  createAiRun,
  getAiRunById,
  updateAiRun,
  listAiRunsByBuildId
};
