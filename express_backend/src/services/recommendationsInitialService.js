import bedrockService from './bedrockService.js';
import { buildThreeTwoReport, scoreRoleCompatibility } from './scoringEngine.js';

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
    // Prefer real Bedrock roles over padded fallback roles.
    const aFallback = Boolean(a?.match_metadata?.isFallbackFilled);
    const bFallback = Boolean(b?.match_metadata?.isFallbackFilled);
    if (aFallback !== bFallback) return aFallback ? 1 : -1;

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

  // Ensure salary_range exists for filtering logic used across the app.
  const salaryRange = role.salary_range || role.salaryRange || role.salary_lpa_range || role.salaryLpaRange || null;

  return {
    ...role,
    ...(salaryRange ? { salary_range: salaryRange } : {}),
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

/**
 * Rich deterministic fallback catalog for initial recommendations padding.
 *
 * NOTE:
 * We keep this local (instead of importing from bedrockService) so this module
 * can always guarantee "at least 5 roles" even when Bedrock returns fewer valid
 * roles due to output validation/deduping.
 */
const INITIAL_RECOMMENDATIONS_FALLBACK_CATALOG = [
  {
    role_title: 'Full-Stack Software Engineer',
    industry: 'Technology',
    salary_lpa_range: '₹18–₹30 LPA',
    experience_range: '3–5 years',
    description:
      'Builds end-to-end web products across frontend and backend systems. Owns features from design to production with a focus on reliability and iteration speed.',
    key_responsibilities: [
      'Deliver full-stack features from design to production',
      'Design and integrate APIs and data models',
      'Improve performance, testing, and developer tooling'
    ],
    required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'SQL', 'Git', 'Communication']
  },
  {
    role_title: 'Backend Engineer (Node.js)',
    industry: 'Technology',
    salary_lpa_range: '₹20–₹35 LPA',
    experience_range: '3–6 years',
    description:
      'Designs and operates scalable backend services and APIs used by multiple product surfaces. Focuses on performance, reliability, and observability in production.',
    key_responsibilities: [
      'Build and maintain high-throughput APIs',
      'Optimize database queries and service performance',
      'Implement monitoring, logging, and on-call readiness'
    ],
    required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Performance Tuning', 'Observability', 'Collaboration']
  },
  {
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
    required_skills: ['SQL', 'Excel', 'Data Visualization', 'Statistics', 'Dashboards', 'Stakeholder Management']
  },
  {
    role_title: 'Technical Product Manager',
    industry: 'Technology',
    salary_lpa_range: '₹22–₹40 LPA',
    experience_range: '4–7 years',
    description:
      'Leads product strategy and execution for technical initiatives requiring deep engineering partnership. Translates customer needs into roadmaps and measurable outcomes.',
    key_responsibilities: [
      'Own roadmap and prioritize tradeoffs',
      'Write clear requirements and align stakeholders',
      'Measure impact via experimentation and analytics'
    ],
    required_skills: ['Roadmapping', 'Prioritization', 'User Research', 'Analytics', 'Communication', 'Stakeholder Management']
  },
  {
    role_title: 'DevOps Engineer',
    industry: 'Technology',
    salary_lpa_range: '₹18–₹32 LPA',
    experience_range: '3–6 years',
    description:
      'Builds and maintains the infrastructure and deployment pipelines that keep services reliable. Improves security posture, release velocity, and incident response tooling.',
    key_responsibilities: [
      'Build CI/CD pipelines and deployment automation',
      'Manage cloud infrastructure and incident response',
      'Implement monitoring, security, and reliability best practices'
    ],
    required_skills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring', 'Infrastructure as Code', 'Incident Management']
  },
  // Extra items to increase padding diversity / dedupe safety:
  {
    role_title: 'Business Analyst',
    industry: 'Technology',
    salary_lpa_range: '₹12–₹22 LPA',
    experience_range: '3–6 years',
    description:
      'Bridges business needs and engineering execution by defining requirements and success metrics. Produces clear specs and collaborates across stakeholders to deliver outcomes.',
    key_responsibilities: [
      'Gather requirements and map business processes',
      'Write functional specifications and acceptance criteria',
      'Track outcomes through KPIs and stakeholder reviews'
    ],
    required_skills: ['Requirements Gathering', 'Process Mapping', 'Documentation', 'SQL', 'Analytics', 'Communication']
  },
  {
    role_title: 'QA Automation Engineer',
    industry: 'Technology',
    salary_lpa_range: '₹10–₹20 LPA',
    experience_range: '2–5 years',
    description:
      'Builds automated testing suites to ensure product quality across releases. Works closely with engineers to prevent regressions and improve test reliability.',
    key_responsibilities: [
      'Design and maintain automated test suites',
      'Integrate tests into CI pipelines and improve coverage',
      'Investigate failures and partner on bug prevention'
    ],
    required_skills: ['Test Automation', 'JavaScript', 'Playwright', 'CI/CD', 'Debugging', 'Test Strategy']
  }
];

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

  /**
   * When persona proficiencies are missing, we still need to provide non-null
   * compatibility scores and meaningful mastery/growth tags so the frontend can render.
   *
   * This fallback mode is deterministic and conservative:
   * - compatibilityScore: % of required_skills that exist in persona skills (string overlap)
   * - masteryAreas: first 3 matched required skills
   * - growthAreas: next 2 matched required skills
   * - threeTwoReport: not_validated (we cannot validate thresholds without proficiencies)
   *
   * We also mark scoring metadata so consumers can distinguish inferred vs proficiency-based output.
   */
  const personaSkillStrings = (() => {
    const p = finalPersona && typeof finalPersona === 'object' ? finalPersona : {};
    const candidates = [p.skills, p.validated_skills, p.validatedSkills, p.skill_names, p.skillNames];
    for (const arr of candidates) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const out = [];
      for (const row of arr) {
        if (typeof row === 'string') {
          const s = row.trim();
          if (s) out.push(s);
        } else if (row && typeof row === 'object' && !Array.isArray(row)) {
          const s = String(row.name || row.skill || row.label || '').trim();
          if (s) out.push(s);
        }
      }
      if (out.length) return out;
    }
    return [];
  })();

  const personaNorm = new Set(personaSkillStrings.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));

  return (Array.isArray(roles) ? roles : []).map((r) => {
    const normalized = _normalizeRoleForInitialRecommendations(r) || r;

    const requiredSkills = Array.isArray(normalized.required_skills) ? normalized.required_skills : [];
    const requiredSkillsCount = requiredSkills.length;

    if (hadUserProficiencies) {
      const threeTwoReport = buildThreeTwoReport(userSkillsForScoring, requiredSkills);
      const compat = scoreRoleCompatibility(userSkillsForScoring, requiredSkills);

      const ring = _buildRingScores({
        requiredSkillsCount,
        masteryAreas: compat.masteryAreas,
        growthAreas: compat.growthAreas,
      });

      const threeTwoValidationScore = _threeTwoValidationScore(threeTwoReport);
      const finalCompatibilityScore = _clampPercent(0.6 * (compat.score || 0) + 0.4 * (threeTwoValidationScore || 0));

      return {
        ...normalized,

        // Core scoring outputs
        threeTwoReport,
        compatibilityScore: compat.score,
        finalCompatibilityScore,

        // Explicit mastery/growth areas for UI and debugging
        masteryAreas: compat.masteryAreas,
        growthAreas: compat.growthAreas,

        // Ring-friendly scores (0..100) for the UI circles
        masteryScore: ring.masteryScore,
        growthScore: ring.growthScore,
        masteryCount: ring.masteryCount,
        growthCount: ring.growthCount,

        match_metadata: {
          ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
          scoring: {
            hadUserProficiencies,
            requiredSkillsCount,
            scoringSkipped: false,
            threeTwoValidationScore,
            fallbackMode: 'none',
          },
        },
      };
    }

    // Fallback mode (no numeric proficiencies)
    const requiredNorm = requiredSkills.map((s) => String(s || '').trim()).filter(Boolean);
    const matched = requiredNorm.filter((s) => personaNorm.has(s.toLowerCase()));

    const masteryAreas = matched.slice(0, 3);
    const growthAreas = matched.slice(3, 5);

    const coveredCount = new Set(matched.map((s) => s.toLowerCase())).size;
    const denom = requiredNorm.length > 0 ? new Set(requiredNorm.map((s) => s.toLowerCase())).size : 0;
    const compatibilityScore = denom ? _clampPercent((coveredCount / denom) * 100) : 0;

    const ring = _buildRingScores({
      requiredSkillsCount: denom,
      masteryAreas,
      growthAreas,
    });

    // No proficiency => cannot validate 3/2. Keep deterministic but honest.
    const threeTwoReport = {
      status: 'not_validated',
      masteryAreas,
      growthAreas,
      score: 0,
    };

    // In fallback, we use compatibilityScore directly (do not mix in 3/2 validation).
    const finalCompatibilityScore = compatibilityScore;

    return {
      ...normalized,

      // Core scoring outputs (NON-NULL for frontend ring rendering)
      threeTwoReport,
      compatibilityScore,
      finalCompatibilityScore,

      // Explicit mastery/growth areas for UI and debugging (NON-EMPTY when overlap exists)
      masteryAreas,
      growthAreas,

      // Ring-friendly scores (0..100) for the UI circles
      masteryScore: ring.masteryScore,
      growthScore: ring.growthScore,
      masteryCount: ring.masteryCount,
      growthCount: ring.growthCount,

      match_metadata: {
        ...(normalized.match_metadata && typeof normalized.match_metadata === 'object' ? normalized.match_metadata : {}),
        scoring: {
          hadUserProficiencies,
          requiredSkillsCount: denom,
          scoringSkipped: false,
          threeTwoValidationScore: null,
          fallbackMode: 'overlap_without_proficiency',
          fallbackInputs: {
            personaSkillCount: personaNorm.size,
          },
        },
      },
    };
  });
}

