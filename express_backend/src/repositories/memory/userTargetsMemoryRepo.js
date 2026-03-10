'use strict';

/**
 * In-memory user targets repository.
 *
 * Data model:
 * - Keyed by userId
 * - Stores the latest target role selection only (overwrite on save).
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _store = new Map();

function _nowIso() {
  return new Date().toISOString();
}

// PUBLIC_INTERFACE
async function upsertUserTargetRole({ userId, roleId, timeHorizon }) {
  /** Save latest target role selection in memory and return a normalized record shape. */
  const now = _nowIso();
  const record = {
    id: `mem_${String(userId)}`,
    userId: String(userId),
    roleId: String(roleId),
    timeHorizon: String(timeHorizon),
    createdAt: now,
    updatedAt: now
  };

  _store.set(String(userId), record);
  return record;
}

// PUBLIC_INTERFACE
async function getLatestUserTargetRole({ userId }) {
  /** Load latest target role selection from memory. Returns null if not found. */
  return _store.get(String(userId)) || null;
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole
};
