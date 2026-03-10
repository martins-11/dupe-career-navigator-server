'use strict';

const bedrockService = require('./bedrockService');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');

function _clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Build UI-friendly ring scores from 3/2 report + compatibility.
 * - masteryScore: percent of required skills that are in masteryAreas
 * - growthScore: percent of required skills that are in growthAreas
 * Both are 0..100 integers.
 */
function _buildRingScores({ requiredSkillsCount, masteryAreas, growthAreas } = {}) {
  const denom = Number.isFinite(requiredSkillsCount) && requiredSkillsCount > 0 ? requiredSkillsCount : 0;
  if (!denom) {
    return {
      masteryScore: 0,
      growthScore: 0,
      masteryCount: Array.isArray(masteryAreas) ? masteryAreas.length : 0,
      growthCount: Array.isArray(growthAreas) ? growthAreas.length : 0,
    };
  }

  const masteryCount = Array.isArray(masteryAreas) ? masteryAreas.length : 0;
  const growthCount = Array.isArray(growthAreas) ? growthAreas.length : 0;

  return {
    masteryScore: _clampPercent((masteryCount / denom) * 100),
    growthScore: _clampPercent((growthCount / denom) * 100),
    masteryCount,
    growthCount,
  };
}

function _threeTwoValidationScore(threeTwoReport) {
  // Per current engine: validated => 100 else 0.
  if (!threeTwoReport || typeof threeTwoReport !== 'object') return 0;
  return threeTwoReport.status === 'validated' ? 100 : 0;
}

function _rerankByThreeTwoAndCompatibility(scoredRoles) {
  const arr = Array.isArray(scoredRoles) ? [...scoredRoles] : [];
  arr.sort((a, b) => {
    const aThreeTwo = _threeTwoValidationScore(a?.threeTwoReport);
    const bThreeTwo = _threeTwoValidationScore(b?.threeTwoReport);

    if (bThreeTwo !== aThreeTwo) return bThreeTwo - aThreeTwo;

    const aCompat = Number.isFinite(a?.compatibilityScore) ? a.compatibilityScore : -1;
    const bCompat = Number.isFinite(b?.compatibilityScore) ? b.compatibilityScore : -1;

    if (bCompat !== aCompat) return bCompat - aCompat;

    // Stable deterministic fallback: keep original order (by role_id/title)
    const aTitle = String(a?.role_title || a?.title || '');
    const bTitle = String(b?.role_title || b?.title || '');
    return aTitle.localeCompare(bTitle, undefined, { sensitivity: 'base' });
  });
  return arr;
}