/**
 * PUBLIC_INTERFACE
 * Generate initial recommendations (Bedrock-first; returns at least minCount roles).
 *
 * Policy:
 * - Prefer returning >= minCount roles sourced from Bedrock output (no mixing).
 * - If Bedrock returns fewer valid/unique roles after validation/dedupe, we retry once requesting
 *   more roles (e.g., 7 → 9) to compensate for invalid entries/duplicates.
 * - Deterministic fallback padding is ONLY used when explicitly enabled (options.allowPadding=true).
 *
 * Defaults:
 * - minCount=5 (Explore grid requirement)
 * - requestedCount=7 (ask Bedrock for >5 to survive validation + dedupe)
 * - maxAttempts=2
 */
async function generateInitialRecommendationsPersonaDrivenBedrockOnly({ finalPersona, personaId, options = {} } = {}) {
  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    const err = new Error('finalPersona is required for recommendations.');
    err.code = 'missing_final_persona';
    err.httpStatus = 400;
    throw err;
  }

  const opt = options && typeof options === 'object' ? options : {};

  // Minimum requirement: >=5 roles for the Explore landing. Callers may request more to store.
  const minCountRaw = Number(opt.minCount);
  const minCount = Number.isFinite(minCountRaw) ? Math.max(1, Math.min(50, Math.floor(minCountRaw))) : 5;

  // How many roles to return when Bedrock provides enough. Must be >= minCount.
  const returnCountRaw = Number(opt.returnCount);
  const returnCount = Number.isFinite(returnCountRaw)
    ? Math.max(minCount, Math.min(20, Math.floor(returnCountRaw)))
    : minCount;

  const allowPadding =
    opt.allowPadding === true ||
    String(process.env.RECOMMENDATIONS_INITIAL_ALLOW_PADDING || '').toLowerCase() === 'true';

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies = Array.isArray(profs) && profs.length > 0;

  const maxAttemptsRaw = Number(opt.maxAttempts);
  const maxAttemptsDefault = Number.isFinite(maxAttemptsRaw)
    ? Math.max(1, Math.min(3, Math.floor(maxAttemptsRaw)))
    : 2;

  const initialRequestedCountRaw = Number(opt.requestedCount);
  const initialRequestedCount = Number.isFinite(initialRequestedCountRaw)
    ? Math.max(returnCount, Math.min(20, Math.floor(initialRequestedCountRaw)))
    : Math.min(20, Math.max(returnCount, 12));

  // Enforce a single global time budget across all Bedrock attempts.
  const startMs = Date.now();
  const totalBudgetRaw = Number(opt.timeBudgetMs);
  const totalBudgetMs = Number.isFinite(totalBudgetRaw) && totalBudgetRaw > 0 ? totalBudgetRaw : null;
  const deadlineMs = totalBudgetMs != null ? startMs + totalBudgetMs : null;

  const remainingMs = () => (deadlineMs == null ? null : Math.max(0, deadlineMs - Date.now()));

  let lastBedrockResult = null;
  let finalBedrockUnique = [];

  // Meta instrumentation (requested vs received vs unique accepted).
  let lastRequestedCount = null;
  let lastReceivedCount = null;
  let lastUniqueAcceptedCount = null;

  for (let attempt = 1; attempt <= maxAttemptsDefault; attempt += 1) {
    const rem = remainingMs();

    // If we are close to the request timeout, stop trying and let padding/error handling decide.
    if (rem != null && rem < 1200) break;

    // Support requesting/storing >5 roles; cap at 20 to keep responses bounded.
    const requestedCount = Math.min(20, initialRequestedCount + (attempt - 1) * 2);
    lastRequestedCount = requestedCount;

    // Allocate the *remaining* time to this attempt (minus a small buffer for parsing/scoring).
    const attemptBudgetMs = rem != null ? Math.max(1, rem - 250) : undefined;

    /**
     * IMPORTANT:
     * - Disable nested retries inside bedrockService.getInitialRecommendations, because this
     *   service already performs multiple attempts.
     * - This prevents worst-case latency from stacking (retries * attempts).
     */
    const bedrockResult = await bedrockService.getInitialRecommendations(finalPersona, {
      context: null,
      allowFallback: false,
      count: requestedCount,
      retries: 0,
      retryDelayMs: 0,
      ...(opt && typeof opt === 'object' ? opt : {}),
      ...(attemptBudgetMs != null ? { timeBudgetMs: attemptBudgetMs } : {}),
    });

    lastBedrockResult = bedrockResult;

    const received = Array.isArray(bedrockResult?.roles) ? bedrockResult.roles.length : 0;
    lastReceivedCount = received;

    const cleanedBedrock = (Array.isArray(bedrockResult?.roles) ? bedrockResult.roles : [])
      .map(_markNonFallback)
      .filter(Boolean);

    const uniqueBedrock = _dedupeByRoleTitle(cleanedBedrock).slice(0, 20);
    lastUniqueAcceptedCount = uniqueBedrock.length;

    // If we have enough to satisfy the desired pool size, stop.
    if (uniqueBedrock.length >= returnCount) {
      finalBedrockUnique = uniqueBedrock.slice(0, returnCount);
      break;
    }

    // If we have enough to satisfy the minimum UX contract, keep the result but
    // continue attempting (if possible) to grow the pool up to returnCount.
    if (uniqueBedrock.length >= minCount) {
      finalBedrockUnique = uniqueBedrock;

      // If no more attempts remain, stop here.
      if (attempt >= maxAttemptsDefault) break;

      // Otherwise, try again with a higher requestedCount (loop continues).
      continue;
    }

    finalBedrockUnique = uniqueBedrock;
  }

  // In normal mode, return up to returnCount. Still enforce the >=minCount requirement.
  let rolesForScoring = finalBedrockUnique.slice(0, returnCount);
  let paddedCount = 0;

  if (rolesForScoring.length < minCount) {
    if (!allowPadding) {
      const err = new Error(
        `Bedrock returned ${rolesForScoring.length} valid/unique roles; expected at least ${minCount}.`
      );
      err.code = 'bedrock_insufficient_roles';
      err.httpStatus = 502;
      err.details = {
        personaId: personaId || null,
        minCount,
        hadPersonaProficiencies: hasPersonaProficiencies,
        bedrockModelId: lastBedrockResult?.modelId || null,
        returnedCount: rolesForScoring.length,
      };
      throw err;
    }

    // Padding is only used to meet the minimum UX contract (>=5),
    // not to fabricate extra items beyond that.
    const padded = _padToExactlyFiveRoles({
      bedrockRoles: rolesForScoring,
      fallbackCatalog: INITIAL_RECOMMENDATIONS_FALLBACK_CATALOG,
    });

    rolesForScoring = Array.isArray(padded?.roles) ? padded.roles.slice(0, minCount) : rolesForScoring;
    paddedCount = Number.isFinite(padded?.paddedCount) ? padded.paddedCount : 0;
  }

  const scored = _scoreRoles(finalPersona, rolesForScoring).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      persona: {
        personaId: personaId || null,
        usedPersonaProficiencies: hasPersonaProficiencies,
      },
      grounding: { source: 'none' },
      bedrockUsedFallback: false,
      bedrockModelId: lastBedrockResult?.modelId || null,
    },
  }));

  // Rerank, but do not force down to 5; keep the full pool for storage/search/mindmap.
  const reranked = _rerankByThreeTwoAndCompatibility(scored).slice(0, returnCount);

  return {
    roles: reranked,
    meta: {
      personaId: personaId || null,
      hasPersonaProficiencies,
      count: reranked.length,
      minCount,
      returnCount,

      // Diagnostics: how many were requested vs returned by Bedrock vs kept after validation/dedupe.
      requestedCount: lastRequestedCount,
      receivedCount: lastReceivedCount,
      uniqueAcceptedCount: lastUniqueAcceptedCount,

      onetGrounded: false,
      onetError: null,
      bedrockUsedFallback: false,
      endpointFallbackUsed: false,
      endpointPaddingUsed: paddedCount > 0,
      paddedCount: paddedCount > 0 ? paddedCount : 0,
      bedrockError: null,
      rerankedBy: 'bedrock_first_then_threeTwoValidation_then_compatibility',
    },
  };
}

