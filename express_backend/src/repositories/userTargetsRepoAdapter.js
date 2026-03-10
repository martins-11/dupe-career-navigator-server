'use strict';

const mysqlRepo = require('./mysql/userTargetsRepo.mysql');
const memoryRepo = require('./memory/userTargetsMemoryRepo');

/**
 * Adapter strategy:
 * - Prefer MySQL when it is configured for this runtime.
 * - Fall back to process-local memory when DB is unavailable/unconfigured.
 *
 * This matches the resilience approach used by mindmapViewStateRepoAdapter so the
 * UI can work in early scaffolding environments.
 */
function _isMysqlOnline() {
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  return engine === 'mysql' && isDbConfigured() && isMysqlConfigured();
}

// PUBLIC_INTERFACE
async function upsertUserTargetRole({ userId, roleId, timeHorizon }) {
  /** Persist a user's target role (MySQL when available; otherwise memory fallback). */
  if (_isMysqlOnline()) {
    try {
      return await mysqlRepo.upsertUserTargetRole({ userId, roleId, timeHorizon });
    } catch (_) {
      // If MySQL is misconfigured or temporarily down, degrade gracefully.
      return memoryRepo.upsertUserTargetRole({ userId, roleId, timeHorizon });
    }
  }

  return memoryRepo.upsertUserTargetRole({ userId, roleId, timeHorizon });
}

// PUBLIC_INTERFACE
async function getLatestUserTargetRole({ userId }) {
  /** Fetch latest user's target role (MySQL when available; otherwise memory fallback). */
  if (_isMysqlOnline()) {
    try {
      const row = await mysqlRepo.getLatestUserTargetRole({ userId });
      if (row) return row;
      // If no DB row exists, still allow memory fallback for this process lifetime.
      return memoryRepo.getLatestUserTargetRole({ userId });
    } catch (_) {
      return memoryRepo.getLatestUserTargetRole({ userId });
    }
  }

  return memoryRepo.getLatestUserTargetRole({ userId });
}

// PUBLIC_INTERFACE
async function upsertUserCurrentRole({ userId, currentRoleTitle, source }) {
  /** Persist a user's current role extraction (MySQL when available; otherwise memory fallback). */
  if (_isMysqlOnline()) {
    try {
      return await mysqlRepo.upsertUserCurrentRole({ userId, currentRoleTitle, source });
    } catch (_) {
      return memoryRepo.upsertUserCurrentRole({ userId, currentRoleTitle, source });
    }
  }
  return memoryRepo.upsertUserCurrentRole({ userId, currentRoleTitle, source });
}

// PUBLIC_INTERFACE
async function getLatestUserCurrentRole({ userId }) {
  /** Fetch latest user's current role extraction (MySQL when available; otherwise memory fallback). */
  if (_isMysqlOnline()) {
    try {
      const row = await mysqlRepo.getLatestUserCurrentRole({ userId });
      if (row) return row;
      return memoryRepo.getLatestUserCurrentRole({ userId });
    } catch (_) {
      return memoryRepo.getLatestUserCurrentRole({ userId });
    }
  }
  return memoryRepo.getLatestUserCurrentRole({ userId });
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole,
  upsertUserCurrentRole,
  getLatestUserCurrentRole,
};
