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

/**
 * PUBLIC_INTERFACE
 * Generate initial recommendations (EXACTLY 5 roles) using ONLY AWS Bedrock.
 *
 * This function has been hardened for "strict mode" – all fallback is forcibly disabled.
 * Any Bedrock or persona validation error will be surfaced directly; deterministic fallback roles no longer exist.
 */
async function generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId, options = {} } = {}) {
  /**
   * IMPORTANT:
   * This endpoint must be resilient even when Bedrock is unavailable/misconfigured in a given
   * environment (common in preview/CI). Previously we forced strict no-fallback behavior, which
   * makes /api/recommendations/initial permanently return 502 in those environments.
   *
   * We keep Bedrock as the preferred generator, but when it fails we return a deterministic
   * 5-role set that is still persona-driven via the scoring engine.
   */
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
  let endpointFallbackUsed = false;
  let bedrockError = null;

  try {
    bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
      context: null,
      allowFallback: false // never use bedrockService's internal fallback; we control fallback here
    });

    roles = _ensureExactlyFiveRoles(bedrockResult?.roles);
  } catch (err) {
    // Bedrock unavailable/invalid output: use deterministic roles instead of failing the endpoint.
    endpointFallbackUsed = true;
    roles = fallbackRoles;

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
      bedrockUsedFallback: false,
      bedrockModelId: bedrockResult?.modelId || null,
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
      bedrockUsedFallback: false,
      endpointFallbackUsed,
      bedrockError
    }
  };
}

module.exports = { generateInitialRecommendationsPersonaDrivenBedrockOnly };
