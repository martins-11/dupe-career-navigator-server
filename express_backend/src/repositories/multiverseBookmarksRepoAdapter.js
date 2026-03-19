import mysqlRepo from './mysql/multiverseBookmarksRepo.mysql.js';
import memoryRepo from './memory/multiverseBookmarksMemoryRepo.js';
import { getDbEngine, isDbConfigured, isMysqlConfigured } from '../db/connection.js';

/**
 * Multiverse Explorer bookmarks persistence adapter.
 *
 * Goals:
 * - Prefer MySQL when configured.
 * - Fall back to in-memory storage if DB isn't configured or is temporarily unavailable.
 */

function _isDbOnlineForWrites() {
  const engine = getDbEngine();
  return engine === 'mysql' && isDbConfigured() && isMysqlConfigured();
}

// PUBLIC_INTERFACE
export async function upsertBookmark({ userId, bookmarkType, bookmarkKey, payload = null }) {
  /** Upsert a bookmark (MySQL when available; otherwise memory). */
  if (!_isDbOnlineForWrites()) {
    return memoryRepo.upsertBookmark({ userId, bookmarkType, bookmarkKey, payload });
  }

  try {
    return await mysqlRepo.upsertBookmark({ userId, bookmarkType, bookmarkKey, payload });
  } catch (_) {
    return memoryRepo.upsertBookmark({ userId, bookmarkType, bookmarkKey, payload });
  }
}

// PUBLIC_INTERFACE
export async function deleteBookmark({ userId, bookmarkType, bookmarkKey }) {
  /** Delete a bookmark (MySQL when available; otherwise memory). */
  if (!_isDbOnlineForWrites()) {
    return memoryRepo.deleteBookmark({ userId, bookmarkType, bookmarkKey });
  }

  try {
    return await mysqlRepo.deleteBookmark({ userId, bookmarkType, bookmarkKey });
  } catch (_) {
    return memoryRepo.deleteBookmark({ userId, bookmarkType, bookmarkKey });
  }
}

// PUBLIC_INTERFACE
export async function listBookmarks({ userId, bookmarkType = null, limit = 200, offset = 0 }) {
  /** List bookmarks (MySQL when available; otherwise memory). */
  if (!_isDbOnlineForWrites()) {
    return memoryRepo.listBookmarks({ userId, bookmarkType, limit, offset });
  }

  try {
    const rows = await mysqlRepo.listBookmarks({ userId, bookmarkType, limit, offset });
    // Prefer DB, but if DB has none and memory has some from the current process/session, return memory.
    if (Array.isArray(rows) && rows.length > 0) return rows;
    return memoryRepo.listBookmarks({ userId, bookmarkType, limit, offset });
  } catch (_) {
    return memoryRepo.listBookmarks({ userId, bookmarkType, limit, offset });
  }
}

export default { upsertBookmark, deleteBookmark, listBookmarks };

