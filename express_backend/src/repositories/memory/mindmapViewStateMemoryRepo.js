'use strict';

/**
 * In-memory mind map view-state repository.
 *
 * Data model:
 * - Keyed by `${userId}::${mapKey}`
 * - Stores the latest state only (overwrite on save).
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _store = new Map();

function _nowIso() {
  return new Date().toISOString();
}

function _key(userId, mapKey) {
  return `${String(userId)}::${String(mapKey)}`;
}

// PUBLIC_INTERFACE
async function saveViewState({ userId, mapKey, state }) {
  /** Save the view state in memory and return a normalized record shape. */
  const now = _nowIso();
  const record = {
    userId: String(userId),
    mapKey: String(mapKey),
    state: state != null ? state : {},
    updatedAt: now
  };
  _store.set(_key(userId, mapKey), record);
  return record;
}

// PUBLIC_INTERFACE
async function loadViewState({ userId, mapKey }) {
  /** Load the view state from memory. Returns null if not found. */
  return _store.get(_key(userId, mapKey)) || null;
}

module.exports = {
  saveViewState,
  loadViewState
};
