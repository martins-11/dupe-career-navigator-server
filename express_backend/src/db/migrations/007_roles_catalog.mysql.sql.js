

/**
 * MySQL migration: roles catalog table (Phase 1 Career Path & Recommendations).
 *
 * This table is used by GET /api/recommendations/roles to generate recommendations
 * based solely on the Final Persona.
 *
 * Fields required by Phase 1:
 * - role_id
 * - role_title
 * - industry
 * - core_skills_json (array of skills)
 * - seniority_levels_json (array of seniority levels supported)
 * - estimated_salary_range
 */

 // PUBLIC_INTERFACE
export function getMigrationSql() {
  /** Returns SQL statements for creating the roles catalog table in MySQL. */
  return `
-- 007_roles_catalog (mysql)

CREATE TABLE IF NOT EXISTS roles (
  role_id CHAR(36) PRIMARY KEY,
  role_title VARCHAR(255) NOT NULL,
  industry VARCHAR(128) NULL,
  core_skills_json JSON NOT NULL,
  seniority_levels_json JSON NULL,
  estimated_salary_range VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_roles_industry (industry),
  INDEX idx_roles_role_title (role_title)
) ENGINE=InnoDB;
`;
}

export default { getMigrationSql };
