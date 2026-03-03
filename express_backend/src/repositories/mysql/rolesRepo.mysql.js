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

/**
 * Attempt to parse a salary range string into numeric bounds.
 * Supports common formats seen in seed data, e.g.:
 * - "$100k-$140k"
 * - "100000-140000"
 * - "100k to 140k"
 * - "$120,000"
 */
function _parseSalaryRangeToBounds(s) {
  if (!s || typeof s !== 'string') return { min: null, max: null };

  const raw = s.toLowerCase().replace(/,/g, ' ');
  const tokens = raw.match(/(\d+(\.\d+)?)(\s*[kmb])?/g) || [];
  const values = tokens
    .map((t) => {
      const m = String(t).trim().match(/^(\d+(\.\d+)?)(\s*[kmb])?$/);
      if (!m) return null;
      const num = Number(m[1]);
      if (!Number.isFinite(num)) return null;
      const suffix = (m[3] || '').trim();
      const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : suffix === 'b' ? 1000000000 : 1;
      return Math.round(num * mult);
    })
    .filter((v) => Number.isFinite(v));

  if (values.length === 0) return { min: null, max: null };
  if (values.length === 1) return { min: values[0], max: values[0] };

  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max };
}

/**
 * Checks whether a required skills list is contained in a role's skills list.
 * - Case-insensitive
 * - Treats role skills as strings
 */
function _roleSkillsContainAll(roleSkills, requiredSkills) {
  const roleSet = new Set(
    (Array.isArray(roleSkills) ? roleSkills : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );

  for (const req of requiredSkills) {
    const normalized = String(req).trim().toLowerCase();
    if (!normalized) continue;
    if (!roleSet.has(normalized)) return false;
  }
  return true;
}

// PUBLIC_INTERFACE
async function searchRoles({ q = '', industry = null, skills = [], minSalary = null, maxSalary = null, limit = 50 } = {}) {
  /**
   * Search roles in MySQL with dynamic AND-based multi-filter logic.
   *
   * Optional query inputs:
   * - q: keyword, matched against role_title OR core_skills_json (JSON-aware) via LIKE
   * - industry: exact match (case-insensitive)
   * - skills: list of required skills (must all exist in core_skills_json JSON array)
   * - minSalary/maxSalary: numeric filters applied against estimated_salary_range (parsed best-effort)
   *
   * IMPORTANT:
   * - Missing filters are ignored (no-op), not treated as null constraints.
   * - SQL is built dynamically to include only provided filters.
   *
   * Output keys required by user instructions:
   * - role_id, role_title, industry, skills_required, salary_range
   *
   * Additional response metadata:
   * - match_metadata: { matchedFilters: string[] }
   */
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));

  const where = [];
  const params = [];

  const qStr = String(q || '').trim();
  if (qStr) {
    // Use JSON_EXTRACT for JSON columns instead of CAST(... AS CHAR).
    // This avoids subtle JSON string representation issues that can lead to empty matches.
    where.push('(role_title LIKE ? OR JSON_EXTRACT(core_skills_json, \'$\') LIKE ?)');
    const like = `%${qStr}%`;
    params.push(like, like);
  }

  if (industry) {
    where.push('LOWER(industry) = LOWER(?)');
    params.push(String(industry));
  }

  // Skills: use JSON_CONTAINS for exact containment in JSON array.
  // This is both more accurate and less fragile than LIKE on serialized JSON.
  const skillsList = Array.isArray(skills) ? skills : [];
  const normalizedSkills = skillsList.map((s) => String(s).trim()).filter(Boolean);
  if (normalizedSkills.length > 0) {
    for (const s of normalizedSkills) {
      where.push("JSON_CONTAINS(core_skills_json, JSON_QUOTE(?), '$')");
      params.push(String(s));
    }
  }

  // Salary filtering is applied in JS after fetch; we prefetch more rows to avoid missing matches.
  const hasSalaryFilter = Number.isFinite(Number(minSalary)) || Number.isFinite(Number(maxSalary));
  const sqlLimit = hasSalaryFilter ? Math.min(lim * 10, 2000) : lim;

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

  params.push(sqlLimit);

  const res = await dbQuery(sql, params);

  const minS = Number.isFinite(Number(minSalary)) ? Number(minSalary) : null;
  const maxS = Number.isFinite(Number(maxSalary)) ? Number(maxSalary) : null;

  const rows = (res.rows || []).map((r) => {
    const parsedSkills = _jsonParseIfNeeded(r.skills_required) || [];
    const salaryBounds = _parseSalaryRangeToBounds(r.salary_range);

    const matchedFilters = [];
    if (qStr) matchedFilters.push('q');
    if (industry) matchedFilters.push('industry');
    if (normalizedSkills.length > 0) matchedFilters.push('skills');
    if (minS != null) matchedFilters.push('min_salary');
    if (maxS != null) matchedFilters.push('max_salary');

    return {
      role_id: r.role_id,
      role_title: r.role_title,
      industry: r.industry,
      skills_required: parsedSkills,
      salary_range: r.salary_range,
      match_metadata: {
        matchedFilters
      },
      _internal: {
        salaryBounds
      }
    };
  });

  // Defensive: even though SQL uses JSON_CONTAINS, keep a JS containment check to avoid surprises
  // if core_skills_json contains mixed casing or unexpected non-string elements.
  let filtered = rows;
  if (normalizedSkills.length > 0) {
    filtered = filtered.filter((r) => _roleSkillsContainAll(r.skills_required, normalizedSkills));
  }

  // Enforce salary filters in JS using parsed bounds.
  if (minS != null) {
    filtered = filtered.filter((r) => {
      const { min, max } = r._internal.salaryBounds || { min: null, max: null };
      if (min == null && max == null) return false;
      const roleMax = max != null ? max : min;
      return roleMax != null && roleMax >= minS;
    });
  }

  if (maxS != null) {
    filtered = filtered.filter((r) => {
      const { min, max } = r._internal.salaryBounds || { min: null, max: null };
      if (min == null && max == null) return false;
      const roleMin = min != null ? min : max;
      return roleMin != null && roleMin <= maxS;
    });
  }

  return filtered.slice(0, lim).map((r) => {
    const { _internal, ...publicRow } = r;
    return publicRow;
  });
}

module.exports = {
  countRoles,
  listRoles,
  bulkInsertRoles,
  searchRoles,
  _roleExists
};
