'use strict';

const { uuidV4 } = require('../../utils/uuid');

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
  const id = uuidV4();
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
async function createBuild(input) {
  /** Create a build record in memory and return it. */
  const build = _makeBuild(input || {});
  _builds.set(build.id, build);
  return build;
}

// PUBLIC_INTERFACE
async function getBuildById(buildId) {
  /** Fetch build by id (memory). Returns null if not found. */
  return _builds.get(buildId) || null;
}

// PUBLIC_INTERFACE
async function updateBuild(buildId, patch) {
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

module.exports = {
  createBuild,
  getBuildById,
  updateBuild
};
