import { uuidV4 } from '../../utils/uuid.js';

/**
 * In-memory builds repository.
 *
 * Mirrors the response shape of the Postgres scaffold (buildsRepo.js) so that
 * services/routes can remain stable when switching adapters.
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _builds = new Map(); // buildId -> build record

function _nowIso() {
  return new Date().toISOString();
}

function _makeBuild(input) {
  // IMPORTANT:
  // The workflow layer generates the canonical id; memory repo must honor a caller-provided id
  // so that buildId used by /builds/* and /orchestration/* is stable and debuggable.
  const id = input?.id || uuidV4();
  const now = _nowIso();

  return {
    id,
    personaId: input.personaId ?? null,
    documentId: input.documentId ?? null,
    status: input.status ?? 'queued',
    progress: input.progress ?? 0,
    message: input.message ?? null,
    currentStep: input.currentStep ?? null,
    steps: Array.isArray(input.steps) ? input.steps : [],
    createdAt: now,
    updatedAt: now
  };
}

// PUBLIC_INTERFACE
export async function createBuild(input) {
  /** Create a build record in memory and return it. */
  const build = _makeBuild(input || {});
  _builds.set(build.id, build);
  return build;
}

// PUBLIC_INTERFACE
export async function getBuildById(buildId) {
  /** Fetch build by id (memory). Returns null if not found. */
  return _builds.get(buildId) || null;
}

// PUBLIC_INTERFACE
export async function updateBuild(buildId, patch) {
  /** Update mutable build fields (memory). Returns updated build or null if not found. */
  const existing = _builds.get(buildId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...patch,
    // Normalize known nullable fields
    message: Object.prototype.hasOwnProperty.call(patch, 'message') ? (patch.message ?? null) : existing.message,
    currentStep: Object.prototype.hasOwnProperty.call(patch, 'currentStep')
      ? (patch.currentStep ?? null)
      : existing.currentStep,
    steps: Object.prototype.hasOwnProperty.call(patch, 'steps') ? (patch.steps ?? []) : existing.steps,
    updatedAt: _nowIso()
  };

  _builds.set(buildId, updated);
  return updated;
}

/**
 * PUBLIC_INTERFACE
 * Best-effort build-document linking in memory.
 *
 * In memory mode we don't need persistence for linking (orchestration stores it),
 * but exposing these methods keeps interfaces consistent across repo adapters.
 */
export async function linkDocumentToBuild(_buildId, _documentId) {
  return { linked: false };
}

/**
 * PUBLIC_INTERFACE
 * Best-effort build-documents linking in memory.
 */
export async function linkDocumentsToBuild(_buildId, _documentIds) {
  return { linked: false, count: Array.isArray(_documentIds) ? _documentIds.length : 0 };
}

const buildsMemoryRepo = {
  createBuild,
  getBuildById,
  updateBuild,
  linkDocumentToBuild,
  linkDocumentsToBuild
};
export default buildsMemoryRepo;
