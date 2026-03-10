'use strict';

/**
 * In-memory user targets repository.
 *
 * Data model (process-local):
 * - targetStore: latest target role selection per userId
 * - currentStore: latest current role extraction per userId
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _targetStore = new Map();
const _currentStore = new Map();

function _nowIso() {
  return new Date().toISOString();
}

// PUBLIC_INTERFACE
async function upsertUserTargetRole({ userId, roleId, timeHorizon }) {
  /** Save latest target role selection in memory and return a normalized record shape. */
  const now = _nowIso();
  const record = {
    id: `mem_target_${String(userId)}`,
    userId: String(userId),
    roleId: String(roleId),
    timeHorizon: String(timeHorizon),
    createdAt: now,
    updatedAt: now,
  };

  _targetStore.set(String(userId), record);
  return record;
}

// PUBLIC_INTERFACE
async function getLatestUserTargetRole({ userId }) {
  /** Load latest target role selection from memory. Returns null if not found. */
  return _targetStore.get(String(userId)) || null;
}

// PUBLIC_INTERFACE
async function upsertUserCurrentRole({ userId, currentRoleTitle, source = 'bedrock' }) {
  /** Save latest current role extraction in memory and return a normalized record shape. */
  const now = _nowIso();
  const record = {
    id: `mem_current_${String(userId)}`,
    userId: String(userId),
    currentRoleTitle: String(currentRoleTitle || '').trim(),
    source: String(source || 'bedrock'),
    createdAt: now,
    updatedAt: now,
  };

  _currentStore.set(String(userId), record);
  return record;
}

// PUBLIC_INTERFACE
async function getLatestUserCurrentRole({ userId }) {
  /** Load latest current role extraction from memory. Returns null if not found. */
  return _currentStore.get(String(userId)) || null;
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole,
  upsertUserCurrentRole,
  getLatestUserCurrentRole,
};
