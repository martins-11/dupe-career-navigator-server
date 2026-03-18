import bedrockService from './bedrockService.js';
import personasRepo from '../repositories/personasRepoAdapter.js';
import holisticPersonaRepo from '../repositories/holisticPersonaRepoAdapter.js';
import { buildThreeTwoReport, scoreRoleCompatibility } from './scoringEngine.js';
import {
  extractFinalPersonaObject,
  buildScoringUserSkills,
  normalizeSalaryToIndiaLpaRange
} from './rolesSearchUtils.js';

function _normStr(v) {
  return String(v || '').trim();
}

/**
 * Normalizes strings for "fuzzy" comparison (e.g., Node.js === nodejs)
 */
function _normalizeForFuzzyMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function _safeSlice(arr, n) {
  return (Array.isArray(arr) ? arr : []).slice(0, n);
}

async function _loadFinalPersonaEnvelope(personaId) {
  if (!personaId) return null;
  return personasRepo.getFinal(personaId);
}

function _extractValidatedSkillNames(finalPersonaObj) {
  const p = finalPersonaObj && typeof finalPersonaObj === 'object' ? finalPersonaObj : {};
  const candidates = [p.validated_skills, p.validatedSkills, p.skills, p.core_skills];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }
  return [];
}

function _decorateAndScoreRoles({ roles, scoringUserSkills }) {
  const out = [];
  
  for (const r of Array.isArray(roles) ? roles : []) {
    const rawReq = r.required_skills || r.skills_required || [];
    const requiredSkills = Array.isArray(rawReq) 
      ? rawReq.map(s => _normStr(s)).filter(Boolean).slice(0, 10)
      : [];

    /**
     * FUZZY MATCHING LOGIC:
     * We create a version of user skills where names match the AI's output
     * if they are semantically the same (e.g. "Node.js" vs "NodeJS").
     */
    const fuzzyUserSkills = scoringUserSkills.map(uSkill => {
      const uNorm = _normalizeForFuzzyMatch(uSkill.name || uSkill.skill);
      const matchingReqSkill = requiredSkills.find(rSkill => _normalizeForFuzzyMatch(rSkill) === uNorm);
      
      return {
        ...uSkill,
        name: matchingReqSkill || uSkill.name // Temporarily rename to match role for the scoring engine
      };
    });

    const report = buildThreeTwoReport(fuzzyUserSkills, requiredSkills);
    const compat = scoreRoleCompatibility(fuzzyUserSkills, requiredSkills);

    const requiredSkillsCount = requiredSkills.length;
    const masteryCount = Array.isArray(compat.masteryAreas) ? compat.masteryAreas.length : 0;
    const growthCount = Array.isArray(compat.growthAreas) ? compat.growthAreas.length : 0;

    const masteryScore = requiredSkillsCount ? Math.round((masteryCount / requiredSkillsCount) * 100) : 0;
    const growthScore = requiredSkillsCount ? Math.round((growthCount / requiredSkillsCount) * 100) : 0;

    const salaryRaw = r.salary_range || r.salaryRange || r.salary_lpa_range || r.salaryLpaRange || '';

    out.push({
      ...r,
      // Ensure a consistent field name for UI filtering across stored vs Bedrock-search roles.
      salary_range: normalizeSalaryToIndiaLpaRange(salaryRaw),
      required_skills: requiredSkills,

      // Keep existing payload, but add explicit fields the frontend rings can reliably use.
      threeTwoReport: {
        ...report,
        compatibilityScore: compat.score,
      },
      compatibilityScore: compat.score,
      finalCompatibilityScore: Math.max(
        0,
        Math.min(
          100,
          Math.round(0.6 * (compat.score || 0) + 0.4 * (report.status === 'validated' ? 100 : 0))
        )
      ),

      masteryAreas: compat.masteryAreas,
      growthAreas: compat.growthAreas,
      masteryScore,
      growthScore,
      masteryCount,
      growthCount,

      match_metadata: {
        ...(r.match_metadata || {}),
        scoring: {
          usedFuzzyMatching: true,
          matchedSkillCount: report.masteryAreas.length + report.growthAreas.length,
          requiredSkillsCount,
          threeTwoValidationScore: report.status === 'validated' ? 100 : 0,
        },
      },
    });
  }

  out.sort((a, b) => (b.compatibilityScore || 0) - (a.compatibilityScore || 0));
  return out;
}

/**
 * PUBLIC_INTERFACE
 * Persona-driven Bedrock role exploration/search.
 *
 * IMPORTANT:
 * - This function must honor the caller's `limit` (autocomplete uses small limits).
 * - This function must NOT introduce any deterministic fallback/padding behavior. If Bedrock fails,
 *   Bedrock wrapper is invoked with allowFallback=false and callers should receive [].
 */
