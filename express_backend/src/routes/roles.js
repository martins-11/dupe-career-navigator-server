'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');
const recommendationsService = require('../services/recommendationsService');
const bedrockService = require('../services/bedrockService');
const { buildThreeTwoReport } = require('../services/scoringEngine');

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

/**
 * PUBLIC_INTERFACE
 * GET /api/roles/search
 *
 * TEMPORARY ROUTE FIX (per user_input_ref):
 * - Bypass SQL/DB role search entirely.
 * - Use Amazon Bedrock (Claude 3 Haiku) to generate 5 targeted roles based on provided user skills/persona.
 * - Return strict JSON (array) to prevent frontend crashes on HTML error pages.
 *
 * HARDENING (per user_input_ref step 01.01):
 * - Coerce req.query.q via String(...).trim() to avoid `trim is not a function`.
 * - If query is empty, return default "Trending Roles" and do not call Bedrock.
 * - Only JSON.parse Bedrock output when it is a string.
 *
 * Query params:
 * - q: string (optional) Search query entered in Explore.
 * - skills: string|string[] (optional) Comma-separated or repeated params (preferred minimal input).
 * - user_skills_json: string (optional) JSON array of user skills. Supports:
 *    - ["React","Node.js",...]
 *    - [{ "name": "React", "proficiency": 90 }, ...]  (allows 3/2 scoring)
 * - validated_skills_json: string (optional) JSON array of skills, like ["SQL","Python"]
 * - include_three_two: "true"|"false" (optional; default true) include 3/2 report if proficiencies exist
 *
 * Response: Array<{ role_id, role_title, industry, skills_required, salary_range, match_metadata, is_targetable, threeTwoReport? }>
 */
