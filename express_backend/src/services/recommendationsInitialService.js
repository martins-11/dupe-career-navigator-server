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

    const requiredSkills = Array.isArray(normalized.required_skills)
      ? normalized.required_skills
      : [];

    // When no numeric proficiencies exist, skip scoring gracefully.
    // Do NOT fabricate proficiencies; do NOT emit misleading 0 scoring artifacts.
    const threeTwoReport = hadUserProficiencies ? buildThreeTwoReport(userSkillsForScoring, requiredSkills) : null;
    const compat = hadUserProficiencies
      ? scoreRoleCompatibility(userSkillsForScoring, requiredSkills)
      : { score: null, masteryAreas: [], growthAreas: [] };

    return {
      ...normalized,
      threeTwoReport,
      compatibilityScore: hadUserProficiencies ? compat.score : null,
      match_metadata: {
        ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
        scoring: {
          hadUserProficiencies,
          requiredSkillsCount: requiredSkills.length,
          scoringSkipped: !hadUserProficiencies
        }
      }
    };
  });
}

/**
 * PUBLIC_INTERFACE
 * Generate initial recommendations (always EXACTLY 5 roles).
 *
 * Behavior:
 * - Bedrock is preferred and may return 1–5 valid roles.
 * - If Bedrock returns <5, we deterministically pad to 5 using a fallback catalog and mark padded roles.
 * - If Bedrock errors entirely, we return the deterministic fallback catalog (all roles marked fallback).
 * - Scoring uses ONLY numeric proficiencies; if none exist, scoring is skipped gracefully.
 */
