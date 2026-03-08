'use strict';

const bedrockService = require('./bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');
const { extractFinalPersonaObject, buildScoringUserSkills, normalizeSalaryToIndiaLpaRange } = require('./rolesSearchUtils');

function _normStr(v) {
  return String(v || '').trim();
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
  const candidates = [p.validated_skills, p.validatedSkills, p.skills, p.core_skills, p.coreSkills];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.skill_name || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }

  // If the persona doesn't have explicit validated skills, fall back to proficiency-derived list
  const profCandidates = [p.user_skills, p.userSkills, p.skills_with_proficiency, p.skillsWithProficiency, p.skillProficiencies];
  for (const arr of profCandidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.skill_name || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }

  return [];
}

function _toPersonaPayloadForBedrock({ query, finalPersonaObj, scoringUserSkills, validatedSkillNames }) {
  const personaIndustry = _normStr(finalPersonaObj?.industry || finalPersonaObj?.profile?.industry || '');
  const personaHeadline = _normStr(finalPersonaObj?.current_role || finalPersonaObj?.currentRole || finalPersonaObj?.profile?.headline || '');

  return {
    requestType: query ? 'searched' : 'suggested',
    query: query || '',
    industry: personaIndustry || undefined,
    persona: finalPersonaObj,
    // help Bedrock match persona
    validated_skills: validatedSkillNames,
    // help scoring & Bedrock (it supports user_skills objects)
    user_skills: scoringUserSkills,
    // extra hint for variety/targeting
    context: { personaHeadline, personaIndustry }
  };
}

function _decorateAndScoreRoles({ roles, scoringUserSkills }) {
  const out = [];
  for (const r of Array.isArray(roles) ? roles : []) {
    const requiredSkills = Array.isArray(r.required_skills)
      ? r.required_skills.map((s) => _normStr(s)).filter(Boolean).slice(0, 10)
      : Array.isArray(r.skills_required)
        ? r.skills_required.map((s) => _normStr(s)).filter(Boolean).slice(0, 10)
        : [];

    const report = buildThreeTwoReport(scoringUserSkills, requiredSkills);
    const compat = scoreRoleCompatibility(scoringUserSkills, requiredSkills);

    out.push({
      ...r,
      // unify salary to INR LPA when possible (Explore UI expects lakhs slider; still ok as string)
      salary_range: normalizeSalaryToIndiaLpaRange(r.salary_range || r.salary_lpa_range || ''),
      // normalize to stable scoring fields
      required_skills: requiredSkills,
      skills_required: requiredSkills,
      threeTwoReport: {
        ...report,
        // Add explicit compatibility score so the frontend can sort reliably.
        compatibilityScore: compat.score
      },
      compatibilityScore: compat.score,
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        scoring: {
          usedPersonaProficiencies: scoringUserSkills.length > 0,
          requiredSkillsCount: requiredSkills.length
        }
      }
    });
  }

  // Sort by computed compatibility desc, then by title for determinism.
  out.sort((a, b) => {
    const as = Number.isFinite(a.compatibilityScore) ? a.compatibilityScore : -Infinity;
    const bs = Number.isFinite(b.compatibilityScore) ? b.compatibilityScore : -Infinity;
    if (bs !== as) return bs - as;
    return String(a.role_title || '').localeCompare(String(b.role_title || ''), undefined, { sensitivity: 'base' });
  });

  return out;
}

// PUBLIC_INTERFACE
async function exploreSearchRolesPersonaDriven({ q, limit = 30, personaId = null } = {}) {
  /**
   * Persona-driven Explore search that is Bedrock-generated (no O*NET grounding).
   *
   * Inputs:
   * - q: search keyword (optional)
   * - limit: max results to return (default 30; max 50)
   * - personaId: finalized persona id (optional but recommended for scoring)
   *
   * Behavior:
   * 1) Load finalized persona (if personaId provided)
   * 2) Use Bedrock Claude to generate 5 roles (suggested or searched)
   * 3) Score roles against persona skills w/ proficiency (3/2 + compatibilityScore)
   * 4) Return scored roles sorted by score desc
   *
   * Return:
   * - Always returns a JSON array.
   */
  const searchQuery = _normStr(q).replace(/\s+/g, ' ');
  const limitNum = Number(limit);
  const resolvedLimit = Number.isFinite(limitNum) ? Math.max(1, Math.min(50, Math.round(limitNum))) : 30;

  // Load persona (best effort). If it fails, we still allow Bedrock generation, but scoring will be weak.
  let finalEnvelope = null;
  let finalPersonaObj = null;

  if (personaId) {
    try {
      finalEnvelope = await _loadFinalPersonaEnvelope(personaId);
      finalPersonaObj = extractFinalPersonaObject(finalEnvelope);
    } catch (_) {
      finalEnvelope = null;
      finalPersonaObj = null;
    }
  }

  const validatedSkillNames = _extractValidatedSkillNames(finalPersonaObj);
  const { userSkills: scoringUserSkills } = buildScoringUserSkills({
    finalPersonaEnvelope: finalEnvelope,
    fallbackUserSkills: []
  });

  // Bedrock generation (exactly 5 roles). We use safe wrapper so UI never breaks.
  const personaPayload = _toPersonaPayloadForBedrock({
    query: searchQuery,
    finalPersonaObj: finalPersonaObj || {},
    scoringUserSkills,
    validatedSkillNames
  });

  const bedrock = await bedrockService.generateTargetedRolesSafe(personaPayload);
  const roles = Array.isArray(bedrock?.roles) ? bedrock.roles : [];

  const scored = _decorateAndScoreRoles({ roles, scoringUserSkills });

  // Current Explore UI is fine with <= 5 items; keep stable for now.
  return _safeSlice(scored, Math.min(5, resolvedLimit));
}

module.exports = {
  exploreSearchRolesPersonaDriven
};
