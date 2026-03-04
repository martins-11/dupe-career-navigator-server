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

/**
 * Normalizes a display string for stable sorting/deduping.
 * - trims whitespace
 * - collapses internal whitespace
 */
function _normalizeLabel(v) {
  if (v == null) return '';
  return String(v)
    .replace(/\s+/g, ' ')
    .trim();
}

function _sortCaseInsensitive(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

/**
 * Salary alignment note (frontend vs backend):
 * - The Explore UI currently presents salary range in "L" (lakhs; e.g. 0–60).
 * - The roles catalog (DB + seed) stores salary ranges like "$130k-$210k" (USD).
 *
 * To prevent the default UI slider from excluding all results (e.g. max_salary=60 vs $130k),
 * we interpret min_salary/max_salary from the UI as lakhs and convert to an approximate USD
 * annual amount for catalog filtering:
 *    dollars ~= (lakhs * 100_000) / USD_TO_INR
 *
 * USD_TO_INR is env-driven with a safe default.
 */
function _uiLakhsToApproxUsdDollars(lakhs) {
  if (lakhs == null) return null;
  const n = Number(lakhs);
  if (!Number.isFinite(n)) return null;

  const usdToInrRaw = Number(process.env.USD_TO_INR || 83);
  const usdToInr = Number.isFinite(usdToInrRaw) && usdToInrRaw > 0 ? usdToInrRaw : 83;

  // 1 lakh = 100,000 INR
  return Math.round((n * 100000) / usdToInr);
}

async function _loadRolesForFilterOptions() {
  /**
   * Loads the roles source of truth to derive filter options.
   *
   * Preference order:
   * 1) DB-backed catalog (MySQL) if reachable and listRoles works
   * 2) In-memory DEFAULT_ROLES_CATALOG (seed catalog)
   *
   * Returns a unified array of role objects that may be in either shape:
   * - DB listRoles shape: { roleId, roleTitle, industry, coreSkills, ... }
   * - Seed shape: { roleTitle, industry, coreSkills, ... }
   */
  const engine = getDbEngine();
  const shouldAttemptDb = engine === 'mysql';

  if (shouldAttemptDb) {
    try {
      // listRoles is already guarded by config checks in the adapter.
      // If it returns [], we fall back to seed catalog.
      const dbRoles = await rolesRepo.listRoles({ limit: 5000 });
      if (Array.isArray(dbRoles) && dbRoles.length > 0) return dbRoles;
    } catch (_) {
      // Fall through to memory catalog
    }
  }

  const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
  return Array.isArray(seed) ? seed : [];
}

/**
 * PUBLIC_INTERFACE
 * GET /api/roles/industries
 *
 * Returns distinct industry values for the Explore filters UI.
 *
 * IMPORTANT CONTRACT:
 * - Always returns a JSON array of strings (never an object envelope).
 * - On empty catalog OR on error, returns [] (HTTP 200).
 */
router.get('/industries', async (req, res) => {
  try {
    const roles = await _loadRolesForFilterOptions();
    const set = new Map(); // key: lowercased, value: original label

    for (const r of roles) {
      const label = _normalizeLabel(r?.industry);
      if (!label) continue;
      const key = label.toLowerCase();
      if (!set.has(key)) set.set(key, label);
    }

    const industries = Array.from(set.values()).sort(_sortCaseInsensitive);
    return res.json(Array.isArray(industries) ? industries : []);
  } catch (_) {
    return res.json([]);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/roles/skills
 *
 * Returns distinct skill values for the Explore filters UI.
 *
 * IMPORTANT CONTRACT:
 * - Always returns a JSON array of strings (never an object envelope).
 * - On empty catalog OR on error, returns [] (HTTP 200).
 */
router.get('/skills', async (req, res) => {
  try {
    const roles = await _loadRolesForFilterOptions();
    const set = new Map(); // key: lowercased, value: original label

    for (const r of roles) {
      const skills = Array.isArray(r?.coreSkills) ? r.coreSkills : Array.isArray(r?.skills_required) ? r.skills_required : [];
      for (const s of skills) {
        const label = _normalizeLabel(s);
        if (!label) continue;
        const key = label.toLowerCase();
        if (!set.has(key)) set.set(key, label);
      }
    }

    const skills = Array.from(set.values()).sort(_sortCaseInsensitive);
    return res.json(Array.isArray(skills) ? skills : []);
  } catch (_) {
    return res.json([]);
  }
});

// PUBLIC_INTERFACE
router.get('/job-titles', async (req, res) => {
  /**
   * (Optional) Return distinct job title values for the Explore filters UI.
   *
   * Response: { jobTitles: string[] }
   */
  try {
    const roles = await _loadRolesForFilterOptions();
    const set = new Map(); // key: lowercased, value: original label

    for (const r of roles) {
      const label = _normalizeLabel(r?.roleTitle ?? r?.role_title ?? r?.title);
      if (!label) continue;
      const key = label.toLowerCase();
      if (!set.has(key)) set.set(key, label);
    }

    const jobTitles = Array.from(set.values()).sort(_sortCaseInsensitive);
    return res.json({ jobTitles });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/roles/autocomplete
 *
 * Returns role title suggestions for the Explore SearchBar.
 *
 * Query params:
 * - q: string (if <2 chars returns [])
 * - limit: number (optional; default 6; max 20)
 *
 * Response: string[] (role titles)
 */
router.get('/autocomplete', async (req, res) => {
  try {
    const q = req.query?.q != null ? String(req.query.q).trim() : '';
    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) && limitRaw != null ? Math.max(1, Math.min(Number(limitRaw), 20)) : 6;

    if (q.length < 2) return res.json([]);

    const collectTitles = (rows) => {
      const seen = new Set();
      const out = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const title = String(r?.role_title ?? r?.roleTitle ?? r?.title ?? '').trim();
        if (!title) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(title);
        if (out.length >= limit) break;
      }
      return out;
    };

    const engine = getDbEngine();
    const shouldAttemptDb = engine === 'mysql';

    if (shouldAttemptDb) {
      try {
        const dbResult = await rolesRepo.searchRoles({
          q,
          industry: null,
          skills: [],
          minSalary: null,
          maxSalary: null,
          limit
        });
        const rows = Array.isArray(dbResult) ? dbResult : Array.isArray(dbResult?.rows) ? dbResult.rows : [];
        return res.json(collectTitles(rows));
      } catch (_) {
        // fall through
      }
    }

    const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
    return res.json(collectTitles(Array.isArray(seed) ? seed : []));
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.get('/search', async (req, res) => {
  /**
   * Search roles with optional filtering (unified query handling).
   *
   * Query params (all optional; combined with AND logic; empty values ignored):
   * - q: string Search string matched against role_title and skills.
   * - industry: string Exact match on industry (case-insensitive).
   * - skills: string|string[] Comma-separated or repeated params; must all be present in core_skills_json.
   * - min_salary / max_salary: numbers Salary filter from UI slider (lakhs). Converted to approx USD for catalog filtering.
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
    const minSalaryUi = Number.isFinite(minSalaryParsed) ? minSalaryParsed : null;

    const maxSalaryRaw = req.query?.max_salary != null ? String(req.query.max_salary).trim() : '';
    const maxSalaryParsed = maxSalaryRaw !== '' ? Number(maxSalaryRaw) : null;
    const maxSalaryUi = Number.isFinite(maxSalaryParsed) ? maxSalaryParsed : null;

    // Convert UI slider (lakhs) to approx USD dollars for catalog filtering.
    const minSalaryUsd = minSalaryUi != null ? _uiLakhsToApproxUsdDollars(minSalaryUi) : null;
    const maxSalaryUsd = maxSalaryUi != null ? _uiLakhsToApproxUsdDollars(maxSalaryUi) : null;

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
        minSalaryUi: Number.isFinite(minSalaryUi) ? minSalaryUi : null,
        maxSalaryUi: Number.isFinite(maxSalaryUi) ? maxSalaryUi : null,
        minSalaryUsd: Number.isFinite(minSalaryUsd) ? minSalaryUsd : null,
        maxSalaryUsd: Number.isFinite(maxSalaryUsd) ? maxSalaryUsd : null,
        limit,
        userId: userId || null
      });
    }

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
          minSalary: Number.isFinite(minSalaryUsd) ? minSalaryUsd : null,
          maxSalary: Number.isFinite(maxSalaryUsd) ? maxSalaryUsd : null,
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

    // Use *converted* salary bounds in memory filtering too.
    const minS = minSalaryUsd != null && Number.isFinite(minSalaryUsd) && minSalaryUsd > 0 ? minSalaryUsd : null;
    const maxS = maxSalaryUsd != null && Number.isFinite(maxSalaryUsd) && maxSalaryUsd > 0 ? maxSalaryUsd : null;

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

        if (minS != null) {
          const { min, max } = r._internal.salaryBounds || { min: null, max: null };
          if (min == null && max == null) return false;
          const roleMax = max != null ? max : min;
          if (roleMax == null || roleMax < minS) return false;
        }

        if (maxS != null) {
          const { min, max } = r._internal.salaryBounds || { min: null, max: null };
          if (min == null && max == null) return false;
          const roleMin = min != null ? min : max;
          if (roleMin == null || roleMin > maxS) return false;
        }

        return true;
      })
      .map((r) => {
        const matchedFilters = [];
        if (qNorm) matchedFilters.push('q');
        if (industryNorm) matchedFilters.push('industry');
        if (requiredSkills.length > 0) matchedFilters.push('skills');
        if (minS != null) matchedFilters.push('min_salary');
        if (maxS != null) matchedFilters.push('max_salary');

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
