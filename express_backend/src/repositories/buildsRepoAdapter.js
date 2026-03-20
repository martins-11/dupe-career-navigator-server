import pgRepo from './buildsRepo.js';
import mysqlRepo from './mysql/buildsRepo.mysql.js';
import memRepo from './memory/buildsMemoryRepo.js';
import { getDbEngine, isDbConfigured, isPostgresConfigured, isMysqlConfigured } from '../db/connection.js';

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
export function isDbConfiguredPublic() {
  /** Returns true if configured DB engine appears configured. */
  return isDbConfigured();
}

// PUBLIC_INTERFACE
export async function createBuild(input) {
  /** Create a build using configured persistence (memory by default). */
  return _repo().createBuild(input);
}

// PUBLIC_INTERFACE
export async function getBuildById(buildId) {
  /** Get build by id using configured persistence (memory by default). */
  return _repo().getBuildById(buildId);
}

// PUBLIC_INTERFACE
export async function updateBuild(buildId, patch) {
  /** Update build using configured persistence (memory by default). */
  return _repo().updateBuild(buildId, patch);
}

// PUBLIC_INTERFACE
export async function linkDocumentToBuild(buildId, documentId) {
  /** Link a single document to a build if supported by the active repo; otherwise no-op. */
  const repo = _repo();
  if (typeof repo.linkDocumentToBuild !== 'function') return { linked: false };
  return repo.linkDocumentToBuild(buildId, documentId);
}

// PUBLIC_INTERFACE
export async function linkDocumentsToBuild(buildId, documentIds) {
  /** Link multiple documents to a build if supported by the active repo; otherwise no-op. */
  const repo = _repo();
  if (typeof repo.linkDocumentsToBuild === 'function') return repo.linkDocumentsToBuild(buildId, documentIds);
  if (typeof repo.linkDocumentToBuild !== 'function') return { linked: false, count: 0 };

  const ids = Array.isArray(documentIds) ? documentIds.filter(Boolean) : [];
  let linkedCount = 0;

  // eslint-disable-next-line no-await-in-loop
  for (const documentId of ids) {
    const res = await repo.linkDocumentToBuild(buildId, documentId);
    if (res && res.linked) linkedCount += 1;
  }
  return { linked: linkedCount > 0, count: linkedCount };
}

// PUBLIC_INTERFACE
export default {
  isDbConfigured: isDbConfiguredPublic,
  createBuild,
  getBuildById,
  updateBuild,
  linkDocumentToBuild,
  linkDocumentsToBuild
};
