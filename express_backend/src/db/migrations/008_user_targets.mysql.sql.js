'use strict';

/**
 * MySQL migration: user_targets table
 *
 * Purpose:
 * - Persist the user's selected "Target Future Role" along with a time horizon.
 *
 * Notes:
 * - We keep this separate from persona_final because persona_final is currently not keyed by user/persona.
 * - This table is keyed by user_id so the UI can retrieve/set the latest selection per user.
 */

// PUBLIC_INTERFACE
function getMigrationSql() {
  /** Returns SQL statements for creating the user_targets table in MySQL. */
  return `
-- 008_user_targets (mysql)

CREATE TABLE IF NOT EXISTS user_targets (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  role_id VARCHAR(255) NOT NULL,
  time_horizon VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_user_targets_user_id_updated_at (user_id, updated_at),
  INDEX idx_user_targets_role_id (role_id)

  -- IMPORTANT:
  -- Do NOT add a foreign key to roles(role_id). Role identifiers are not guaranteed to be UUIDs,
  -- and may come from multiple catalogs/sources. Persistence stores the chosen identifier as-is.
) ENGINE=InnoDB;
`;
}

module.exports = { getMigrationSql };
