

/**
 * Migration: 009_mindmap_view_state (MySQL)
 *
 * Creates a table for saving mind map UI view-state (zoom/pan/expanded nodes).
 */

export function getMigrationSql() {
  return `
  CREATE TABLE IF NOT EXISTS mindmap_view_state (
    user_id VARCHAR(64) NOT NULL,
    map_key VARCHAR(128) NOT NULL,
    state_json JSON NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, map_key)
  );
  `;
}

export default { getMigrationSql };
