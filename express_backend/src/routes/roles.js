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
    const industry = req.query?.industry != null ? String(req.query.industry).trim() : '';
    const salaryRange = req.query?.salary_range != null ? String(req.query.salary_range).trim() : '';

    const matches = await rolesRepo.searchRoles({
      q,
      industry: industry || null,
      salaryRange: salaryRange || null,
      limit: req.query?.limit != null ? Number(req.query.limit) : undefined
    });

    // Enforce empty-array behavior explicitly.
    return res.json(Array.isArray(matches) ? matches : []);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
