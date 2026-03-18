import { uuidV4 } from '../../utils/uuid.js';

/**
 * In-memory AI runs repository.
 *
 * Tracks AI run attempts (even placeholder) so workflows can record progress without a DB.
 * Shape mirrors aiRunsRepo.js scaffold.
 */

const _aiRuns = new Map(); // id -> run
const _runsByBuildId = new Map(); // buildId -> ids[]

function _nowIso() {
  return new Date().toISOString();
}

// PUBLIC_INTERFACE
export async function createAiRun(input) {
  /** Create an AI run record in memory and return it. */
  const id = uuidV4();
  const now = _nowIso();

  const run = {
    id,
    buildId: input.buildId ?? null,
    personaId: input.personaId ?? null,
    status: input.status ?? 'running',
    provider: input.provider ?? 'placeholder',
    model: input.model ?? null,
    request: input.request ?? {},
    response: Object.prototype.hasOwnProperty.call(input, 'response') ? input.response : null,
    error: Object.prototype.hasOwnProperty.call(input, 'error') ? input.error : null,
    createdAt: now,
    updatedAt: now
  };

  _aiRuns.set(id, run);

  if (run.buildId) {
    const arr = _runsByBuildId.get(run.buildId) || [];
    arr.push(id);
    _runsByBuildId.set(run.buildId, arr);
  }

  return run;
}

// PUBLIC_INTERFACE
export async function getAiRunById(aiRunId) {
  /** Fetch AI run by id (memory). Returns null if not found. */
  return _aiRuns.get(aiRunId) || null;
}

// PUBLIC_INTERFACE
export async function updateAiRun(aiRunId, patch) {
  /** Update an AI run record (memory). Returns updated run or null if not found. */
  const existing = _aiRuns.get(aiRunId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...patch,
    response: Object.prototype.hasOwnProperty.call(patch, 'response') ? (patch.response ?? null) : existing.response,
    error: Object.prototype.hasOwnProperty.call(patch, 'error') ? (patch.error ?? null) : existing.error,
    updatedAt: _nowIso()
  };

  _aiRuns.set(aiRunId, updated);
  return updated;
}

// PUBLIC_INTERFACE
export async function listAiRunsByBuildId(buildId) {
  /** List AI runs for a build (ascending by creation). */
  const ids = _runsByBuildId.get(buildId) || [];
  return ids.map((id) => _aiRuns.get(id)).filter(Boolean);
}

const aiRunsMemoryRepo = { createAiRun, getAiRunById, updateAiRun, listAiRunsByBuildId };
export default aiRunsMemoryRepo;