async function generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId, options = {} } = {}) {
  /**
   * IMPORTANT:
   * This endpoint must be resilient even when Bedrock is unavailable/misconfigured in a given
   * environment (common in preview/CI). We keep Bedrock as the preferred generator, but when it
   * fails we return a deterministic 5-role set.
   */
  // Bedrock service is responsible for parsing/repairing/truncation recovery.
  // We keep Bedrock's internal fallback disabled so the endpoint can accurately
  // report whether Bedrock succeeded vs. endpoint padding/fallback.
  const strictOptions = { ...options, allowFallback: false };

  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    const err = new Error('finalPersona is required for recommendations.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies = Array.isArray(profs) && profs.length > 0;

  // Deterministic fallback catalog (kept small and stable; always exactly 5).
  const fallbackRoles = [
    {
      role_id: 'fallback-full-stack-engineer',
      role_title: 'Full-Stack Software Engineer',
      industry: 'Technology',
      salary_lpa_range: '₹18–₹30 LPA',
      experience_range: '3–5 years',
      description:
        'Builds customer-facing web products across frontend and backend systems. Owns features end-to-end with an emphasis on reliability and iteration speed.',
      key_responsibilities: [
        'Deliver full-stack features from design to production',
        'Design and integrate APIs and data models',
        'Improve performance, testing, and developer tooling'
      ],
      required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'SQL', 'Git', 'Communication'],
      match_metadata: { source: 'deterministic_fallback' }
    },
    {
      role_id: 'fallback-backend-engineer',
      role_title: 'Backend Engineer (Node.js)',
      industry: 'Technology',
      salary_lpa_range: '₹20–₹34 LPA',
      experience_range: '3–6 years',
      description:
        'Designs and operates scalable backend services and APIs used by multiple product surfaces. Focuses on performance, reliability, and observability in production.',
      key_responsibilities: [
        'Build and maintain high-throughput APIs',
        'Optimize database queries and service performance',
        'Implement monitoring, logging, and on-call readiness'
      ],
      required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Performance Tuning', 'Observability'],
      match_metadata: { source: 'deterministic_fallback' }
    },
    {
      role_id: 'fallback-data-analyst',
      role_title: 'Data Analyst',
      industry: 'Technology',
      salary_lpa_range: '₹10–₹18 LPA',
      experience_range: '2–4 years',
      description:
        'Turns raw business data into actionable insights for product and operations teams. Partners with stakeholders to define metrics, dashboards, and decision frameworks.',
      key_responsibilities: [
        'Define metrics and build dashboards for stakeholders',
        'Analyze trends and root causes using SQL',
        'Communicate insights and recommendations clearly'
      ],
      required_skills: ['SQL', 'Excel', 'Data Visualization', 'Statistics', 'Dashboards', 'Stakeholder Management'],
      match_metadata: { source: 'deterministic_fallback' }
    },
    {
      role_id: 'fallback-product-manager',
      role_title: 'Product Manager (Technical)',
      industry: 'Technology',
      salary_lpa_range: '₹22–₹40 LPA',
      experience_range: '4–7 years',
      description:
        'Leads product strategy and execution for technical initiatives that require close engineering partnership. Translates customer needs into prioritized roadmaps and measurable outcomes.',
      key_responsibilities: [
        'Own roadmap and prioritize tradeoffs',
        'Write clear requirements and align stakeholders',
        'Measure impact via experimentation and analytics'
      ],
      required_skills: ['Roadmapping', 'Prioritization', 'User Research', 'Analytics', 'Communication', 'Stakeholder Management'],
      match_metadata: { source: 'deterministic_fallback' }
    },
    {
      role_id: 'fallback-devops-engineer',
      role_title: 'DevOps Engineer',
      industry: 'Technology',
      salary_lpa_range: '₹20–₹36 LPA',
      experience_range: '3–6 years',
      description:
        'Builds and maintains the infrastructure and deployment pipelines that keep services running reliably. Improves security posture, release velocity, and incident response tooling.',
      key_responsibilities: [
        'Build CI/CD pipelines and deployment automation',
        'Manage cloud infrastructure and incident response',
        'Implement monitoring, security, and reliability best practices'
      ],
      required_skills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring', 'Infrastructure as Code'],
      match_metadata: { source: 'deterministic_fallback' }
    }
  ];

  let bedrockResult = null;
  let roles = null;
  let endpointFallbackUsed = false; // Bedrock hard-fail -> full fallback catalog
  let endpointPaddingUsed = false; // Bedrock partial -> padded with fallback roles
  let bedrockError = null;
  let paddedCount = 0;

  try {
    bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
      context: null,
      allowFallback: false // strict: do not let bedrockService silently swap in deterministic roles
    });

    const padRes = _padToExactlyFiveRoles({
      bedrockRoles: bedrockResult?.roles,
      fallbackCatalog: fallbackRoles
    });

    roles = padRes.roles;
    paddedCount = padRes.paddedCount;
    endpointPaddingUsed = paddedCount > 0;
  } catch (err) {
    // Bedrock truly failed (after extraction + truncation recovery + validation).
    // Only then do we use deterministic roles (all marked fallback-filled).
    endpointFallbackUsed = true;

    roles = fallbackRoles.map((r) => _markFallback(r, { reason: 'bedrock_failed' })).filter(Boolean);

    bedrockError = {
      code: err?.code || err?.name || 'BEDROCK_FAILED',
      message: err?.message || String(err),
      details: err?.details && typeof err.details === 'object' ? err.details : null
    };
  }

  const scored = _scoreRoles(finalPersona, roles).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      persona: {
        personaId: personaId || null,
        usedPersonaProficiencies: hasPersonaProficiencies
      },
      grounding: { source: 'none' },

      /**
       * Back-compat:
       * - bedrockUsedFallback historically meant "not bedrock".
       * Now we have TWO conditions:
       * - endpointFallbackUsed: Bedrock hard failed -> full deterministic catalog
       * - endpointPaddingUsed: Bedrock returned <5 -> padded using deterministic catalog
       */
      bedrockUsedFallback: endpointFallbackUsed || endpointPaddingUsed,
      bedrockModelId: bedrockResult?.modelId || null,
      ...(bedrockError ? { bedrockError } : {})
    }
  }));

  // Final invariant: always exactly 5.
  const finalRoles = Array.isArray(scored) ? scored.slice(0, 5) : [];
  while (finalRoles.length < 5) {
    // Extreme safety: should never happen due to fallback catalog size.
    finalRoles.push(
      _markFallback(fallbackRoles[finalRoles.length % fallbackRoles.length], { reason: 'safety_padding' })
    );
  }

  return {
    roles: finalRoles,
    meta: {
      personaId: personaId || null,
      hasPersonaProficiencies,
      onetGrounded: false,
      onetError: null,
      bedrockUsedFallback: endpointFallbackUsed || endpointPaddingUsed,
      endpointFallbackUsed,
      endpointPaddingUsed,
      paddedCount,
      bedrockError
    }
  };
}

module.exports = { generateInitialRecommendationsPersonaDrivenBedrockOnly };

