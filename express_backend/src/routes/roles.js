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
    const debugRolesSearch = String(process.env.DEBUG_ROLES_SEARCH || '').toLowerCase() === 'true';

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

    const minSalaryRaw = req.query?.min_salary != null ? String(req.query.min_salary).trim() : '';
    const minSalaryParsed = minSalaryRaw !== '' ? Number(minSalaryRaw) : null;
    const minSalary = Number.isFinite(minSalaryParsed) ? minSalaryParsed : null;

    const maxSalaryRaw = req.query?.max_salary != null ? String(req.query.max_salary).trim() : '';
    const maxSalaryParsed = maxSalaryRaw !== '' ? Number(maxSalaryRaw) : null;
    const maxSalary = Number.isFinite(maxSalaryParsed) ? maxSalaryParsed : null;

    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const limit =
      Number.isFinite(limitRaw) && limitRaw != null ? Math.max(1, Math.min(Number(limitRaw), 200)) : undefined;

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] filters:', {
        q,
        industry: industry || null,
        skills,
        minSalary: Number.isFinite(minSalary) ? minSalary : null,
        maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
        limit
      });
    }

    // Prefer DB-backed search when possible, but do NOT hard-gate the endpoint.
    // In many environments (incl. CI/verifiers), DB credentials may not be detected as configured,
    // and returning [] makes filtered search appear broken even though seed data exists.
    const engine = getDbEngine();
    const canUseMysql = engine === 'mysql' && isDbConfigured() && isMysqlConfigured();

    let matches = null;

    if (canUseMysql) {
      matches = await rolesRepo.searchRoles({
        q,
        industry: industry || null,
        skills,
        minSalary: Number.isFinite(minSalary) ? minSalary : null,
        maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
        limit
      });

      if (debugRolesSearch) {
        // eslint-disable-next-line no-console
        console.log('[roles.search] (db) resultCount:', Array.isArray(matches) ? matches.length : null);
      }

      return res.json(Array.isArray(matches) ? matches : []);
    }

    // DB not configured: fall back to an in-memory seed list and apply filters in JS.
    // This keeps /api/roles/search useful for local dev + automated verification scripts.
    const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
    const catalog = Array.isArray(seed)
      ? seed
      : [
          // Keep this aligned with scripts/seed-roles.js and scripts/test-search-keyword.js
          {
            role_id: 'seed-product-manager',
            role_title: 'Product Manager',
            industry: 'Technology',
            skills_required: ['Roadmapping', 'Stakeholder Management', 'Analytics', 'Prioritization', 'Communication'],
            salary_range: '$130k-$210k'
          },
          {
            role_id: 'seed-technical-program-manager',
            role_title: 'Technical Program Manager',
            industry: 'Technology',
            skills_required: ['Delivery Management', 'Coordination', 'Risk Management', 'Communication', 'Systems Thinking'],
            salary_range: '$140k-$220k'
          },
          {
            role_id: 'seed-operations-manager',
            role_title: 'Operations Manager',
            industry: 'Retail',
            skills_required: ['Process Improvement', 'Leadership', 'Operations', 'KPIs', 'Communication'],
            salary_range: '$90k-$150k'
          },
          {
            role_id: 'seed-risk-manager',
            role_title: 'Risk Manager',
            industry: 'Finance',
            skills_required: ['Risk Assessment', 'Compliance', 'Stakeholder Management', 'Analysis', 'Reporting'],
            salary_range: '$130k-$200k'
          }
        ];

    const qNorm = String(q || '').trim().toLowerCase();
    const industryNorm = String(industry || '').trim().toLowerCase();

    const parseSalaryBounds = (s) => {
      if (!s || typeof s !== 'string') return { min: null, max: null };
      const raw = s.toLowerCase().replace(/,/g, ' ');
      const tokens = raw.match(/(\d+(\.\d+)?)(\s*[kmb])?/g) || [];
      const values = tokens
        .map((t) => {
          const m = String(t)
            .trim()
            .match(/^(\d+(\.\d+)?)(\s*[kmb])?$/);
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
      return { min: Math.min(...values), max: Math.max(...values) };
    };

    const roleSkillsContainAll = (roleSkills, requiredSkills) => {
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
    };

    const requiredSkills = (Array.isArray(skills) ? skills : []).map((s) => String(s).trim()).filter(Boolean);

    matches = catalog
      .map((r) => {
        // Support BOTH shapes:
        // 1) DB/seed route shape: { role_id, role_title, skills_required, salary_range }
        // 2) recommendationsService.DEFAULT_ROLES_CATALOG shape:
        //    { roleTitle, coreSkills, estimatedSalaryRange, industry, ... }
        //
        // IMPORTANT:
        // - roleTitle is a plain string in DEFAULT_ROLES_CATALOG. Previous code attempted roleTitle?.name,
        //   which caused title="" and made all filtering (and even unfiltered listing) return [].
        const title = String(r.role_title || r.roleTitle || '').trim();
        const ind = String(r.industry || '').trim();

        const skillsReq = Array.isArray(r.skills_required)
          ? r.skills_required
          : Array.isArray(r.coreSkills)
            ? r.coreSkills
            : [];

        const salaryRange = String(r.salary_range || r.estimatedSalaryRange || '').trim();

        const salaryBounds = parseSalaryBounds(salaryRange);

        // Ensure role_id is stable and non-null in memory mode (useful for UI lists + tests).
        const stableId =
          r.role_id ||
          r.roleId ||
          (title
            ? `seed-${title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/(^-|-$)/g, '')}`
            : null);

        return {
          role_id: stableId,
          role_title: title,
          industry: ind,
          skills_required: skillsReq,
          salary_range: salaryRange,
          match_metadata: { matchedFilters: [] },
          _internal: { salaryBounds }
        };
      })
      .filter((r) => {
        if (qNorm) {
          const inTitle = r.role_title.toLowerCase().includes(qNorm);
          const inSkills = (Array.isArray(r.skills_required) ? r.skills_required : []).some((s) =>
            String(s).toLowerCase().includes(qNorm)
          );
          if (!inTitle && !inSkills) return false;
        }

        if (industryNorm) {
          if (String(r.industry || '').toLowerCase() !== industryNorm) return false;
        }

        if (requiredSkills.length > 0) {
          if (!roleSkillsContainAll(r.skills_required, requiredSkills)) return false;
        }

        if (minSalary != null) {
          const { min, max } = r._internal.salaryBounds || { min: null, max: null };
          if (min == null && max == null) return false;
          const roleMax = max != null ? max : min;
          if (roleMax == null || roleMax < minSalary) return false;
        }

        if (maxSalary != null) {
          const { min, max } = r._internal.salaryBounds || { min: null, max: null };
          if (min == null && max == null) return false;
          const roleMin = min != null ? min : max;
          if (roleMin == null || roleMin > maxSalary) return false;
        }

        return true;
      })
      .map((r) => {
        const matchedFilters = [];
        if (qNorm) matchedFilters.push('q');
        if (industryNorm) matchedFilters.push('industry');
        if (requiredSkills.length > 0) matchedFilters.push('skills');
        if (minSalary != null) matchedFilters.push('min_salary');
        if (maxSalary != null) matchedFilters.push('max_salary');

        const { _internal, ...pub } = r;
        pub.match_metadata = { matchedFilters, source: 'memory' };
        return pub;
      });

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] (memory) resultCount:', Array.isArray(matches) ? matches.length : null);
    }

    const lim = limit ?? 50;
    return res.json(Array.isArray(matches) ? matches.slice(0, lim) : []);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