function _extractPersonaSkillsWithProficiency(finalPersona) {
  /**
   * Extract proficiency-bearing skills from a Finalized Persona.
   *
   * IMPORTANT:
   * - Compatibility scoring is only meaningful when we have proficiency-bearing skills (name + percent).
   * - The finalized persona can arrive in multiple shapes; we support common variants.
   *
   * We ONLY accept numeric proficiencies. We do not infer or fabricate proficiencies from string skills.
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

      // CRITICAL: scoring must ONLY use numeric proficiency values.
      const n = typeof rawProf === 'number' ? rawProf : Number(rawProf);
      if (!name || !Number.isFinite(n)) continue;

      out.push({ name, proficiency: Math.max(0, Math.min(100, Math.round(n))) });
    }

    if (out.length) return out;
  }

  return [];
}

function _normalizeRoleForInitialRecommendations(role) {
  if (!role || typeof role !== 'object') return null;

  // Normalize required skills to a stable 5–8 item string[] (per endpoint contract + Bedrock prompt).
  const rawRequiredSkills = Array.isArray(role.required_skills)
    ? role.required_skills
    : Array.isArray(role.skills_required)
      ? role.skills_required
      : [];

  const requiredSkills = rawRequiredSkills
    .map((s) => String(typeof s === 'string' ? s : s?.name || s?.skill || s?.label || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    ...role,
    key_responsibilities: Array.isArray(role.key_responsibilities) ? role.key_responsibilities.slice(0, 3) : [],
    required_skills: requiredSkills
  };
}

function _dedupeByRoleTitle(roles) {
  const out = [];
  const seen = new Set();

  for (const r of Array.isArray(roles) ? roles : []) {
    if (!r || typeof r !== 'object') continue;

    const title = String(r.role_title || r.title || '').trim();
    const key = title ? title.toLowerCase() : null;

    // If we can't key it, keep it (best-effort), but still avoid pushing duplicates by identical object ref.
    if (!key) {
      out.push(r);
      continue;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  return out;
}

function _markFallback(role, { reason }) {
  const normalized = _normalizeRoleForInitialRecommendations(role);
  if (!normalized) return null;

  return {
    ...normalized,
    match_metadata: {
      ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
      // Mark the role as fallback-filled at the role level (requirement).
      isFallbackFilled: true,
      fallbackReason: reason || 'padded_to_exactly_five'
    }
  };
}

function _markNonFallback(role) {
  const normalized = _normalizeRoleForInitialRecommendations(role);
  if (!normalized) return null;

  return {
    ...normalized,
    match_metadata: {
      ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
      // Explicitly mark that this role is NOT fallback-filled (helps UI determinism).
      isFallbackFilled: false
    }
  };
}

function _padToExactlyFiveRoles({ bedrockRoles, fallbackCatalog }) {
  /**
   * Accept 1–5 Bedrock roles, and deterministically pad to exactly 5 using the fallback catalog.
   * - Never throws for <5.
   * - Deterministic ordering: keep Bedrock roles first, then fill in order from catalog.
   * - Avoid duplicates by role title.
   * - Mark padded roles with match_metadata.isFallbackFilled=true.
   */
  const bedrockArr = Array.isArray(bedrockRoles) ? bedrockRoles : [];
  const fallbackArr = Array.isArray(fallbackCatalog) ? fallbackCatalog : [];

  // Normalize and mark Bedrock roles as non-fallback.
  const cleanedBedrock = bedrockArr
    .map(_markNonFallback)
    .filter(Boolean);

  // Dedupe Bedrock first to avoid double-counting.
  const uniqueBedrock = _dedupeByRoleTitle(cleanedBedrock).slice(0, 5);

  if (uniqueBedrock.length === 5) {
    return { roles: uniqueBedrock, paddedCount: 0 };
  }

  const need = 5 - uniqueBedrock.length;

  // Fill from fallback catalog deterministically (in the catalog order).
  const uniqueExistingTitles = new Set(
    uniqueBedrock
      .map((r) => String(r.role_title || r.title || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const padded = [];
  for (const fb of fallbackArr) {
    if (padded.length >= need) break;

    const title = String(fb?.role_title || fb?.title || '').trim();
    const key = title ? title.toLowerCase() : null;

    if (key && uniqueExistingTitles.has(key)) continue;

    const marked = _markFallback(fb, { reason: 'bedrock_returned_fewer_than_five' });
    if (!marked) continue;

    if (key) uniqueExistingTitles.add(key);
    padded.push(marked);
  }

  // Final guard: if fallback catalog was somehow too small, slice what we have (still deterministic).
  const combined = uniqueBedrock.concat(padded).slice(0, 5);

  return { roles: combined, paddedCount: Math.max(0, combined.length - uniqueBedrock.length) };
}

function _scoreRoles(finalPersona, roles) {
  const userSkillsForScoring = _extractPersonaSkillsWithProficiency(finalPersona);
  const hadUserProficiencies = userSkillsForScoring.length > 0;

  return (Array.isArray(roles) ? roles : []).map((r) => {
    const normalized = _normalizeRoleForInitialRecommendations(r) || r;

    const requiredSkills = Array.isArray(normalized.required_skills) ? normalized.required_skills : [];
    const requiredSkillsCount = requiredSkills.length;

    // When no numeric proficiencies exist, skip scoring gracefully.
    // Do NOT fabricate proficiencies; do NOT emit misleading 0 scoring artifacts.
    const threeTwoReport = hadUserProficiencies
      ? buildThreeTwoReport(userSkillsForScoring, requiredSkills)
      : null;

    const compat = hadUserProficiencies
      ? scoreRoleCompatibility(userSkillsForScoring, requiredSkills)
      : { score: null, masteryAreas: [], growthAreas: [] };

    const ring = hadUserProficiencies
      ? _buildRingScores({
          requiredSkillsCount,
          masteryAreas: compat.masteryAreas,
          growthAreas: compat.growthAreas,
        })
      : { masteryScore: null, growthScore: null, masteryCount: 0, growthCount: 0 };

    const threeTwoValidationScore = hadUserProficiencies ? _threeTwoValidationScore(threeTwoReport) : null;

    // Final compatibility used for sorting / display: prioritize 3/2 validation, then skill coverage.
    // Keep as 0..100 number when scoring is available.
    const finalCompatibilityScore = hadUserProficiencies
      ? _clampPercent(0.6 * (compat.score || 0) + 0.4 * (threeTwoValidationScore || 0))
      : null;

    return {
      ...normalized,

      // Core scoring outputs
      threeTwoReport,
      compatibilityScore: hadUserProficiencies ? compat.score : null,
      finalCompatibilityScore,

      // Explicit mastery/growth areas for UI and debugging
      masteryAreas: hadUserProficiencies ? compat.masteryAreas : [],
      growthAreas: hadUserProficiencies ? compat.growthAreas : [],

      // Ring-friendly scores (0..100) for the UI circles
      masteryScore: hadUserProficiencies ? ring.masteryScore : null,
      growthScore: hadUserProficiencies ? ring.growthScore : null,
      masteryCount: hadUserProficiencies ? ring.masteryCount : 0,
      growthCount: hadUserProficiencies ? ring.growthCount : 0,

      match_metadata: {
        ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
        scoring: {
          hadUserProficiencies,
          requiredSkillsCount,
          scoringSkipped: !hadUserProficiencies,
          threeTwoValidationScore,
        },
      },
    };
  });
}

/**
 * PUBLIC_INTERFACE
 * Generate initial recommendations (Bedrock-only; returns 1–5 roles).
 *
 * Behavior:
 * - Returns ONLY roles produced by Bedrock (after normalization + dedupe).
 * - Allows returning fewer than 5 roles; NO deterministic padding/fill is applied.
 * - Bedrock internal fallback is disabled; if Bedrock fails entirely, this function throws.
 * - Scoring uses ONLY numeric proficiencies; if none exist, scoring is skipped gracefully.
 */
async function generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId, options = {} } = {}) {
  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    const err = new Error('finalPersona is required for recommendations.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies = Array.isArray(profs) && profs.length > 0;

  const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
    context: null,
    allowFallback: false,
    ...(options && typeof options === 'object' ? options : {})
  });

  // Normalize and mark Bedrock roles as non-fallback, then dedupe and cap to 5.
  const cleanedBedrock = (Array.isArray(bedrockResult?.roles) ? bedrockResult.roles : [])
    .map(_markNonFallback)
    .filter(Boolean);

  const uniqueBedrock = _dedupeByRoleTitle(cleanedBedrock).slice(0, 5);

  const scored = _scoreRoles(finalPersona, uniqueBedrock).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      persona: {
        personaId: personaId || null,
        usedPersonaProficiencies: hasPersonaProficiencies,
      },
      grounding: { source: 'none' },
      bedrockUsedFallback: false,
      bedrockModelId: bedrockResult?.modelId || null,
    },
  }));

  const reranked = _rerankByThreeTwoAndCompatibility(scored);

  return {
    roles: reranked,
    meta: {
      personaId: personaId || null,
      hasPersonaProficiencies,
      count: reranked.length,
      onetGrounded: false,
      onetError: null,
      bedrockUsedFallback: false,
      endpointFallbackUsed: false,
      endpointPaddingUsed: false,
      paddedCount: 0,
      bedrockError: null,
      rerankedBy: 'threeTwoValidation_then_compatibility',
    },
  };
}

module.exports = { generateInitialRecommendationsPersonaDrivenBedrockOnly };

