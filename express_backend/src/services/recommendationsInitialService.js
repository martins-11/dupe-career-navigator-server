'use strict';

const onetService = require('./onetService');
const bedrockService = require('./bedrockService');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');

function _extractPersonaSkillNames(finalPersona) {
  const p = finalPersona && typeof finalPersona === 'object' ? finalPersona : {};
  const candidates = [p.validated_skills, p.validatedSkills, p.skills, p.core_skills, p.coreSkills];

  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length) {
      return arr
        .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.skill_name || x?.label))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 30);
    }
  }

  const profCandidates = [
    p.skills_with_proficiency,
    p.skillsWithProficiency,
    p.user_skills,
    p.userSkills,
    p.skillProficiencies
  ];
  for (const arr of profCandidates) {
    if (Array.isArray(arr) && arr.length) {
      return arr
        .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.skill_name || x?.label))
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 30);
    }
  }

  return [];
}

function _extractPersonaSkillsWithProficiency(finalPersona) {
  const p = finalPersona && typeof finalPersona === 'object' ? finalPersona : {};
  const candidates = [
    p.skills_with_proficiency,
    p.skillsWithProficiency,
    p.user_skills,
    p.userSkills,
    p.skillProficiencies,
    p.skills
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return [];
}

function _uniqStringsCaseInsensitive(items) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = String(it || '').trim();
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

async function _buildOnetGroundingContext(finalPersona) {
  const p = finalPersona && typeof finalPersona === 'object' ? finalPersona : {};
  const headline = String(p.current_role || p.currentRole || p.profile?.headline || p.title || '').trim() || '';
  const industry = String(p.industry || p.profile?.industry || '').trim() || '';
  const skills = _extractPersonaSkillNames(p);

  const keyword = headline || industry || (skills.length ? skills[0] : '') || 'developer';

  const occupations = await onetService.searchOccupations({ keyword, start: 1, end: 25 });
  const topOccs = _safeSlice(occupations, 4);

  const settled = await Promise.allSettled(
    topOccs.map(async (o) => {
      const details = await onetService.getOccupationDetails({ code: o.code });
      return {
        code: o.code,
        title: o.title,
        description: details.description || o.description || null,
        tasks: _safeSlice(details.tasks, 6),
        skills: _safeSlice(details.skills, 18)
      };
    })
  );

  const detailed = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const groundingSkills = _uniqStringsCaseInsensitive(
    detailed.flatMap((d) => (Array.isArray(d.skills) ? d.skills : []))
  ).slice(0, 40);

  return { keywordUsed: keyword, occupations: detailed, groundingSkills };
}

function _ensureExactlyFiveRoles(roles) {
  const arr = Array.isArray(roles) ? roles : [];
  if (arr.length === 5) return arr;
  if (arr.length > 5) return arr.slice(0, 5);

  const err = new Error(`Generator returned ${arr.length} roles; expected exactly 5.`);
  err.code = 'initial_recommendations_invalid_count';
  err.httpStatus = 502;
  throw err;
}

function _scoreRoles(finalPersona, roles) {
  const userSkillsForScoring = _extractPersonaSkillsWithProficiency(finalPersona);

  return roles.map((r) => {
    const requiredSkills = Array.isArray(r.required_skills)
      ? r.required_skills
      : Array.isArray(r.skills_required)
        ? r.skills_required
        : [];

    const threeTwoReport = buildThreeTwoReport(userSkillsForScoring, requiredSkills);
    const compat = scoreRoleCompatibility(userSkillsForScoring, requiredSkills);

    return {
      ...r,
      key_responsibilities: Array.isArray(r.key_responsibilities) ? r.key_responsibilities.slice(0, 3) : [],
      required_skills: requiredSkills,
      threeTwoReport,
      compatibilityScore: compat.score
    };
  });
}

// PUBLIC_INTERFACE
async function generateInitialRecommendationsPersonaDrivenOnetGrounded({ finalPersona } = {}) {
  /**
   * Generate initial recommendations:
   * - Loads O*NET grounding context (occupations/skills/tasks) best-effort
   * - Calls Bedrock for EXACTLY 5 roles (passing grounding context when available)
   * - Adds compatibilityScore + threeTwoReport
   *
   * Fallback policy:
   * - If O*NET succeeds but Bedrock fails => DO NOT static-fallback; fail (502).
   * - If O*NET fails but Bedrock succeeds => return Bedrock roles (not grounded).
   * - If both fail => allow Bedrock's deterministic fallback (last resort).
   */
  if (!finalPersona || typeof finalPersona !== 'object') {
    const err = new Error('finalPersona is required.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  let onetContext = null;
  let onetError = null;

  try {
    onetContext = await _buildOnetGroundingContext(finalPersona);
  } catch (e) {
    onetError = e;
    onetContext = null;
  }

  try {
    const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
      context: onetContext ? { onetGrounding: onetContext } : null
    });

    const roles = _ensureExactlyFiveRoles(bedrockResult?.roles);
    const scored = _scoreRoles(finalPersona, roles).map((r) => ({
      ...r,
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        grounding: onetContext
          ? {
              source: 'onet',
              keywordUsed: onetContext.keywordUsed,
              occupationsUsed: onetContext.occupations.map((o) => ({ code: o.code, title: o.title }))
            }
          : { source: 'none' },
        bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
        bedrockModelId: bedrockResult?.modelId || null
      }
    }));

    return {
      roles: scored,
      meta: {
        onetGrounded: Boolean(onetContext),
        onetError: onetError ? { code: onetError.code, message: onetError.message } : null,
        bedrockUsedFallback: Boolean(bedrockResult?.usedFallback)
      }
    };
  } catch (bedrockErr) {
    if (onetContext) {
      const err = new Error(
        `Bedrock failed to generate initial recommendations: ${bedrockErr?.message || String(bedrockErr)}`
      );
      err.code = bedrockErr?.code || 'BEDROCK_FAILED';
      err.httpStatus = 502;
      err.details = {
        onetGrounded: true,
        onetKeywordUsed: onetContext.keywordUsed,
        onetOccupationsUsed: onetContext.occupations.map((o) => ({ code: o.code, title: o.title }))
      };
      throw err;
    }

    try {
      const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {});
      const roles = _ensureExactlyFiveRoles(bedrockResult?.roles);
      const scored = _scoreRoles(finalPersona, roles).map((r) => ({
        ...r,
        match_metadata: {
          ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
          grounding: { source: 'none', onetFailed: true },
          bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
          bedrockModelId: bedrockResult?.modelId || null
        }
      }));

      return {
        roles: scored,
        meta: {
          onetGrounded: false,
          onetError: onetError ? { code: onetError.code, message: onetError.message } : null,
          bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
          note: 'O*NET failed; Bedrock result returned without O*NET grounding.'
        }
      };
    } catch (bothErr) {
      const err = new Error(
        `Initial recommendations failed (both Bedrock and O*NET unavailable): ${bothErr?.message || String(bothErr)}`
      );
      err.code = 'INITIAL_RECOMMENDATIONS_UNAVAILABLE';
      err.httpStatus = 503;
      err.details = {
        bedrock: { code: bedrockErr?.code || null, message: bedrockErr?.message || String(bedrockErr) },
        onet: onetError ? { code: onetError.code || null, message: onetError.message || String(onetError) } : null
      };
      throw err;
    }
  }
}

module.exports = { generateInitialRecommendationsPersonaDrivenOnetGrounded };
