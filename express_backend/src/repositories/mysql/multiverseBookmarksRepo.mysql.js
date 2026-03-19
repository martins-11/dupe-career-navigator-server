import { dbQuery } from '../../db/connection.js';

/**
 * MySQL repository for multiverse_bookmarks table.
 *
 * Primary key: (user_id, bookmark_type, bookmark_key)
 */

function _safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

// PUBLIC_INTERFACE
export async function upsertBookmark({ userId, bookmarkType, bookmarkKey, payload = null }) {
  /** Upsert a bookmark row (idempotent). */
  const now = new Date();
  const payloadJson = payload != null ? JSON.stringify(payload) : null;

  await dbQuery(
    `
    INSERT INTO multiverse_bookmarks (user_id, bookmark_type, bookmark_key, payload_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      payload_json = VALUES(payload_json),
      updated_at = VALUES(updated_at)
    `,
    [userId, bookmarkType, bookmarkKey, payloadJson, now, now]
  );

  return {
    userId: String(userId),
    bookmarkType: String(bookmarkType),
    bookmarkKey: String(bookmarkKey),
    payload: payload ?? null,
    updatedAt: now.toISOString(),
  };
}

// PUBLIC_INTERFACE
export async function deleteBookmark({ userId, bookmarkType, bookmarkKey }) {
  /** Delete a bookmark row. Returns {deleted:boolean}. */
  const res = await dbQuery(
    `
    DELETE FROM multiverse_bookmarks
    WHERE user_id = ? AND bookmark_type = ? AND bookmark_key = ?
    `,
    [userId, bookmarkType, bookmarkKey]
  );

  const affected = res?.rowsAffected ?? res?.affectedRows ?? 0;
  return { deleted: Number(affected) > 0 };
}

// PUBLIC_INTERFACE
export async function listBookmarks({ userId, bookmarkType = null, limit = 200, offset = 0 }) {
  /** List bookmarks for a user, optionally filtered by bookmark_type. Sorted by updated_at desc. */
  const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(1000, Number(limit))) : 200;
  const off = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;

  const where = ['user_id = ?'];
  const params = [userId];

  if (bookmarkType) {
    where.push('bookmark_type = ?');
    params.push(bookmarkType);
  }

  // MySQL LIMIT/OFFSET must be numeric literals or bound params (mysql2 supports bound).
  params.push(lim);
  params.push(off);

  const res = await dbQuery(
    `
    SELECT
      user_id as userId,
      bookmark_type as bookmarkType,
      bookmark_key as bookmarkKey,
      payload_json as payloadJson,
      created_at as createdAt,
      updated_at as updatedAt
    FROM multiverse_bookmarks
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
    OFFSET ?
    `,
    params
  );

  const rows = Array.isArray(res?.rows) ? res.rows : [];
  return rows.map((r) => ({
    userId: String(r.userId),
    bookmarkType: String(r.bookmarkType),
    bookmarkKey: String(r.bookmarkKey),
    payload: _safeJsonParse(r.payloadJson),
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  }));
}

export default { upsertBookmark, deleteBookmark, listBookmarks };

