'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');
const recommendationsService = require('../services/recommendationsService');
const bedrockService = require('../services/bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');
const onetService = require('../services/onetService');
const { validateThreeTwoBalance, buildThreeTwoReport, scoreRoleCompatibility } = require('../services/scoringEngine');
const {
  extractFinalPersonaObject,
  buildScoringUserSkills,
  normalizeSalaryToIndiaLpaRange,
} = require('../services/rolesSearchUtils');

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
    // O*NET does not provide an "industry" facet in the same way our seed catalog did.
    // For now, keep this endpoint stable and return an empty list (frontend handles it).
    // This is intentionally an ARRAY (not {industries:[]}) per backend contract in this file.
    return res.json([]);
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
    const seedKeyword = req.query?.seed ? String(req.query.seed).trim() : 'developer';
    const maxRaw = req.query?.max != null ? Number(req.query.max) : 60;
    const max = Number.isFinite(maxRaw) ? Math.max(10, Math.min(120, Math.round(maxRaw))) : 60;

    const { skills } = await onetService.getExploreFilterOptions({ seedKeyword, max });
    return res.json(Array.isArray(skills) ? skills : []);
  } catch (_) {
    // Per contract: always return [] with 200 on error
    return res.json([]);
  }
});

/**
 * Collect unique role title strings from role objects (DB or seed shapes).
 * Returns a sorted array of strings.
 */
function _deriveUniqueTitlesFromRoles(roles) {
  const set = new Map(); // key: lowercased, value: original label
  for (const r of Array.isArray(roles) ? roles : []) {
    const label = _normalizeLabel(r?.roleTitle ?? r?.role_title ?? r?.role_title ?? r?.title);
    if (!label) continue;
    const key = label.toLowerCase();
    if (!set.has(key)) set.set(key, label);
  }
  return Array.from(set.values()).sort(_sortCaseInsensitive);
}

/**
 * PUBLIC_INTERFACE
 * GET /api/roles/titles
 *
 * Returns distinct role title values for the Explore filters UI.
 *
 * IMPORTANT CONTRACT (to match /industries + /skills):
 * - Always returns a JSON array of strings (never an object envelope).
 * - On empty catalog OR on error, returns [] (HTTP 200).
 */
router.get('/titles', async (req, res) => {
  try {
    const roles = await _loadRolesForFilterOptions();
    const titles = _deriveUniqueTitlesFromRoles(roles);
    return res.json(Array.isArray(titles) ? titles : []);
  } catch (_) {
    return res.json([]);
  }
});

// PUBLIC_INTERFACE
router.get('/job-titles', async (req, res) => {
  /**
   * Backward-compatible endpoint for older clients.
   *
   * Response: { jobTitles: string[] }
   */
  try {
    const roles = await _loadRolesForFilterOptions();
    const jobTitles = _deriveUniqueTitlesFromRoles(roles);
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
    const query = String(req.query?.q || '').trim();
    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) && limitRaw != null ? Math.max(1, Math.min(Number(limitRaw), 20)) : 6;

    if (query.length < 2) return res.json([]);

    const titles = await onetService.autocompleteOccupations({ query, limit });
    return res.json(Array.isArray(titles) ? titles : []);
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
  /**
   * PUBLIC_INTERFACE
   * GET /api/roles/search
   *
   * Persona-driven Explore search:
   * - Uses Bedrock (Claude) to propose roles
   * - Grounds generation on O*NET occupation results
   * - Scores roles against the FINAL persona (when personaId is provided) and returns sorted results
   *
   * Query params:
   * - q: string (optional) keyword query
   * - limit: number (optional; default 30; max 50)  (currently returns up to 5)
   * - personaId: string (optional) persona id to load FINAL persona and compute persona-based scoring
   *
   * Response: Array<{
   *   role_id, role_title, industry, salary_range,
   *   description, key_responsibilities, experience_range,
   *   required_skills, skills_required,
   *   threeTwoReport, compatibilityScore, match_metadata
   * }>
   */
  try {
    const { exploreSearchRolesPersonaDriven } = require('../services/rolesExploreSearchService');

    const q = String(req.query?.q || '').replace(/\s+/g, ' ').trim();
    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : 30;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.round(limitRaw))) : 30;

    const personaId = req.query?.personaId ? String(req.query.personaId).trim() : null;

    const rows = await exploreSearchRolesPersonaDriven({ q, limit, personaId });
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (_) {
    // Always return JSON array (never HTML) to keep frontend resilient.
    return res.json([]);
  }
});

module.exports = router;
