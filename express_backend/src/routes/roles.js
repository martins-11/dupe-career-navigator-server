'use strict';

const express = require('express');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const { getDbEngine, isDbConfigured, isMysqlConfigured, dbQuery } = require('../db/connection');
const recommendationsService = require('../services/recommendationsService');
const bedrockService = require('../services/bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');
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
    // Per user_input_ref hardening: always coerce q to string before trimming.
    const query = String(req.query?.q || '').trim();

    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) && limitRaw != null ? Math.max(1, Math.min(Number(limitRaw), 20)) : 6;

    if (query.length < 2) return res.json([]);

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
          q: query,
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

    // Authoritative fix (user_input_ref): force query to string to avoid object.trim crashes.
    // Also collapse internal whitespace for cleaner prompts.
    const searchQuery = String(req.query?.q || '')
      .replace(/\s+/g, ' ')
      .trim();

    /**
     * Persona bridge:
     * When q is empty, Explore "Suggested Roles" should still be personalized.
     * We load the active finalized persona and generate Bedrock roles immediately, then score + sort.
     *
     * We accept an optional personaId to disambiguate which persona is "active".
     * If not provided, we best-effort fall back to:
     * - personasRepo.getFinal('active') (in-memory convention), else
     * - no persona (falls back to deterministic scoring defaults).
     */
    const personaId = req.query?.personaId != null ? String(req.query.personaId).trim() : '';

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

    const includeThreeTwoRaw = String(req.query?.include_three_two ?? 'true').toLowerCase();
    const includeThreeTwo = includeThreeTwoRaw !== 'false';

    // Parse salary params defensively (even if we don't use them for Bedrock generation yet).
    const parseOptionalNumber = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const minSalary = parseOptionalNumber(req.query?.min_salary);
    const maxSalary = parseOptionalNumber(req.query?.max_salary);

    // If the query is empty, we do NOT return static trending roles anymore.
    // Instead we generate suggested roles from the finalized persona (Day 3 requirement).
    if (!searchQuery) {
      let finalPersonaEnvelope = null;
      try {
        finalPersonaEnvelope = personaId ? await personasRepo.getFinal(personaId) : await personasRepo.getFinal('active');
      } catch (_) {
        finalPersonaEnvelope = null;
      }

      const finalPersonaObj = extractFinalPersonaObject(finalPersonaEnvelope);

      // Suggested-mode: always pass persona context and explicitly mark request type to avoid identical outputs.
      const userPersona = {
        query: '',
        requestType: 'suggested',
        persona: finalPersonaObj,
        skills: [],
        user_skills: [],
        min_salary: minSalary,
        max_salary: maxSalary,
      };

      if (debugRolesSearch) {
        // eslint-disable-next-line no-console
        console.log('[roles.search] suggestedRolesMode:', {
          personaId: personaId || '(default active)',
          hasFinalPersona: Boolean(finalPersonaObj),
          includeThreeTwo,
        });
      }

      const bedrockResult = await bedrockService.generateTargetedRolesSafe(userPersona);
      let { roles, prompt, modelId, usedFallback } = bedrockResult || {};

      if (typeof roles === 'string') {
        try {
          roles = JSON.parse(roles);
        } catch {
          const safe2 = await bedrockService.generateTargetedRolesSafe(userPersona);
          roles = safe2.roles;
          usedFallback = true;
        }
      }

      const rolesArray = Array.isArray(roles) ? roles : [];

      const fallbackUserSkills = [
        { name: 'Communication', proficiency: 50 },
        { name: 'Teamwork', proficiency: 50 },
        { name: 'Problem Solving', proficiency: 50 },
        { name: 'Time Management', proficiency: 50 },
        { name: 'Learning Agility', proficiency: 50 },
      ];

      const { userSkills: scoringUserSkills, usedPersonaProficiencies } = buildScoringUserSkills({
        finalPersonaEnvelope,
        fallbackUserSkills,
      });

      const enriched = (() => {
        try {
          const hasProficiency =
            Array.isArray(scoringUserSkills) &&
            scoringUserSkills.some((s) => s && typeof s === 'object' && s.proficiency != null);

          const scored = rolesArray.map((r) => {
            const roleReq = Array.isArray(r?.skills_required)
              ? r.skills_required
              : Array.isArray(r?.required_skills)
                ? r.required_skills
                : [];

            const balance = validateThreeTwoBalance(scoringUserSkills, roleReq);

            // Compatibility is computed strictly off proficiencies (final persona when present).
            const compat = hasProficiency
              ? scoreRoleCompatibility(scoringUserSkills, roleReq)
              : { score: 40, masteryAreas: [], growthAreas: [] };

            const compatibilityScore = compat.score;

            const threeTwoReport = {
              ...buildThreeTwoReport(scoringUserSkills, roleReq),
              masteryAreas: compat.masteryAreas,
              growthAreas: compat.growthAreas,
              isValidThreeTwo: Boolean(balance.isValidThreeTwo),
              status: balance.isValidThreeTwo ? 'validated' : 'not_validated',
            };

            const match_metadata = {
              ...(r?.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
              source: r?.match_metadata?.source || (usedFallback ? 'fallback' : 'bedrock'),
              usedFallback: Boolean(usedFallback),
              personaId: personaId || null,
              requestType: 'suggested',
              usedPersonaProficiencies: Boolean(usedPersonaProficiencies),
            };

            return {
              ...r,
              salary_range: normalizeSalaryToIndiaLpaRange(r?.salary_range),
              match_metadata,
              compatibilityScore,
              threeTwoReport: { ...threeTwoReport, score: compatibilityScore },
            };
          });

          scored.sort((a, b) => (Number(b.compatibilityScore) || 0) - (Number(a.compatibilityScore) || 0));
          return scored;
        } catch (scoreErr) {
          // eslint-disable-next-line no-console
          console.warn(
            '[roles.search] scoring enrichment failed (suggested mode); returning unscored roles:',
            scoreErr?.message || scoreErr,
          );
          return rolesArray.map((r) => ({ ...r, salary_range: normalizeSalaryToIndiaLpaRange(r?.salary_range) }));
        }
      })();

      if (debugRolesSearch) {
        // eslint-disable-next-line no-console
        console.log('[roles.search] suggested bedrockPrompt/model:', {
          modelId,
          promptPreview: String(prompt).slice(0, 500),
        });
      }

      return res.json(enriched);
    }

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

    const userSkillsJson = parseJsonQuery('user_skills_json');
    const validatedSkillsJson = parseJsonQuery('validated_skills_json');

    // If personaId is provided, prefer finalized persona proficiencies for scoring (even in searched mode).
    let finalPersonaEnvelope = null;
    try {
      if (personaId) finalPersonaEnvelope = await personasRepo.getFinal(personaId);
    } catch (_) {
      finalPersonaEnvelope = null;
    }

    const finalPersonaObj = extractFinalPersonaObject(finalPersonaEnvelope);

    const userPersona = {
      query: searchQuery,
      requestType: 'searched',
      persona: finalPersonaObj,
      skills:
        skills.length > 0
          ? skills
          : Array.isArray(validatedSkillsJson)
            ? validatedSkillsJson
            : Array.isArray(userSkillsJson)
              ? userSkillsJson
              : [],
      user_skills: Array.isArray(userSkillsJson) ? userSkillsJson : [],
      min_salary: minSalary,
      max_salary: maxSalary,
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

    const bedrockResult = await bedrockService.generateTargetedRolesSafe(userPersona);

    let { roles, prompt, modelId, usedFallback } = bedrockResult || {};

    if (typeof roles === 'string') {
      try {
        roles = JSON.parse(roles);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[roles.search] Bedrock roles JSON.parse failed; using fallback generator:', e?.message || e);
        const safe2 = await bedrockService.generateTargetedRolesSafe(userPersona);
        roles = safe2.roles;
        usedFallback = true;
      }
    }

    const rolesArray = Array.isArray(roles) ? roles : [];

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

    const fallbackUserSkills = [
      { name: 'Communication', proficiency: 50 },
      { name: 'Teamwork', proficiency: 50 },
      { name: 'Problem Solving', proficiency: 50 },
      { name: 'Time Management', proficiency: 50 },
      { name: 'Learning Agility', proficiency: 50 },
    ];

    // Prefer finalized persona proficiencies (when personaId present), else user_skills_json, else fallback.
    const { userSkills: personaScoringSkills, usedPersonaProficiencies } = buildScoringUserSkills({
      finalPersonaEnvelope,
      fallbackUserSkills,
    });

    const scoringUserSkills =
      Array.isArray(userPersona.user_skills) && userPersona.user_skills.length > 0 ? userPersona.user_skills : personaScoringSkills;

    const enriched = (() => {
      try {
        const hasProficiency =
          Array.isArray(scoringUserSkills) && scoringUserSkills.some((s) => s && typeof s === 'object' && s.proficiency != null);

        const scored = rolesArray.map((r) => {
          const roleReq = Array.isArray(r?.skills_required)
            ? r.skills_required
            : Array.isArray(r?.required_skills)
              ? r.required_skills
              : [];

          const balance = validateThreeTwoBalance(scoringUserSkills, roleReq);

          const compat = hasProficiency
            ? scoreRoleCompatibility(scoringUserSkills, roleReq)
            : { score: 40, masteryAreas: [], growthAreas: [] };

          const compatibilityScore = compat.score;

          const threeTwoReport = {
            ...buildThreeTwoReport(scoringUserSkills, roleReq),
            masteryAreas: compat.masteryAreas,
            growthAreas: compat.growthAreas,
            isValidThreeTwo: Boolean(balance.isValidThreeTwo),
            status: balance.isValidThreeTwo ? 'validated' : 'not_validated',
          };

          const match_metadata = {
            ...(r?.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
            source: r?.match_metadata?.source || (usedFallback ? 'fallback' : 'bedrock'),
            usedFallback: Boolean(usedFallback),
            personaId: personaId || null,
            requestType: 'searched',
            usedPersonaProficiencies: Boolean(usedPersonaProficiencies),
          };

          return {
            ...r,
            salary_range: normalizeSalaryToIndiaLpaRange(r?.salary_range),
            match_metadata,
            compatibilityScore,
            threeTwoReport: { ...threeTwoReport, score: compatibilityScore },
          };
        });

        scored.sort((a, b) => (Number(b.compatibilityScore) || 0) - (Number(a.compatibilityScore) || 0));
        return scored;
      } catch (scoreErr) {
        // eslint-disable-next-line no-console
        console.warn('[roles.search] scoring enrichment failed; returning unscored roles:', scoreErr?.message || scoreErr);
        return rolesArray.map((r) => ({ ...r, salary_range: normalizeSalaryToIndiaLpaRange(r?.salary_range) }));
      }
    })();

    if (debugRolesSearch) {
      // eslint-disable-next-line no-console
      console.log('[roles.search] bedrockPrompt/model:', { modelId, promptPreview: String(prompt).slice(0, 500) });
    }

    return res.json(enriched);
  } catch (err) {
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
