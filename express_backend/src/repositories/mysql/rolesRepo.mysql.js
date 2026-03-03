'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

function _jsonParseIfNeeded(v) {
  if (v == null) return v;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return v;
    }
  }
  return v;
}

// PUBLIC_INTERFACE
async function countRoles() {
  /** Returns the number of roles in the roles table. */
  const res = await dbQuery(
    `
    SELECT COUNT(*) as cnt
    FROM roles
    `
  );
  return Number(res.rows?.[0]?.cnt ?? 0);
}

// PUBLIC_INTERFACE
async function listRoles({ limit = 1000 } = {}) {
  /** List roles from the catalog table. */
  const lim = Math.max(1, Math.min(Number(limit) || 1000, 5000));

  const res = await dbQuery(
    `
    SELECT
      role_id as roleId,
      role_title as roleTitle,
      industry,
      core_skills_json as coreSkills,
      seniority_levels_json as seniorityLevels,
      estimated_salary_range as estimatedSalaryRange
    FROM roles
    ORDER BY role_title ASC
    LIMIT ?
    `,
    [lim]
  );

  return (res.rows || []).map((r) => ({
    ...r,
    coreSkills: _jsonParseIfNeeded(r.coreSkills) || [],
    seniorityLevels: _jsonParseIfNeeded(r.seniorityLevels) || []
  }));
}

// PUBLIC_INTERFACE
async function bulkInsertRoles(roles) {
  /**
   * Insert a list of roles.
   * Each entry: { roleTitle, industry, coreSkills, seniorityLevels, estimatedSalaryRange }.
   */
  const list = Array.isArray(roles) ? roles : [];
  if (list.length === 0) return { inserted: 0 };

  let inserted = 0;

  for (const r of list) {
    const roleId = r.roleId || uuidV4();
    await dbQuery(
      `
      INSERT INTO roles (
        role_id, role_title, industry, core_skills_json, seniority_levels_json, estimated_salary_range, created_at, updated_at
      )
      VALUES (?,?,?,?,?,?,?,?)
      `,
      [
        roleId,
        r.roleTitle,
        r.industry ?? null,
        JSON.stringify(r.coreSkills || []),
        JSON.stringify(r.seniorityLevels || []),
        r.estimatedSalaryRange ?? null,
        new Date(),
        new Date()
      ]
    );
    inserted += 1;
  }

  return { inserted };
}

module.exports = {
  countRoles,
  listRoles,
  bulkInsertRoles
};
