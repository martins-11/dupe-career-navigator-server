import { dbQuery } from '../../db/connection.js';

/**
 * MySQL repository for mindmap_view_state table.
 *
 * Expected table (created via migration/self-heal):
 * - user_id (varchar/uuid-ish)
 * - map_key (varchar)
 * - state_json (json or longtext)
 * - updated_at (datetime/timestamp)
 *
 * We treat it as "upsert latest".
 */

// PUBLIC_INTERFACE
export async function saveViewState({ userId, mapKey, state }) {
  /** Upsert a user's mind map view-state row and return a normalized record. */
  const now = new Date();
  const stateJson = JSON.stringify(state != null ? state : {});

  await dbQuery(
    `
    INSERT INTO mindmap_view_state (user_id, map_key, state_json, updated_at)
    VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE
      state_json = VALUES(state_json),
      updated_at = VALUES(updated_at)
    `,
    [userId, mapKey, stateJson, now]
  );

  return {
    userId: String(userId),
    mapKey: String(mapKey),
    state: state != null ? state : {},
    updatedAt: now.toISOString()
  };
}

// PUBLIC_INTERFACE
export async function loadViewState({ userId, mapKey }) {
  /** Load a user's mind map view-state row. Returns null if not found. */
  const res = await dbQuery(
    `
    SELECT
      user_id as userId,
      map_key as mapKey,
      state_json as stateJson,
      updated_at as updatedAt
    FROM mindmap_view_state
    WHERE user_id = ? AND map_key = ?
    LIMIT 1
    `,
    [userId, mapKey]
  );

  const row = res.rows?.[0];
  if (!row) return null;

  let parsed = null;
  try {
    parsed = row.stateJson != null ? JSON.parse(row.stateJson) : {};
  } catch (_) {
    parsed = {};
  }

  return {
    userId: String(row.userId),
    mapKey: String(row.mapKey),
    state: parsed,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null
  };
}

export default { saveViewState, loadViewState };
