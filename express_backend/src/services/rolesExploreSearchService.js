'use strict';

const onetService = require('./onetService');
const bedrockService = require('./bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');
const { extractFinalPersonaObject, buildScoringUserSkills, normalizeSalaryToIndiaLpaRange } = require('./rolesSearchUtils');

function _normStr(v) {
  return String(v || '').trim();
}

function _uniqCaseInsensitive(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const s = _normStr(it);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function _safeSlice(arr, n) {
  return (Array.isArray(arr) ? arr : []).slice(0, n);
}

async function _loadFinalPersonaEnvelope(personaId) {
  if (!personaId) return null;
  return personasRepo.getFinal(personaId);
}

function _extractValidatedSkillNames(finalPersonaObj) {
  const p = finalPersonaObj && typeof finalPersonaObj === "object" ? finalPersonaObj : {};
  const candidates = [p.validated_skills, p.validatedSkills, p.skills, p.core_skills, p.coreSkills];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === "string" ? x : x?.name || x?.skill || x?.skill_name || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }

  // If the persona doesn't have explicit validated skills, fall back to proficiency-derived list
  const profCandidates = [p.user_skills, p.userSkills, p.skills_with_proficiency, p.skillsWithProficiency, p.skillProficiencies];
  for (const arr of profCandidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === "string" ? x : x?.name || x?.skill || x?.skill_name || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }

  return [];
}

async function _buildOnetGroundingForKeyword(keyword, limitOccupations) {
  const occupations = await onetService.searchOccupations({ keyword, start: 1, end: Math.max(10, limitOccupations) });
  const top = _safeSlice(occupations, Math.min(6, limitOccupations));

  const settled = await Promise.allSettled(
    top.map(async (o) => {
      const details = await onetService.getOccupationDetails({ code: o.code });
      return {
        code: o.code,
        title: o.title,
        description: details.description || o.description || null,
        tasks: _safeSlice(details.tasks, 8),
        skills: _safeSlice(details.skills, 24),
      };
    })
  );

  const detailed = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);

  const groundingSkills = _uniqCaseInsensitive(detailed.flatMap((d) => (Array.isArray(d.skills) ? d.skills : []))).slice(0, 60);
  const groundingTasks = _uniqCaseInsensitive(detailed.flatMap((d) => (Array.isArray(d.tasks) ? d.tasks : []))).slice(0, 24);

  return { keywordUsed: keyword, occupations: detailed, groundingSkills, groundingTasks };
}

function _toPersonaPayloadForBedrock({ query, finalPersonaObj, scoringUserSkills, validatedSkillNames, onetGrounding }) {
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
    // grounding context (Bedrock prompt must reflect "grounded on O*NET results")
    onetGrounding,
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
        compatibilityScore: compat.score,
      },
      compatibilityScore: compat.score,
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        scoring: {
          usedPersonaProficiencies: scoringUserSkills.length > 0,
          requiredSkillsCount: requiredSkills.length,
        },
      },
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
   * Persona-driven Explore search that is Bedrock-generated but grounded on O*NET results.
   *
   * Inputs:
   * - q: search keyword (optional)
   * - limit: max results to return (default 30; max 50)
   * - personaId: finalized persona id (optional but recommended for scoring)
   *
   * Behavior:
   * 1) Load finalized persona (if personaId provided)
   * 2) Build O*NET grounding context for keyword derived from q/persona
   * 3) Use Bedrock Claude to generate 5 roles (suggested or searched)
   * 4) Score roles against persona skills w/ proficiency (3/2 + compatibilityScore)
   * 5) Return scored roles sorted by score desc
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
    fallbackUserSkills: [],
  });

  // Decide grounding keyword: query > persona headline > persona industry > first validated skill > safe default
  const fallbackKeyword =
    searchQuery ||
    _normStr(finalPersonaObj?.current_role || finalPersonaObj?.currentRole || finalPersonaObj?.profile?.headline) ||
    _normStr(finalPersonaObj?.industry || finalPersonaObj?.profile?.industry) ||
    (validatedSkillNames.length ? validatedSkillNames[0] : '') ||
    'developer';

  const onetGrounding = await _buildOnetGroundingForKeyword(fallbackKeyword, 25);

  // Bedrock generation (exactly 5 roles). We use safe wrapper so UI never breaks.
  const personaPayload = _toPersonaPayloadForBedrock({
    query: searchQuery,
    finalPersonaObj: finalPersonaObj || {},
    scoringUserSkills,
    validatedSkillNames,
    onetGrounding,
  });

  const bedrock = await bedrockService.generateTargetedRolesSafe(personaPayload);
  const roles = Array.isArray(bedrock?.roles) ? bedrock.roles : [];

  const scored = _decorateAndScoreRoles({ roles, scoringUserSkills });
  // Expand from 5 to "results" by re-grounding via O*NET when limit > 5 is requested:
  // In this phase, acceptance is focused on persona-based scoring and grounding. We keep output stable:
  // return up to 5 bedrock roles, even if limit is higher (client already works with fewer).
  return scored.slice(0, Math.min(5, resolvedLimit));
}

module.exports = {
  exploreSearchRolesPersonaDriven,
};
