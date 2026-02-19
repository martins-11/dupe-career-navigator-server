'use strict';

const { uuidV4 } = require('../utils/uuid');

/**
 * In-memory build/workflow service (scaffold).
 *
 * Why in-memory?
 * - This task requires endpoints to exist and be safe without DB credentials.
 * - Persisting build state can be added later (e.g., Postgres table, Redis, queue).
 *
 * This module is intentionally deterministic and side-effect-free beyond process memory.
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

const _builds = new Map();

/**
 * @param {BuildRecord} build
 */
function _setBuild(build) {
  _builds.set(build.id, build);
}

/**
 * @param {string} buildId
 * @returns {BuildRecord|null}
 */
function _getBuild(buildId) {
  return _builds.get(buildId) || null;
}

function _nowIso() {
  return new Date().toISOString();
}

/**
 * Simple progress "simulation": over ~8 seconds goes from queued->running->succeeded.
 * This is only to make polling meaningful for the frontend during scaffolding.
 *
 * @param {string} buildId
 */
function _simulateProgress(buildId) {
  const steps = [
    'validate_inputs',
    'extract_text',
    'normalize_text',
    'generate_persona_draft',
    'finalize'
  ];

  const schedule = [
    { ms: 250, status: 'running', progress: 10, step: steps[0], message: 'Validating inputs…' },
    { ms: 1200, status: 'running', progress: 25, step: steps[1], message: 'Extracting text…' },
    { ms: 2600, status: 'running', progress: 45, step: steps[2], message: 'Normalizing text…' },
    { ms: 4800, status: 'running', progress: 75, step: steps[3], message: 'Generating persona draft…' },
    { ms: 7000, status: 'running', progress: 90, step: steps[4], message: 'Finalizing…' },
    { ms: 8200, status: 'succeeded', progress: 100, step: null, message: 'Build complete.' }
  ];

  for (const item of schedule) {
    setTimeout(() => {
      const b = _getBuild(buildId);
      if (!b) return;
      if (b.status === 'cancelled' || b.status === 'failed' || b.status === 'succeeded') return;

      const updated = {
        ...b,
        status: item.status,
        progress: item.progress,
        currentStep: item.step,
        message: item.message,
        updatedAt: _nowIso()
      };
      _setBuild(updated);
    }, item.ms);
  }
}

// PUBLIC_INTERFACE
function isDbConfiguredForBuilds() {
  /** Returns true if any PostgreSQL connection env var appears to be set. */
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

// PUBLIC_INTERFACE
function createBuild(input) {
  /**
   * Create a build/workflow (in-memory scaffold).
   *
   * @param {{ personaId?: string|null, documentId?: string|null, mode?: string|null }} input
   * @returns {BuildRecord}
   */
  const id = uuidV4();
  const now = _nowIso();

  const build = {
    id,
    personaId: input.personaId ?? null,
    documentId: input.documentId ?? null,
    status: 'queued',
    progress: 0,
    message: 'Build queued.',
    steps: ['validate_inputs', 'extract_text', 'normalize_text', 'generate_persona_draft', 'finalize'],
    currentStep: null,
    createdAt: now,
    updatedAt: now
  };

  _setBuild(build);

  // Start progress simulation immediately.
  _simulateProgress(id);

  return build;
}

// PUBLIC_INTERFACE
function getBuild(buildId) {
  /** Return a build record by id (or null if not found). */
  return _getBuild(buildId);
}

// PUBLIC_INTERFACE
function getBuildStatus(buildId) {
  /**
   * Return a status projection (or null if not found).
   * Keeps payload small for polling.
   */
  const b = _getBuild(buildId);
  if (!b) return null;
  return {
    id: b.id,
    status: b.status,
    progress: b.progress,
    message: b.message,
    currentStep: b.currentStep,
    updatedAt: b.updatedAt
  };
}

// PUBLIC_INTERFACE
function cancelBuild(buildId) {
  /** Cancel an in-progress build. Returns updated status projection or null if not found. */
  const b = _getBuild(buildId);
  if (!b) return null;
  if (b.status === 'succeeded' || b.status === 'failed') return getBuildStatus(buildId);

  const updated = {
    ...b,
    status: 'cancelled',
    message: 'Build cancelled.',
    updatedAt: _nowIso()
  };
  _setBuild(updated);
  return getBuildStatus(buildId);
}

module.exports = {
  isDbConfiguredForBuilds,
  createBuild,
  getBuild,
  getBuildStatus,
  cancelBuild
};
