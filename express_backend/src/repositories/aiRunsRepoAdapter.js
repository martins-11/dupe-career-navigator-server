import pgRepo from './aiRunsRepo.js';
import mysqlRepo from './mysql/aiRunsRepo.mysql.js';
import memRepo from './memory/aiRunsMemoryRepo.js';
import { getDbEngine, isDbConfigured, isPostgresConfigured, isMysqlConfigured } from '../db/connection.js';

/**
 * AI Runs repository adapter:
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
export function isDbConfiguredPublic() {
  /** Returns true if configured DB engine appears configured. */
  return isDbConfigured();
}

// PUBLIC_INTERFACE
export async function createAiRun(input) {
  /** Create an AI run using configured persistence (memory by default). */
  return _repo().createAiRun(input);
}

// PUBLIC_INTERFACE
export async function getAiRunById(aiRunId) {
  /** Get AI run by id using configured persistence (memory by default). */
  return _repo().getAiRunById(aiRunId);
}

// PUBLIC_INTERFACE
export async function updateAiRun(aiRunId, patch) {
  /** Update AI run using configured persistence (memory by default). */
  return _repo().updateAiRun(aiRunId, patch);
}

// PUBLIC_INTERFACE
export async function listAiRunsByBuildId(buildId) {
  /** List AI runs for a build using configured persistence (memory by default). */
  return _repo().listAiRunsByBuildId(buildId);
}

// PUBLIC_INTERFACE
export default {
  isDbConfigured: isDbConfiguredPublic,
  createAiRun,
  getAiRunById,
  updateAiRun,
  listAiRunsByBuildId
};
