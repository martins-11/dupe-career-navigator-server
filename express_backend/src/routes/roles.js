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
   * Search roles with optional filtering (unified query handling).
   *
   * Query params (all optional; combined with AND logic; empty values ignored):
   * - q: string Search string matched against role_title and skills.
   * - industry: string Exact match on industry (case-insensitive).
   * - skills: string|string[] Comma-separated or repeated params; must all be present in core_skills_json.
   * - min_salary / max_salary: numbers Filter against estimated_salary_range (best-effort parsing).
   * - limit: number Max number of results to return (default: 10; max: 200).
   * - user_id: string If provided and DB-backed, result rows include is_targetable=false when role already exists in user_targets for that user.
   *
   * Response: Array<{ role_id, role_title, industry, skills_required, salary_range, match_metadata, is_targetable }>
   *
   * Empty state requirement:
   * - If no matches, return 200 with [] (NOT an error).
   */
  try {
    const debugRolesSearch = String(process.env.DEBUG_ROLES_SEARCH || '').toLowerCase() === 'true';

    const q = req.query?.q != null ? String(req.query.q).trim() : '';
    const industry = req.query?.industry != null ? String(req.query.industry).trim() : '';

    const userId = req.query?.user_id != null ? String(req.query.user_id).trim() : '';

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

    // Integration requirement: default limit=10, overrideable via query param.
    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const limit =
      Number.isFinite(limitRaw) && limitRaw != null ? Math.max(1, Math.min(Number(limitRaw), 200)) : 10;

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] filters:', {
        q,
        industry: industry || null,
        skills,
        minSalary: Number.isFinite(minSalary) ? minSalary : null,
        maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
        limit,
        userId: userId || null
      });
    }

    // Prefer DB-backed search when possible, but do NOT hard-gate the endpoint.
    // In some environments, DB credentials may be present but helper detection functions
    // can mis-detect, leading to a false "no DB" mode and empty results. We therefore:
    // 1) Attempt DB search when engine is mysql.
    // 2) If DB search fails, fall back to the in-memory catalog.
    const engine = getDbEngine();
    const shouldAttemptDb = engine === 'mysql';

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] repoSelection:', {
        engine,
        shouldAttemptDb
      });
    }

    // Helper: annotate rows with is_targetable if userId provided and DB is reachable.
    const annotateTargetableIfPossible = async (rows) => {
      const list = Array.isArray(rows) ? rows : [];
      const cleanUserId = String(userId || '').trim();
      if (!cleanUserId) {
        // Still standardize integration-ready output: include is_targetable=true when no user context.
        return list.map((r) => ({ ...r, is_targetable: true }));
      }

      // If DB isn't configured, we cannot check user_targets reliably.
      if (!isDbConfigured() || !isMysqlConfigured()) {
        return list.map((r) => ({ ...r, is_targetable: true }));
      }

      // Query user_targets for this user and compute a role_id set.
      const roleIds = list.map((r) => r?.role_id).filter(Boolean);
      if (roleIds.length === 0) return list.map((r) => ({ ...r, is_targetable: true }));

      const placeholders = roleIds.map(() => '?').join(',');
      const sql = `
        SELECT role_id
        FROM user_targets
        WHERE user_id = ?
          AND role_id IN (${placeholders})
      `;
      const params = [cleanUserId, ...roleIds];

      const res = await dbQuery(sql, params);
      const existing = new Set((res.rows || []).map((r) => r.role_id));

      return list.map((r) => ({
        ...r,
        is_targetable: !existing.has(r.role_id)
      }));
    };

    if (shouldAttemptDb) {
      try {
        const dbResult = await rolesRepo.searchRoles({
          q,
          industry: industry || null,
          skills,
          minSalary: Number.isFinite(minSalary) ? minSalary : null,
          maxSalary: Number.isFinite(maxSalary) ? maxSalary : null,
          limit
        });

        // Normalize repo result into an array.
        const rows = Array.isArray(dbResult) ? dbResult : Array.isArray(dbResult?.rows) ? dbResult.rows : [];

        if (debugRolesSearch) {
          // eslint-disable-next-line no-console
          console.log('[roles.search] (db) normalized:', {
            inputShape: Array.isArray(dbResult)
              ? 'array'
              : dbResult && typeof dbResult === 'object'
                ? 'object'
                : typeof dbResult,
            rowCount: rows.length
          });
        }

        const annotated = await annotateTargetableIfPossible(rows.slice(0, limit));
        return res.json(annotated);
      } catch (e) {
        if (debugRolesSearch) {
          // eslint-disable-next-line no-console
          console.log('[roles.search] (db) failed; falling back to memory:', e?.message || String(e));
        }
      }
    }

    // DB not available (or DB search failed): fall back to exported in-memory catalog.
    const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
    const catalog = Array.isArray(seed) ? seed : [];

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

    let matches = catalog
      .map((r) => {
        // Support BOTH shapes:
        // 1) API shape: { role_id, role_title, skills_required, salary_range }
        // 2) DEFAULT_ROLES_CATALOG shape:
        //    { roleTitle, coreSkills, estimatedSalaryRange, industry, ... }
        const title = String(r.role_title || r.roleTitle || '').trim();
        const ind = String(r.industry || '').trim();

        const skillsReq = Array.isArray(r.skills_required)
          ? r.skills_required
          : Array.isArray(r.coreSkills)
            ? r.coreSkills
            : [];

        const salaryRange = String(r.salary_range || r.estimatedSalaryRange || '').trim();
        const salaryBounds = parseSalaryBounds(salaryRange);

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

    // Standardize integration output for memory mode: include is_targetable (true).
    matches = (Array.isArray(matches) ? matches : []).slice(0, limit).map((r) => ({ ...r, is_targetable: true }));
    return res.json(matches);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
