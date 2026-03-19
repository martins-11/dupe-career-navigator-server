

/**
 * MySQL migration: multiverse_bookmarks table
 *
 * Purpose:
 * - Persist a user's bookmarked nodes/paths from the Multiverse Explorer.
 *
 * Notes:
 * - Bookmarks are keyed by user_id + bookmark_type + bookmark_key for idempotent upserts.
 * - `bookmark_key` is a stable string identifier chosen by the API (e.g., "node:<nodeId>", "path:<pathId>").
 */

// PUBLIC_INTERFACE
export function getMigrationSql() {
  /** Returns SQL statements for creating the multiverse_bookmarks table in MySQL. */
  return `
-- 010_multiverse_bookmarks (mysql)

CREATE TABLE IF NOT EXISTS multiverse_bookmarks (
  user_id VARCHAR(64) NOT NULL,
  bookmark_type VARCHAR(32) NOT NULL,
  bookmark_key VARCHAR(255) NOT NULL,

  -- Arbitrary bookmark payload (UI-friendly; can store node/path summary snapshots)
  payload_json JSON NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (user_id, bookmark_type, bookmark_key),
  INDEX idx_multiverse_bookmarks_user_updated_at (user_id, updated_at),
  INDEX idx_multiverse_bookmarks_type_updated_at (bookmark_type, updated_at)

) ENGINE=InnoDB;
`;
}

export default { getMigrationSql };

