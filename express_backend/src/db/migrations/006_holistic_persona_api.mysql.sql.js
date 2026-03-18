

/**
 * MySQL migration: persistence tables for the Holistic Persona /api endpoints.
 *
 * Endpoints to persist:
 * - GET  /api/recommendations/roles
 * - POST /api/recommendations/compare
 * - GET  /api/paths/multiverse
 * - POST /api/plan/milestones
 * - PUT  /api/profile/scoring
 *
 * Design notes:
 * - These endpoints are "derived" from persona/build context, but we persist the results so
 *   the frontend can refresh/reload and still fetch the last computed artifacts.
 * - We key primarily by build_id (or persona_id/user_id where appropriate).
 * - We keep payloads as JSON for flexibility.
 */

// PUBLIC_INTERFACE
export function getMigrationSql() {
  /** Returns SQL statements for creating Holistic Persona API persistence tables in MySQL. */
  return `
-- 006_holistic_persona_api (mysql)

CREATE TABLE IF NOT EXISTS recommendations_roles (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  build_id CHAR(36) NULL,
  inferred_tags_json JSON NULL,
  roles_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_recommendations_roles_build_id (build_id),
  INDEX idx_recommendations_roles_persona_id (persona_id),
  INDEX idx_recommendations_roles_user_id (user_id),
  INDEX idx_recommendations_roles_updated_at (updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recommendations_compare (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  build_id CHAR(36) NULL,
  left_role_id VARCHAR(128) NOT NULL,
  right_role_id VARCHAR(128) NOT NULL,
  comparison_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_recommendations_compare_build_id (build_id),
  INDEX idx_recommendations_compare_left_right (left_role_id, right_role_id),
  INDEX idx_recommendations_compare_created_at (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paths_multiverse (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  build_id CHAR(36) NULL,
  paths_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_paths_multiverse_build_id (build_id),
  INDEX idx_paths_multiverse_updated_at (updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS plan_milestones (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  build_id CHAR(36) NULL,
  goal VARCHAR(512) NOT NULL,
  timeframe_weeks INT NOT NULL,
  focus VARCHAR(64) NULL,
  milestones_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_plan_milestones_build_id (build_id),
  INDEX idx_plan_milestones_updated_at (updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profile_scoring (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  persona_id CHAR(36) NULL,
  build_id CHAR(36) NULL,
  scoring_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_profile_scoring_build_id (build_id),
  INDEX idx_profile_scoring_persona_id (persona_id),
  INDEX idx_profile_scoring_user_id (user_id),
  INDEX idx_profile_scoring_updated_at (updated_at)
) ENGINE=InnoDB;
`;
}

export default { getMigrationSql };
