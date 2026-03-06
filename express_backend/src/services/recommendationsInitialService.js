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
  /**
   * Extract proficiency-bearing skills from a Finalized Persona.
   *
   * IMPORTANT:
   * - /api/recommendations/initial scoring (compatibilityScore + threeTwoReport) is only meaningful
   *   when we have proficiency-bearing skills (name + percent).
   * - The "finalized persona" can arrive in multiple shapes:
   *   1) legacy: { skills_with_proficiency: [{name, proficiency}, ...] }
   *   2) legacy: { skillProficiencies: [{skillName, proficiencyPercent}, ...] }
   *   3) holistic-final: { skills: [{ name, proficiency }, ...] }  <-- common current format
   *   4) other variants: user_skills, proficiencies, etc.
   *
   * If we only have string skill names (no proficiency), scoring becomes 0 and threeTwoReport
   * becomes not_validated. In that case we still return roles, but we do NOT fabricate proficiencies.
   */
  const p = finalPersona && typeof finalPersona === 'object' ? finalPersona : {};

  // Prefer known proficiency-bearing arrays first.
  const candidates = [
    p.skills_with_proficiency,
    p.skillsWithProficiency,
    p.user_skills,
    p.userSkills,
    p.skillProficiencies,
    p.proficiencies,
    // Holistic persona finalized shape frequently uses `skills` as objects with proficiency.
    p.skills
  ];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || !arr.length) continue;

    const out = [];
    for (const row of arr) {
      if (!row) continue;

      // If it's a string skill name, it has no proficiency => skip (do not guess).
      if (typeof row === 'string') continue;
      if (typeof row !== 'object' || Array.isArray(row)) continue;

      const name = String(
        row.name || row.skill || row.skill_name || row.skillName || row.label || row.title || ''
      ).trim();

      // Accept a broader set of proficiency keys across persona variants.
      const rawProf =
        row.proficiency ??
        row.proficiencyPercent ??
        row.proficiency_percent ??
        row.percent ??
        row.score ??
        row.level_percent ??
        row.levelPercent ??
        row.value ??
        null;

      const n = Number(rawProf);
      if (!name || !Number.isFinite(n)) continue;

      out.push({ name, proficiency: Math.max(0, Math.min(100, Math.round(n))) });
    }

    if (out.length) return out;
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
    // Normalize required skills to a stable 5–8 item string[] (per endpoint contract + Bedrock prompt).
    const rawRequiredSkills = Array.isArray(r.required_skills)
      ? r.required_skills
      : Array.isArray(r.skills_required)
        ? r.skills_required
        : [];

    const requiredSkills = rawRequiredSkills
      .map((s) => String(typeof s === 'string' ? s : s?.name || s?.skill || s?.label || '').trim())
      .filter(Boolean)
      .slice(0, 8);

    const threeTwoReport = buildThreeTwoReport(userSkillsForScoring, requiredSkills);
    const compat = scoreRoleCompatibility(userSkillsForScoring, requiredSkills);

    // If we have proficiencies and role skills, score should generally be > 0.
    // We never "invent" a score; we only expose debug metadata to clarify why it is 0.
    const compatibilityScore = compat.score;

    return {
      ...r,
      key_responsibilities: Array.isArray(r.key_responsibilities) ? r.key_responsibilities.slice(0, 3) : [],
      required_skills: requiredSkills,
      threeTwoReport,
      compatibilityScore,
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        scoring: {
          hadUserProficiencies: userSkillsForScoring.length > 0,
          requiredSkillsCount: requiredSkills.length
        }
      }
    };
  });
}

// PUBLIC_INTERFACE
async function generateInitialRecommendationsPersonaDrivenOnetGrounded({ finalPersona, personaId } = {}) {
  /**
   * Generate initial recommendations:
   * - Loads O*NET grounding context (occupations/skills/tasks) best-effort
   * - Calls Bedrock for EXACTLY 5 roles (passing grounding context when available)
   * - Adds compatibilityScore + threeTwoReport
   *
   * Fallback policy (IMPORTANT):
   * - If Bedrock succeeds => return Bedrock roles (even if Bedrock internally used its deterministic fallback).
   * - If Bedrock fails => surface error when O*NET succeeded (502), otherwise (if O*NET also failed) surface 503.
   * - This service MUST NOT unconditionally return generic/static roles when Bedrock is available.
   *
   * Additionally:
   * - Returns per-role match_metadata indicating:
   *   - whether O*NET grounding was used
   *   - whether Bedrock used its own fallback path
   *   - whether persona proficiencies were present (and thus meaningful for scoring)
   */
  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    const err = new Error('finalPersona is required.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies =
    Array.isArray(profs) &&
    profs.some((x) => x && typeof x === 'object' && (x.proficiency != null || x.proficiencyPercent != null));

  let onetContext = null;
  let onetError = null;

  try {
    onetContext = await _buildOnetGroundingContext(finalPersona);
  } catch (e) {
    onetError = e;
    onetContext = null;
  }

  // Always attempt Bedrock first; only fall back (by throwing) if Bedrock fails.
  try {
    const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
      context: onetContext ? { onetGrounding: onetContext } : null
    });

    const roles = _ensureExactlyFiveRoles(bedrockResult?.roles);
    const scored = _scoreRoles(finalPersona, roles).map((r) => ({
      ...r,
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        persona: {
          personaId: personaId || null,
          usedPersonaProficiencies: hasPersonaProficiencies
        },
        grounding: onetContext
          ? {
              source: 'onet',
              keywordUsed: onetContext.keywordUsed,
              occupationsUsed: onetContext.occupations.map((o) => ({ code: o.code, title: o.title }))
            }
          : {
              source: 'none',
              onetFailed: Boolean(onetError)
            },
        bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
        bedrockModelId: bedrockResult?.modelId || null
      }
    }));

    return {
      roles: scored,
      meta: {
        personaId: personaId || null,
        hasPersonaProficiencies,
        onetGrounded: Boolean(onetContext),
        onetError: onetError ? { code: onetError.code, message: onetError.message } : null,
        bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
        // Endpoint-level fallback is NOT used in the success path.
        // BedrockService may still set usedFallback=true internally, which we surface separately.
        endpointFallbackUsed: false
      }
    };
  } catch (bedrockErr) {
    // Bedrock failed. Per requirements: only "fallback" when Bedrock/O*NET fail.
    // Here we fail fast (502/503) so the caller can see it's not a persona-driven success.
    if (onetContext) {
      const err = new Error(
        `Bedrock failed to generate initial recommendations: ${bedrockErr?.message || String(bedrockErr)}`
      );
      err.code = bedrockErr?.code || 'BEDROCK_FAILED';
      err.httpStatus = 502;
      err.details = {
        personaId: personaId || null,
        onetGrounded: true,
        onetKeywordUsed: onetContext.keywordUsed,
        onetOccupationsUsed: onetContext.occupations.map((o) => ({ code: o.code, title: o.title }))
      };
      throw err;
    }

    const err = new Error(
      `Initial recommendations failed (Bedrock unavailable; O*NET also unavailable or not configured): ${
        bedrockErr?.message || String(bedrockErr)
      }`
    );
    err.code = 'INITIAL_RECOMMENDATIONS_UNAVAILABLE';
    err.httpStatus = 503;
    err.details = {
      personaId: personaId || null,
      bedrock: { code: bedrockErr?.code || null, message: bedrockErr?.message || String(bedrockErr) },
      onet: onetError ? { code: onetError.code || null, message: onetError.message || String(onetError) } : null
    };
    throw err;
  }
}

module.exports = { generateInitialRecommendationsPersonaDrivenOnetGrounded };
