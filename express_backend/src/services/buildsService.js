'use strict';

const workflowService = require('./workflowService');

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
 *
 * Backed by workflowService (in-memory).
 */

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
   * Create a build/workflow (in-memory).
   *
   * @param {{ personaId?: string|null, documentId?: string|null, mode?: string|null }} input
   * @returns {BuildRecord}
   */
  const wf = workflowService.createWorkflow({
    personaId: input.personaId ?? null,
    documentId: input.documentId ?? null,
    mode: input.mode ?? null
  });

  workflowService.startWorkflow(wf.id);
  return wf;
}

// PUBLIC_INTERFACE
function getBuild(buildId) {
  /** Return a build record by id (or null if not found). */
  return workflowService.getWorkflow(buildId);
}

// PUBLIC_INTERFACE
function getBuildStatus(buildId) {
  /**
   * Return a status projection (or null if not found).
   * Keeps payload small for polling.
   */
  return workflowService.getWorkflowStatus(buildId);
}

// PUBLIC_INTERFACE
function cancelBuild(buildId) {
  /** Cancel an in-progress build. Returns updated status projection or null if not found. */
  const wf = workflowService.cancelWorkflow(buildId);
  if (!wf) return null;
  return workflowService.getWorkflowStatus(buildId);
}

module.exports = {
  isDbConfiguredForBuilds,
  createBuild,
  getBuild,
  getBuildStatus,
  cancelBuild
};
