'use strict';

const bedrockService = require('./bedrockService');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');

function _extractPersonaSkillsWithProficiency(finalPersona) {
  /**
   * Extract proficiency-bearing skills from a Finalized Persona.
   *
   * IMPORTANT:
   * - Compatibility scoring is only meaningful when we have proficiency-bearing skills (name + percent).
   * - The finalized persona can arrive in multiple shapes; we support common variants.
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

    return {
      ...r,
      key_responsibilities: Array.isArray(r.key_responsibilities) ? r.key_responsibilities.slice(0, 3) : [],
      required_skills: requiredSkills,
      threeTwoReport,
      compatibilityScore: compat.score,
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
async function generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId } = {}) {
  /**
   * Generate initial recommendations (EXACTLY 5 roles) using ONLY AWS Bedrock.
   *
   * This refactor intentionally removes all O*NET usage/grounding.
   *
   * Behavior:
   * - Calls Bedrock for EXACTLY 5 roles (BedrockService has its own internal deterministic fallback).
   * - Adds compatibilityScore + threeTwoReport (when persona proficiencies exist).
   *
   * @returns {Promise<{roles: Array, meta: object}>}
   */
  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    const err = new Error('finalPersona is required.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies = Array.isArray(profs) && profs.length > 0;

  // Bedrock generation (safe wrapper is inside bedrockService.getInitialRecommendations)
  const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, { context: null });

  const roles = _ensureExactlyFiveRoles(bedrockResult?.roles);

  // Sanitize bedrock error object (if any) into a stable, non-sensitive meta field.
  const bedrockError =
    bedrockResult?.usedFallback && bedrockResult?.error && typeof bedrockResult.error === 'object'
      ? {
          code: bedrockResult.error.code || 'BEDROCK_FAILED',
          message: bedrockResult.error.message || null,
          name: bedrockResult.error.name || null,
          httpStatusCode: bedrockResult.error.httpStatusCode ?? null,
          requestId: bedrockResult.error.requestId ?? null,
          extendedRequestId: bedrockResult.error.extendedRequestId ?? null,
          cfId: bedrockResult.error.cfId ?? null,
          attempts: bedrockResult.error.attempts ?? null,
          totalRetryDelay: bedrockResult.error.totalRetryDelay ?? null,
          fault: bedrockResult.error.fault ?? null,
          service: bedrockResult.error.service ?? null
        }
      : null;

  const scored = _scoreRoles(finalPersona, roles).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      persona: {
        personaId: personaId || null,
        usedPersonaProficiencies: hasPersonaProficiencies
      },
      grounding: {
        source: 'none'
      },
      bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
      bedrockModelId: bedrockResult?.modelId || null,
      // Optional per-role visibility into the cause of fallback (useful when debugging UI cards).
      ...(bedrockError ? { bedrockError } : {})
    }
  }));

  return {
    roles: scored,
    meta: {
      personaId: personaId || null,
      hasPersonaProficiencies,
      onetGrounded: false,
      onetError: null,
      bedrockUsedFallback: Boolean(bedrockResult?.usedFallback),
      endpointFallbackUsed: false,
      // Primary diagnostic payload (use this to see why bedrockUsedFallback=true).
      bedrockError
    }
  };
}

module.exports = { generateInitialRecommendationsPersonaDrivenBedrockOnly };