router.get('/search', async (req, res) => {
  try {
    const debugRolesSearch = String(process.env.DEBUG_ROLES_SEARCH || '').toLowerCase() === 'true';

    // Coerce q to a string before trimming (prevents `trim is not a function` crashes).
    // Also collapse internal whitespace so Bedrock sees a clean query string.
    const searchQuery = String(req.query?.q || '')
      .replace(/\s+/g, ' ')
      .trim();

    // If the query is empty, return default "Trending Roles" and skip Bedrock entirely.
    if (!searchQuery) {
      const trending = recommendationsService?.DEFAULT_ROLES_CATALOG;
      const rolesArray = Array.isArray(trending) ? trending : [];
      return res.json(rolesArray.slice(0, 5));
    }

    // Parse salary params defensively:
    // - Empty string -> null
    // - Non-numeric -> null
    // NOTE: We do not currently apply salary filters in this Bedrock route, but we must
    // never crash just because the frontend includes min_salary/max_salary keys with empty values.
    const parseOptionalNumber = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    const minSalary = parseOptionalNumber(req.query?.min_salary);
    const maxSalary = parseOptionalNumber(req.query?.max_salary);

    // Build a minimal userPersona object from query params (since this is a GET route).
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

    const parseJsonQuery = (k) => {
      const v = req.query?.[k];
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      try {
        return JSON.parse(s);
      } catch (_) {
        return null;
      }
    };

    const userSkillsJson = parseJsonQuery('user_skills_json');
    const validatedSkillsJson = parseJsonQuery('validated_skills_json');

    const includeThreeTwoRaw = String(req.query?.include_three_two ?? 'true').toLowerCase();
    const includeThreeTwo = includeThreeTwoRaw !== 'false';

    const userPersona = {
      // Bedrock should receive a clean query string (no weird whitespace, always a string).
      query: searchQuery,
      // For prompt: prioritize explicit skills list; otherwise use validated_skills_json; else user_skills_json as strings.
      skills:
        skills.length > 0 ? skills
        : Array.isArray(validatedSkillsJson) ? validatedSkillsJson
        : Array.isArray(userSkillsJson) ? userSkillsJson
        : [],
      // For scoring: pass through proficiency-bearing structures if present.
      user_skills: Array.isArray(userSkillsJson) ? userSkillsJson : [],
      // Keep these for future use (filters), but do not rely on them being present.
      min_salary: minSalary,
      max_salary: maxSalary
    };

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] bedrockMode:', {
        searchQueryPreview: searchQuery.slice(0, 80),
        skillsCount: Array.isArray(userPersona.skills) ? userPersona.skills.length : null,
        hasUserSkillsJson: Array.isArray(userSkillsJson),
        includeThreeTwo,
        minSalary,
        maxSalary
      });
    }

    // Call Bedrock to generate roles. Service is expected to return strict JSON, but we defensively
    // handle cases where `roles` might be a JSON string.
    let bedrockResult;
    try {
      bedrockResult = await bedrockService.generateTargetedRoles(userPersona);
    } catch (bedrockErr) {
      // HARDENING requirement (user_input_ref): never 500 the UI due to Bedrock failures.
      // Return a hardcoded fallback "3/2 role" instead.
      // eslint-disable-next-line no-console
      console.warn('[roles.search] Bedrock failed; returning fallback role:', bedrockErr?.message || bedrockErr);

      return res.json([
        {
          role_id: 'fallback-3-2-role',
          role_title: 'Fallback 3/2 Role',
          industry: 'General',
          skills_required: ['Communication', 'Problem Solving', 'Teamwork', 'Learning Agility', 'Stakeholder Management'],
          salary_range: 'N/A',
          match_metadata: { source: 'fallback', reason: 'bedrock_failure' },
          is_targetable: true,
          threeTwoReport: {
            status: 'fallback',
            masterySkills: [],
            growthSkills: [],
            missingSkills: []
          }
        }
      ]);
    }

    let { roles, prompt, modelId } = bedrockResult || {};

    // Only JSON.parse Bedrock output when it is a string, and do so safely.
    if (typeof roles === 'string') {
      try {
        roles = JSON.parse(roles);
      } catch (e) {
        // HARDENING requirement: if parsing fails, do not throw -> return fallback role
        // eslint-disable-next-line no-console
        console.warn('[roles.search] Bedrock roles JSON.parse failed; returning fallback role:', e?.message || e);

        return res.json([
          {
            role_id: 'fallback-3-2-role',
            role_title: 'Fallback 3/2 Role',
            industry: 'General',
            skills_required: ['Communication', 'Problem Solving', 'Teamwork', 'Learning Agility', 'Stakeholder Management'],
            salary_range: 'N/A',
            match_metadata: { source: 'fallback', reason: 'bedrock_parse_failure' },
            is_targetable: true,
            threeTwoReport: {
              status: 'fallback',
              masterySkills: [],
              growthSkills: [],
              missingSkills: []
            }
          }
        ]);
      }
    }

    // Ensure we always have an array for downstream mapping (avoid 500s from calling .map on non-array).
    const rolesArray = Array.isArray(roles) ? roles : [];

    // If Bedrock returned no usable roles, still keep the UI alive.
    if (rolesArray.length === 0) {
      return res.json([
        {
          role_id: 'fallback-3-2-role',
          role_title: 'Fallback 3/2 Role',
          industry: 'General',
          skills_required: ['Communication', 'Problem Solving', 'Teamwork', 'Learning Agility', 'Stakeholder Management'],
          salary_range: 'N/A',
          match_metadata: { source: 'fallback', reason: 'empty_roles' },
          is_targetable: true,
          threeTwoReport: {
            status: 'fallback',
            masterySkills: [],
            growthSkills: [],
            missingSkills: []
          }
        }
      ]);
    }

    // Fallback persona/user skills:
    // If no persona is active (or skills are missing), use a safe mock so scoring doesn't throw.
    // Scoring engine itself will mark "not_validated" if proficiency data is absent.
    const fallbackUserSkills = [
      // Minimal safe defaults; no proficiency => "not_validated" if scoring attempted anyway.
      { name: 'Communication', proficiency: 50 },
      { name: 'Teamwork', proficiency: 50 },
      { name: 'Problem Solving', proficiency: 50 },
      { name: 'Time Management', proficiency: 50 },
      { name: 'Learning Agility', proficiency: 50 }
    ];

    const scoringUserSkills =
      Array.isArray(userPersona.user_skills) && userPersona.user_skills.length > 0 ? userPersona.user_skills : fallbackUserSkills;

    // Optional: enrich with 3/2 scoring if we have proficiency-bearing user skills.
    // IMPORTANT: wrap Bedrock-to-scoring logic in try/catch so enrichment can't crash the route.
    const enriched = (() => {
      try {
        const shouldScore =
          includeThreeTwo &&
          Array.isArray(scoringUserSkills) &&
          scoringUserSkills.some(
            (s) => s && typeof s === 'object' && (s.proficiency != null || s.proficiency_percent != null || s.proficiencyPercent != null)
          );

        return rolesArray.map((r) => {
          if (!shouldScore) return r;
          const threeTwoReport = buildThreeTwoReport(scoringUserSkills, r?.skills_required || []);
          return { ...r, threeTwoReport };
        });
      } catch (scoreErr) {
        // eslint-disable-next-line no-console
        console.warn('[roles.search] scoring enrichment failed; returning unscored roles:', scoreErr?.message || scoreErr);
        return rolesArray;
      }
    })();

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] bedrockPrompt/model:', { modelId, promptPreview: String(prompt).slice(0, 500) });
    }

    // Keep strict JSON output (array only).
    return res.json(enriched);
  } catch (err) {
    // Last-resort hardening: still do not leak HTML errors; return JSON with fallback role to protect UI.
    // eslint-disable-next-line no-console
    console.warn('[roles.search] unexpected failure; returning fallback role:', err?.message || err);

    return res.json([
      {
        role_id: 'fallback-3-2-role',
        role_title: 'Fallback 3/2 Role',
        industry: 'General',
        skills_required: ['Communication', 'Problem Solving', 'Teamwork', 'Learning Agility', 'Stakeholder Management'],
        salary_range: 'N/A',
        match_metadata: { source: 'fallback', reason: 'unexpected_error' },
        is_targetable: true,
        threeTwoReport: {
          status: 'fallback',
          masterySkills: [],
          growthSkills: [],
          missingSkills: []
        }
      }
    ]);
  }
});

module.exports = router;
