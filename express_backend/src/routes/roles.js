'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');

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
   * Query params:
   * - q: string (optional) Search string matched against role_title and skills (LIKE %q%).
   * - industry: string (optional) Exact match on industry (case-insensitive).
   * - salary_range: string (optional) Exact match on salary_range (case-insensitive).
   *
   * Response: Array<{ role_id, role_title, industry, skills_required, salary_range }>
   *
   * Empty state requirement:
   * - If no matches, return 200 with [] (NOT an error).
   */
  try {
    const q = req.query?.q != null ? String(req.query.q).trim() : '';

    // Multi-filter inputs (all optional):
    const industry = req.query?.industry != null ? String(req.query.industry).trim() : '';

    // skills can be:
    // - comma-separated string: "sql,python"
    // - repeated query params: ?skills=sql&skills=python (Express may deliver string or array)
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

    const matches = await rolesRepo.searchRoles({
      q,
      industry: industry || null,
      skills,
      minSalary: Number.isFinite(minSalary) ? minSalary : null,
      maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
      limit: req.query?.limit != null ? Number(req.query.limit) : undefined
    });

    // Enforce empty-array behavior explicitly.
    return res.json(Array.isArray(matches) ? matches : []);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
