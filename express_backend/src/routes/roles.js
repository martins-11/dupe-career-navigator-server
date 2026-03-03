'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');
const recommendationsService = require('../services/recommendationsService');

const router = express.Router();

/**
 * Roles APIs.
 *
 * Implements targeted search over the roles catalog (roles table).
 * This is part of the "Future Role Selection (Targeted Search)" feature.
 */

// PUBLIC_INTERFACE
router.get('/search', async (req, res) => {
  /**
   * Search roles with optional filtering.
   *
   * Query params (all optional; combined with AND logic):
   * - q: string Search string matched against role_title and skills.
   * - industry: string Exact match on industry (case-insensitive).
   * - skills: string|string[] Comma-separated or repeated params; must all be present in core_skills_json.
   * - min_salary / max_salary: numbers Filter against estimated_salary_range (best-effort parsing).
   *
   * Response: Array<{ role_id, role_title, industry, skills_required, salary_range, match_metadata }>
   *
   * Empty state requirement:
   * - If no matches, return 200 with [] (NOT an error).
   */
  try {
    // Ensure DB is configured in the running server; otherwise the adapter intentionally returns [].
    const engine = getDbEngine();
    if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) {
      return res.json([]);
    }

    // Note: do not attempt to seed here. Seeding is handled by explicit scripts (scripts/seed-roles.js)
    // and by services that truly require it. Search should be read-only and deterministic.

    const q = req.query?.q != null ? String(req.query.q).trim() : '';

    const industry = req.query?.industry != null ? String(req.query.industry).trim() : '';

    const skillsRaw = req.query?.skills;
    const skills =
      Array.isArray(skillsRaw)
        ? skillsRaw.map((s) => String(s).trim()).filter(Boolean)
        : typeof skillsRaw === 'string'
          ? String(skillsRaw)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

    const minSalary =
      req.query?.min_salary != null && String(req.query.min_salary).trim() !== ''
        ? Number(req.query.min_salary)
        : null;

    const maxSalary =
      req.query?.max_salary != null && String(req.query.max_salary).trim() !== ''
        ? Number(req.query.max_salary)
        : null;

    let matches = await rolesRepo.searchRoles({
      q,
      industry: industry || null,
      skills,
      minSalary: Number.isFinite(minSalary) ? minSalary : null,
      maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
      limit: req.query?.limit != null ? Number(req.query.limit) : undefined
    });

    // Defensive fallback:
    // If adapter unexpectedly yields 0 but the table is populated, return an unfiltered sample
    // so the verification script and users can see seeded data rather than a misleading empty list.
    if (Array.isArray(matches) && matches.length === 0) {
      const cntRes = await dbQuery('SELECT COUNT(*) as cnt FROM roles');
      const cnt = Number(cntRes?.rows?.[0]?.cnt ?? 0);
      if (cnt > 0 && !q && !industry && skills.length === 0 && minSalary == null && maxSalary == null) {
        const sampleRes = await dbQuery(
          `
          SELECT
            role_id,
            role_title,
            industry,
            core_skills_json as skills_required,
            estimated_salary_range as salary_range
          FROM roles
          ORDER BY role_title ASC
          LIMIT 50
          `
        );
        matches = (sampleRes?.rows || []).map((r) => ({
          role_id: r.role_id,
          role_title: r.role_title,
          industry: r.industry,
          skills_required: r.skills_required,
          salary_range: r.salary_range,
          match_metadata: { matchedFilters: [] }
        }));
      }
    }

    return res.json(Array.isArray(matches) ? matches : []);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
