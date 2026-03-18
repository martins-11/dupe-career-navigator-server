import buildsRepo from '../repositories/buildsRepoAdapter.js';
import workflowService from './workflowService.js';
import buildsMemoryRepo from '../repositories/memory/buildsMemoryRepo.js';

/**
 * Build/workflow service.
 *
 * Refactor goal:
 * - Persist build records via a repository adapter (memory by default, Postgres when configured)
 * - Keep existing workflowService for status simulation/state machine
 * - Avoid requiring DB credentials for runtime
 */

/**
 * @typedef {Object} BuildRecord
 * @property {string} id
 * @property {string|null} personaId
 * @property {string|null} documentId
 * @property {string} status - queued|running|succeeded|failed|cancelled
 * @property {number} progress - 0..100
 * @property {string|null} message
 * @property {string[]} steps
 * @property {string|null} currentStep
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

// PUBLIC_INTERFACE
function isDbConfiguredForBuilds() {
  /** Returns true if PostgreSQL appears configured for builds persistence. */
  return buildsRepo.isDbConfigured();
}

function _defaultSteps() {
  return ['validate_inputs', 'extract_text', 'normalize_text', 'generate_persona_draft', 'finalize'];
}

async function _syncFromWorkflow(buildId) {
  /**
   * Internal helper: best-effort sync from workflow state -> build repo record.
   * This keeps repo state coherent even if workflowService is the primary driver.
   */
  const wf = workflowService.getWorkflow(buildId);
  if (!wf) return null;

  const patch = {
    status: wf.status,
    progress: wf.progress,
    message: wf.message ?? null,
    currentStep: wf.currentStep ?? null,
    steps: wf.steps ?? _defaultSteps()
  };

  return buildsRepo.updateBuild(buildId, patch);
}

// PUBLIC_INTERFACE
async function createBuild(input) {
  /**
   * Create a build/workflow:
   * - creates workflow record and starts simulation
   * - creates build record in persistence adapter
   *
   * Degraded mode:
   * - If input.forceMemory=true, skips DB-backed adapters and persists in memory only.
   *   This is used by the /builds route to avoid crashing when DB is configured
   *   but temporarily unreachable.
   *
   * @param {{ personaId?: string|null, documentId?: string|null, mode?: string|null, forceMemory?: boolean }} input
   * @returns {Promise<BuildRecord>}
   */
  const wf = workflowService.createWorkflow({
    personaId: input.personaId ?? null,
    documentId: input.documentId ?? null,
    mode: input.mode ?? null
  });

  // Start workflow simulation (in-memory).
  workflowService.startWorkflow(wf.id);

  // Persist build record (memory by default; DB-backed when configured), but allow forced memory.
  if (input && input.forceMemory) {
    await buildsMemoryRepo.createBuild({
      id: wf.id,
      personaId: wf.personaId,
      documentId: wf.documentId,
      status: wf.status,
      progress: wf.progress,
      message: wf.message,
      currentStep: wf.currentStep,
      steps: wf.steps ?? _defaultSteps()
    });
    return wf;
  }

  await buildsRepo.createBuild({
    id: wf.id, // note: memory repo ignores provided id; postgres scaffold uses generated id; keep stable by updating after create if needed
    personaId: wf.personaId,
    documentId: wf.documentId,
    status: wf.status,
    progress: wf.progress,
    message: wf.message,
    currentStep: wf.currentStep,
    steps: wf.steps ?? _defaultSteps()
  });

  // In case persistence layer generated a different id (Postgres scaffold does), we keep workflow id canonical.
  // For now, buildsRepo implementations are expected to accept the id from workflow in future; memory does already.
  return wf;
}

// PUBLIC_INTERFACE
async function getBuild(buildId) {
  /** Return a build record by id (repo-backed, with workflow sync best-effort). */
  await _syncFromWorkflow(buildId);
  return buildsRepo.getBuildById(buildId);
}

// PUBLIC_INTERFACE
async function getBuildStatus(buildId) {
  /**
   * Return a status projection (or null if not found).
   * Uses workflowService as authoritative for polling-friendly projection.
   */
  const status = workflowService.getWorkflowStatus(buildId);
  if (!status) return null;

  // Best-effort: sync to persistence.
  await _syncFromWorkflow(buildId);

  return status;
}

// PUBLIC_INTERFACE
async function cancelBuild(buildId) {
  /** Cancel an in-progress build. Returns updated status projection or null if not found. */
  const wf = workflowService.cancelWorkflow(buildId);
  if (!wf) return null;

  await _syncFromWorkflow(buildId);
  return workflowService.getWorkflowStatus(buildId);
}

// PUBLIC_INTERFACE
async function linkDocumentToBuild(buildId, documentId) {
  /**
   * Link a single document to a build in persistence, if supported by the active repo.
   *
   * This is intentionally DB-optional: in memory-only mode (or if the repo doesn't implement
   * build-document linking), this function is a no-op and returns { linked: false }.
   *
   * @param {string} buildId
   * @param {string} documentId
   * @returns {Promise<{linked: boolean}>}
   */
  const repo = buildsRepo;

  if (typeof repo.linkDocumentToBuild !== 'function') return { linked: false };

  await repo.linkDocumentToBuild(buildId, documentId);
  return { linked: true };
}

// PUBLIC_INTERFACE
async function linkDocumentsToBuild(buildId, documentIds) {
  /**
   * Link multiple documents to a build in persistence, if supported by the active repo.
   *
   * DB-optional behavior:
   * - If repo implements linkDocumentsToBuild: use it.
   * - Else if repo implements linkDocumentToBuild: call for each.
   * - Else: no-op.
   *
   * @param {string} buildId
   * @param {string[]} documentIds
   * @returns {Promise<{linked: boolean, count: number}>}
   */
  const ids = Array.isArray(documentIds) ? documentIds.filter(Boolean) : [];
  if (ids.length === 0) return { linked: false, count: 0 };

  const repo = buildsRepo;

  if (typeof repo.linkDocumentsToBuild === 'function') {
    await repo.linkDocumentsToBuild(buildId, ids);
    return { linked: true, count: ids.length };
  }

  if (typeof repo.linkDocumentToBuild === 'function') {
    // eslint-disable-next-line no-await-in-loop
    for (const documentId of ids) await repo.linkDocumentToBuild(buildId, documentId);
    return { linked: true, count: ids.length };
  }

  return { linked: false, count: 0 };
}

export {
  isDbConfiguredForBuilds,
  createBuild,
  getBuild,
  getBuildStatus,
  cancelBuild,
  linkDocumentToBuild,
  linkDocumentsToBuild
};

export default {
  isDbConfiguredForBuilds,
  createBuild,
  getBuild,
  getBuildStatus,
  cancelBuild,
  linkDocumentToBuild,
  linkDocumentsToBuild
};