async function exploreSearchRolesPersonaDriven({ q, limit = 30, personaId = null } = {}) {
  const searchQuery = _normStr(q);

  // Honor caller limit, but keep it within a safe bound.
  const limitNum = Number(limit);
  const effectiveLimit =
    Number.isFinite(limitNum) && limitNum > 0 ? Math.max(1, Math.min(limitNum, 100)) : 30;

  const _looksLikeLegacySimpleRecommendedRole = (r) => {
    // /api/recommendations/roles shape (must NOT be treated as Explore pool)
    return Boolean(r && typeof r === 'object' && typeof r.match_reason === 'string' && r.match_reason.length > 0);
  };

  const _looksLikeInitialRecommendationsPool = (roles) => {
    /**
     * Bedrock initial recommendations pool is expected to include match_metadata and/or role-card fields.
     * If the cached entry is the legacy "simple recommended roles" shape, do not use it here—otherwise
     * it will suppress Bedrock Explore search indefinitely.
     */
    const arr = Array.isArray(roles) ? roles : [];
    if (arr.length < 5) return false;

    if (arr.some(_looksLikeLegacySimpleRecommendedRole)) return false;

    // Heuristic: initial pool entries have match_metadata and required_skills.
    return arr.some((r) => r?.match_metadata && typeof r.match_metadata === 'object');
  };

  // 1) Prefer stored recommendations roles for this personaId (source of truth for Explore UX),
  //    but ONLY if it is the Bedrock initial-recommendations pool.
  if (personaId) {
    try {
      const cached = await holisticPersonaRepo.getLatestRecommendationsRoles({ personaId: String(personaId).trim() });
      const cachedRoles = Array.isArray(cached?.roles) ? cached.roles : [];

      if (_looksLikeInitialRecommendationsPool(cachedRoles)) {
        const qLower = searchQuery.toLowerCase();

        const matchesQuery = (role) => {
          if (!qLower) return true;

          const title = _normStr(role?.title || role?.role_title || role?.roleTitle).toLowerCase();
          const industry = _normStr(role?.industry).toLowerCase();
          const desc = _normStr(role?.description).toLowerCase();

          const skillsRaw = role?.required_skills || role?.skills_required || role?.skills || [];
          const skills = (Array.isArray(skillsRaw) ? skillsRaw : [])
            .map((s) => (typeof s === 'string' ? s : s?.name || s?.skill || s?.label))
            .map((s) => _normStr(s).toLowerCase())
            .filter(Boolean);

          // Token-based matching across multiple fields.
          const haystack = `${title} ${industry} ${desc} ${skills.join(' ')}`;
          const tokens = qLower.split(/\s+/g).map((t) => t.trim()).filter(Boolean);

          // Require ALL tokens to be present somewhere (keeps results tighter).
          return tokens.every((t) => haystack.includes(t));
        };

        const filtered = cachedRoles.filter(matchesQuery);

        // Keep existing ordering (already compatibility-ranked by initial recommendations).
        return _safeSlice(filtered, effectiveLimit);
      }
    } catch (err) {
      console.error('[ExploreService] Failed to read cached recommendations roles:', err?.message || String(err));
      // Fall through to Bedrock if cache is unavailable.
    }
  }

  // 2) If no stored pool exists, fall back to Bedrock (strict mode; no deterministic padding).
  let finalEnvelope = null;
  let finalPersonaObj = null;

  if (personaId) {
    try {
      finalEnvelope = await _loadFinalPersonaEnvelope(personaId);
      finalPersonaObj = extractFinalPersonaObject(finalEnvelope);
    } catch (err) {
      console.error('[ExploreService] DB Load Error:', err.message);
    }
  }

  const validatedSkillNames = _extractValidatedSkillNames(finalPersonaObj);
  const { userSkills: scoringUserSkills } = buildScoringUserSkills({
    finalPersonaEnvelope: finalEnvelope,
    fallbackUserSkills: []
  });

  const bedrock = await bedrockService.generateTargetedRolesSafe(
    {
      query: searchQuery,
      finalPersonaObj: finalPersonaObj || {},
      scoringUserSkills,
      validated_skills: validatedSkillNames
    },
    {
      // CRITICAL: Explore autocomplete/search must not show deterministic static fallback titles.
      // If Bedrock fails, return [] so the UI can show "no suggestions" gracefully.
      allowFallback: false
    }
  );

  const roles = Array.isArray(bedrock?.roles) ? bedrock.roles : [];
  const scored = _decorateAndScoreRoles({ roles, scoringUserSkills });

  return _safeSlice(scored, effectiveLimit);
}

export { exploreSearchRolesPersonaDriven };
export default { exploreSearchRolesPersonaDriven };