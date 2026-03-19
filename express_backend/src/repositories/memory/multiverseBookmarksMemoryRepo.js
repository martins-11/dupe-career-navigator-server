/**
 * In-memory repository for Multiverse Explorer bookmarks.
 *
 * Keyed by: `${userId}::${bookmarkType}::${bookmarkKey}`
 *
 * NOTE: Process-local memory only. Data is lost on restart.
 */

const _store = new Map();

function _nowIso() {
  return new Date().toISOString();
}

function _key(userId, bookmarkType, bookmarkKey) {
  return `${String(userId)}::${String(bookmarkType)}::${String(bookmarkKey)}`;
}

// PUBLIC_INTERFACE
export async function upsertBookmark({ userId, bookmarkType, bookmarkKey, payload = null }) {
  /** Upsert a bookmark in memory (idempotent by key). */
  const now = _nowIso();
  const k = _key(userId, bookmarkType, bookmarkKey);
  const existing = _store.get(k);

  const record = {
    userId: String(userId),
    bookmarkType: String(bookmarkType),
    bookmarkKey: String(bookmarkKey),
    payload: payload && typeof payload === 'object' ? payload : payload ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  _store.set(k, record);
  return record;
}

// PUBLIC_INTERFACE
export async function deleteBookmark({ userId, bookmarkType, bookmarkKey }) {
  /** Delete a bookmark from memory. Returns {deleted:boolean}. */
  const k = _key(userId, bookmarkType, bookmarkKey);
  const existed = _store.delete(k);
  return { deleted: existed };
}

// PUBLIC_INTERFACE
export async function listBookmarks({ userId, bookmarkType = null, limit = 200, offset = 0 }) {
  /** List bookmarks for a user, optionally filtered by type. Sorted by updatedAt desc. */
  const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(1000, Number(limit))) : 200;
  const off = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;

  const rows = [];
  for (const v of _store.values()) {
    if (String(v.userId) !== String(userId)) continue;
    if (bookmarkType && String(v.bookmarkType) !== String(bookmarkType)) continue;
    rows.push(v);
  }

  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows.slice(off, off + lim);
}

export default { upsertBookmark, deleteBookmark, listBookmarks };

