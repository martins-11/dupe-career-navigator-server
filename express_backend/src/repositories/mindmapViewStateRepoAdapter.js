import mysqlRepo from './mysql/mindmapViewStateRepo.mysql.js';
import memoryRepo from './memory/mindmapViewStateMemoryRepo.js';
import { getDbEngine, isDbConfigured, isMysqlConfigured } from '../db/connection.js';

/**
 * Mind map view-state persistence adapter.
 *
 * Goal:
 * - Persist mind map zoom/pan + expanded nodes so the UI restores the last viewed state.
 * - Prefer MySQL when configured.
 * - Gracefully fall back to in-memory storage when DB is unavailable/unreachable.
 *
 * NOTE:
 * - In-memory fallback is process-local and will be lost on server restart.
 */

function _isDbOnlineForWrites() {
  const engine = getDbEngine();
  return engine === 'mysql' && isDbConfigured() && isMysqlConfigured();
}

// PUBLIC_INTERFACE
export async function saveViewState({ userId, mapKey, state }) {
  /** Save (upsert) a user's mind map view state. Falls back to in-memory when DB is unavailable. */
  if (!_isDbOnlineForWrites()) {
    return memoryRepo.saveViewState({ userId, mapKey, state });
  }

  try {
    return await mysqlRepo.saveViewState({ userId, mapKey, state });
  } catch (_) {
    // Graceful fallback on runtime DB failures (network/auth/DDL drift).
    return memoryRepo.saveViewState({ userId, mapKey, state });
  }
}

// PUBLIC_INTERFACE
export async function loadViewState({ userId, mapKey }) {
  /** Load the latest saved mind map view state for a user. Falls back to in-memory when DB is unavailable. */
  if (!_isDbOnlineForWrites()) {
    return memoryRepo.loadViewState({ userId, mapKey });
  }

  try {
    const row = await mysqlRepo.loadViewState({ userId, mapKey });
    if (row) return row;

    // If DB returns nothing but memory has something (e.g., DB outage happened mid-session),
    // prefer memory as a best-effort UX improvement.
    return memoryRepo.loadViewState({ userId, mapKey });
  } catch (_) {
    return memoryRepo.loadViewState({ userId, mapKey });
  }
}

export default {
  saveViewState,
  loadViewState
};
