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

async function _roleExists(roleId) {
  const res = await dbQuery(
    `
    SELECT role_id
    FROM roles
    WHERE role_id = ?
    LIMIT 1
    `,
    [roleId]
  );
  return Boolean(res.rows && res.rows[0] && res.rows[0].role_id);
}

// PUBLIC_INTERFACE
async function searchRoles({ q = '', industry = null, salaryRange = null, limit = 50 } = {}) {
  /**
   * Search roles in MySQL.
   *
   * Matching:
   * - role_title LIKE %q%
   * - OR core_skills_json LIKE %q% (simple JSON text match; pragmatic for Phase 1)
   *
   * Optional filters:
   * - industry (case-insensitive exact match)
   * - salaryRange (case-insensitive exact match; stored as estimated_salary_range)
   *
   * Output keys required by user instructions:
   * - role_id, role_title, industry, skills_required, salary_range
   */
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));

  const where = [];
  const params = [];

  const qStr = String(q || '').trim();
  if (qStr) {
    // Use a single LIKE string for both title and skills JSON.
    where.push('(role_title LIKE ? OR CAST(core_skills_json AS CHAR) LIKE ?)');
    const like = `%${qStr}%`;
    params.push(like, like);
  }

  if (industry) {
    where.push('LOWER(industry) = LOWER(?)');
    params.push(String(industry));
  }

  if (salaryRange) {
    where.push('LOWER(estimated_salary_range) = LOWER(?)');
    params.push(String(salaryRange));
  }

  const sql = `
    SELECT
      role_id,
      role_title,
      industry,
      core_skills_json as skills_required,
      estimated_salary_range as salary_range
    FROM roles
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY role_title ASC
    LIMIT ?
  `;

  params.push(lim);

  const res = await dbQuery(sql, params);

  return (res.rows || []).map((r) => ({
    role_id: r.role_id,
    role_title: r.role_title,
    industry: r.industry,
    skills_required: _jsonParseIfNeeded(r.skills_required) || [],
    salary_range: r.salary_range
  }));
}

module.exports = {
  countRoles,
  listRoles,
  bulkInsertRoles,
  searchRoles,
  _roleExists
};
