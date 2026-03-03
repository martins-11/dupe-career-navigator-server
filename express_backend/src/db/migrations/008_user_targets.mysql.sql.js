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
  role_id CHAR(36) NOT NULL,
  time_horizon VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_user_targets_user_id_updated_at (user_id, updated_at),
  INDEX idx_user_targets_role_id (role_id),

  CONSTRAINT fk_user_targets_role_id
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB;
`;
}

module.exports = { getMigrationSql };