/**
 * PUBLIC_INTERFACE
 * Generate initial recommendations without calling Bedrock.
 *
 * Why:
 * - The Explore page must render within preview/proxy timeouts.
 * - Bedrock can take >20s in some environments and cause a 504.
 * - This function provides a deterministic, local fallback that still emits the same
 *   scored role-card shape (rings + threeTwoReport) so the UI can render reliably.
 *
 * @param {object} params
 * @param {object} params.finalPersona - Final persona JSON (may be minimal/empty object).
 * @param {string} [params.personaId] - Persona identifier (optional; used for meta).
 * @param {object} [params.options]
 * @param {number} [params.options.minCount] - Always clamped to 5 for this endpoint contract.
 * @returns {Promise<{roles: Array, meta: object}>}
 */
async function generateInitialRecommendationsFallbackOnly({ finalPersona, personaId, options = {} } = {}) {
  if (!finalPersona || typeof finalPersona !== 'object' || Array.isArray(finalPersona)) {
    // Keep this resilient: treat missing persona as an empty object.
    finalPersona = {};
  }

  const opt = options && typeof options === 'object' ? options : {};
  const minCountRaw = Number(opt.minCount);
  const minCount = Number.isFinite(minCountRaw) ? Math.max(1, Math.min(5, Math.floor(minCountRaw))) : 5;

  const profs = _extractPersonaSkillsWithProficiency(finalPersona);
  const hasPersonaProficiencies = Array.isArray(profs) && profs.length > 0;

  // All roles come from deterministic fallback catalog.
  const padded = _padToExactlyFiveRoles({
    bedrockRoles: [],
    fallbackCatalog: INITIAL_RECOMMENDATIONS_FALLBACK_CATALOG,
  });

  const rolesForScoring = Array.isArray(padded?.roles) ? padded.roles.slice(0, minCount) : [];

  const scored = _scoreRoles(finalPersona, rolesForScoring).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      persona: {
        personaId: personaId || null,
        usedPersonaProficiencies: hasPersonaProficiencies,
      },
      grounding: { source: 'none' },
      bedrockUsedFallback: false,
      bedrockModelId: null,
      // Explicitly mark this as endpoint-level fallback.
      endpointFallbackUsed: true,
    },
  }));

  const reranked = _rerankByThreeTwoAndCompatibility(scored).slice(0, minCount);

  return {
    roles: reranked,
    meta: {
      personaId: personaId || null,
      hasPersonaProficiencies,
      count: reranked.length,
      onetGrounded: false,
      onetError: null,
      bedrockUsedFallback: false,
      endpointFallbackUsed: true,
      endpointPaddingUsed: true,
      paddedCount: 5,
      bedrockError: null,
      rerankedBy: 'fallback_only_then_threeTwoValidation_then_compatibility',
    },
  };
}

export {
  generateInitialRecommendationsPersonaDrivenBedrockOnly,
  generateInitialRecommendationsFallbackOnly
};

export default {
  generateInitialRecommendationsPersonaDrivenBedrockOnly,
  generateInitialRecommendationsFallbackOnly
};

