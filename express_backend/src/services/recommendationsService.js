'use strict';

const rolesRepo = require('../repositories/rolesRepoAdapter');
const personasRepo = require('../repositories/personasRepoAdapter');
const { buildThreeTwoReport } = require('./scoringEngine');

/**
 * Shared default roles catalog (in-memory seed).
 *
 * This is used by:
 * - recommendationsService._ensureSeededIfEmpty() to seed the DB when available
 * - routes/roles.js as an in-memory fallback when DB search isn't available
 *
 * Keeping this exported avoids drift and ensures verification scripts see stable results.
 */
const DEFAULT_ROLES_CATALOG = [
  {
    roleTitle: 'Software Engineer',
    industry: 'Technology',
    coreSkills: ['JavaScript', 'APIs', 'Problem Solving', 'Git', 'Debugging'],
    seniorityLevels: ['Junior', 'Mid'],
    estimatedSalaryRange: '$90k-$140k'
  },
  {
    roleTitle: 'Senior Software Engineer',
    industry: 'Technology',
    coreSkills: ['System Design', 'Leadership', 'JavaScript', 'Backend', 'Mentoring'],
    seniorityLevels: ['Senior', 'Lead'],
    estimatedSalaryRange: '$140k-$200k'
  },
  {
    roleTitle: 'Backend Engineer (Node.js)',
    industry: 'Technology',
    coreSkills: ['Node.js', 'Express', 'APIs', 'SQL', 'Performance'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$120k-$185k'
  },
  {
    roleTitle: 'Data Analyst',
    industry: 'Technology',
    coreSkills: ['SQL', 'Excel', 'Data Visualization', 'Statistics', 'Dashboards'],
    seniorityLevels: ['Junior', 'Mid'],
    estimatedSalaryRange: '$70k-$115k'
  },
  {
    roleTitle: 'Data Scientist',
    industry: 'Technology',
    coreSkills: ['Python', 'Machine Learning', 'Statistics', 'Experimentation', 'Modeling'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$130k-$210k'
  },
  {
    roleTitle: 'Machine Learning Engineer',
    industry: 'Technology',
    coreSkills: ['Python', 'MLOps', 'Model Deployment', 'AWS', 'APIs'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$150k-$230k'
  },
  {
    roleTitle: 'DevOps Engineer',
    industry: 'Technology',
    coreSkills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$130k-$205k'
  },
  {
    roleTitle: 'Cloud Solutions Architect',
    industry: 'Technology',
    coreSkills: ['AWS', 'Architecture', 'Security', 'Networking', 'Stakeholder Management'],
    seniorityLevels: ['Senior', 'Principal'],
    estimatedSalaryRange: '$170k-$260k'
  },
  {
    roleTitle: 'Product Manager',
    industry: 'Technology',
    coreSkills: ['Roadmapping', 'Stakeholder Management', 'Analytics', 'Prioritization', 'Communication'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$130k-$210k'
  },
  {
    roleTitle: 'Technical Program Manager',
    industry: 'Technology',
    coreSkills: ['Delivery Management', 'Coordination', 'Risk Management', 'Communication', 'Systems Thinking'],
    seniorityLevels: ['Senior', 'Lead'],
    estimatedSalaryRange: '$140k-$220k'
  },
  {
    roleTitle: 'UX Designer',
    industry: 'Technology',
    coreSkills: ['User Research', 'Wireframing', 'Prototyping', 'Interaction Design', 'Communication'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$110k-$180k'
  },
  {
    roleTitle: 'Cybersecurity Analyst',
    industry: 'Technology',
    coreSkills: ['Security Monitoring', 'Incident Response', 'Networking', 'Risk Assessment', 'SIEM'],
    seniorityLevels: ['Junior', 'Mid'],
    estimatedSalaryRange: '$90k-$145k'
  },
  {
    roleTitle: 'Finance Analyst',
    industry: 'Finance',
    coreSkills: ['Financial Modeling', 'Excel', 'Forecasting', 'Communication', 'Reporting'],
    seniorityLevels: ['Junior', 'Mid'],
    estimatedSalaryRange: '$70k-$120k'
  },
  {
    roleTitle: 'Risk Manager',
    industry: 'Finance',
    coreSkills: ['Risk Assessment', 'Compliance', 'Stakeholder Management', 'Analysis', 'Reporting'],
    seniorityLevels: ['Senior', 'Manager'],
    estimatedSalaryRange: '$130k-$200k'
  },
  {
    roleTitle: 'Operations Manager',
    industry: 'Retail',
    coreSkills: ['Process Improvement', 'Leadership', 'Operations', 'KPIs', 'Communication'],
    seniorityLevels: ['Senior', 'Manager'],
    estimatedSalaryRange: '$90k-$150k'
  },
  {
    roleTitle: 'Healthcare Data Analyst',
    industry: 'Healthcare',
    coreSkills: ['SQL', 'Data Privacy', 'Reporting', 'Dashboards', 'Stakeholder Management'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$85k-$135k'
  },
  {
    roleTitle: 'IT Support Specialist',
    industry: 'Technology',
    coreSkills: ['Troubleshooting', 'Customer Service', 'Windows', 'Networking', 'Documentation'],
    seniorityLevels: ['Entry', 'Junior'],
    estimatedSalaryRange: '$45k-$75k'
  },
  {
    roleTitle: 'Business Analyst',
    industry: 'Technology',
    coreSkills: ['Requirements', 'Process Mapping', 'Stakeholder Management', 'Documentation', 'Analytics'],
    seniorityLevels: ['Mid', 'Senior'],
    estimatedSalaryRange: '$90k-$150k'
  },
  {
    roleTitle: 'Engineering Manager',
    industry: 'Technology',
    coreSkills: ['Leadership', 'People Management', 'System Design', 'Planning', 'Communication'],
    seniorityLevels: ['Manager', 'Senior'],
    estimatedSalaryRange: '$160k-$240k'
  }
];

function _normStr(v) {
  return String(v || '')
    .trim()
    .toLowerCase();
}

function _uniqNorm(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const n = _normStr(it);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function _roleTitleTokens(title) {
  const t = _normStr(title);
  if (!t) return [];
  return t
    .split(/[^a-z0-9]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    // Remove ultra-common generic words to reduce false positives.
    .filter((x) => !['and', 'of', 'the', 'a', 'an', 'to', 'for', 'in', 'on', 'with'].includes(x));
}

function _roleTitleOverlapCount(a, b) {
  const at = new Set(_roleTitleTokens(a));
  const bt = new Set(_roleTitleTokens(b));
  let cnt = 0;
  for (const tok of at) {
    if (bt.has(tok)) cnt += 1;
  }
  return cnt;
}

function _seniorityRank(s) {
  const v = _normStr(s);
  if (!v) return 2;

  // Common variants
  if (/\b(intern|trainee|entry)\b/.test(v)) return 0;
  if (/\b(junior|jr)\b/.test(v)) return 1;
  if (/\b(mid|intermediate)\b/.test(v)) return 2;
  if (/\b(senior|sr|lead)\b/.test(v)) return 3;
  if (/\b(staff|principal)\b/.test(v)) return 4;
  if (/\b(manager|head|director|vp|chief|cto|cio)\b/.test(v)) return 5;

  // Default mid-ish
  return 2;
}

function _matchesProgression({ personaCurrentRole, personaSeniority, roleTitle, roleSeniorityLevels }) {
  const personaRank = _seniorityRank(personaSeniority);
  const allowed = Array.isArray(roleSeniorityLevels) ? roleSeniorityLevels : [];
  const allowedRanks = allowed.map(_seniorityRank);

  // If catalog doesn't specify seniority, allow it (Phase 1).
  if (allowedRanks.length === 0) return true;

  const minRank = Math.min(...allowedRanks);
  const maxRank = Math.max(...allowedRanks);

  // "Logical next step or lateral move"
  // - Allow same rank (lateral)
  // - Allow +1 rank (next step)
  if (personaRank >= minRank && personaRank <= maxRank) return true;
  if (personaRank + 1 >= minRank && personaRank + 1 <= maxRank) return true;

  // Sometimes a role like "Senior X" when persona seniority is ambiguous: allow if titles overlap
  const cur = _normStr(personaCurrentRole);
  const cand = _normStr(roleTitle);
  if (cur && cand && (cand.includes(cur) || cur.includes(cand))) return true;

  return false;
}

function _buildMatchReason({ overlapSkills, industryMatched, titleAligned, progressionOk }) {
  const skills = overlapSkills.slice(0, 2);

  // Prefer a concrete single reason string as requested (e.g., "Matches your skill: X").
  if (skills.length >= 1) return `Matches your skill: ${skills[0]}`;

  if (industryMatched) return 'Matches your industry.';
  if (titleAligned) return 'Aligns with your current role title.';
  if (progressionOk) return 'Matches your current level or a logical next step.';

  return 'Recommended based on your Final Persona.';
}

async function _ensureSeededIfEmpty() {
  const cnt = await rolesRepo.countRoles();
  if (cnt > 0) return { seeded: false, roleCount: cnt };

  await rolesRepo.bulkInsertRoles(DEFAULT_ROLES_CATALOG);
  const roleCount = await rolesRepo.countRoles();
  return { seeded: true, roleCount };
}

function _deriveUserSkillsForScoring(finalPersona) {
  /**
   * Day 3 needs user skill proficiency percentages to detect mastery/growth.
   *
   * We support multiple persona shapes:
   * - finalPersona.user_skills: [{ name, proficiency }, ...]
   * - finalPersona.userSkills: [{ name, proficiency }, ...]
   * - finalPersona.skills: [{ name, proficiency }, ...]   (if present)
   *
   * If no proficiency-bearing array exists, return [] (threeTwoReport will be not_validated).
   */
  const candidates = [
    finalPersona?.user_skills,
    finalPersona?.userSkills,
    finalPersona?.skills,
    finalPersona?.skillProficiencies
  ];

  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length > 0) return arr;
  }
  return [];
}

// PUBLIC_INTERFACE
async function getRoleRecommendationsFromFinalPersona({ personaId = null, userId = null, pivot = false } = {}) {
  /**
   * Phase 1: generate role recommendations based solely on the Final Persona in DB.
   *
   * We intentionally only use these Final Persona fields:
   * - current_role
   * - industry
   * - validated_skills (array)
   * - seniority_level
   *
   * Day 3 additive behavior:
   * - If proficiency-bearing user skills are available on the final persona, include a threeTwoReport
   *   for each recommended role against that role's coreSkills.
   *
   * Matching rules:
   * - Skills: prioritize roles with >=3 overlapping skills with validated_skills.
   * - Progression: "logical next step or lateral move" via seniority heuristic.
   * - Industry: default to persona industry unless pivot=true.
   *
   * @returns {Promise<{ recommendations: Array, meta: object }>}
   */
  await _ensureSeededIfEmpty();

  // Fetch latest final persona (scaffold: personasRepo.getFinal returns latest overall for MySQL).
  const finalWrap = await personasRepo.getFinal(personaId || 'latest');
  const finalPersona = finalWrap?.finalJson || null;

  if (!finalPersona || typeof finalPersona !== 'object') {
    const err = new Error('Final Persona not found. Create/finalize a persona first.');
    err.code = 'final_persona_not_found';
    err.httpStatus = 404;
    throw err;
  }

  const personaCurrentRole = finalPersona.current_role || finalPersona.currentRole || '';
  const personaIndustry = finalPersona.industry || '';
  const personaSeniority = finalPersona.seniority_level || finalPersona.seniorityLevel || finalPersona.seniority || '';
  const personaSkills = _uniqNorm(finalPersona.validated_skills || finalPersona.validatedSkills || []);

  if (personaSkills.length === 0) {
    const err = new Error('Final Persona missing validated_skills; cannot compute recommendations.');
    err.code = 'final_persona_missing_skills';
    err.httpStatus = 422;
    throw err;
  }

  const userSkillsForScoring = _deriveUserSkillsForScoring(finalPersona);

  const roles = await rolesRepo.listRoles({ limit: 2000 });

  const scored = roles
    .map((r) => {
      const roleSkills = _uniqNorm(r.coreSkills || []);
      const overlap = roleSkills.filter((s) => personaSkills.includes(s));
      const overlapCount = overlap.length;

      // FINAL PERSONA: industry filter/priority
      const industryMatched =
        pivot ? true : !_normStr(personaIndustry) || _normStr(r.industry) === _normStr(personaIndustry);

      // FINAL PERSONA: role title alignment (direct match based on title tokens)
      const titleOverlap = _roleTitleOverlapCount(personaCurrentRole, r.roleTitle);
      const titleAligned = titleOverlap >= 1;

      // FINAL PERSONA: seniority / next logical step
      const progressionOk = _matchesProgression({
        personaCurrentRole,
        personaSeniority,
        roleTitle: r.roleTitle,
        roleSeniorityLevels: r.seniorityLevels
      });

      // Direct-match scoring: skills dominate, then industry, then title/progression.
      const score =
        overlapCount * 10 +
        (industryMatched ? 5 : -50) +
        (titleAligned ? 3 : 0) +
        (progressionOk ? 2 : -5);

      return {
        role: r,
        score,
        overlap,
        overlapCount,
        industryMatched,
        titleAligned,
        progressionOk
      };
    })
    // Direct-match-only hard filters:
    // - Skills: must match at least 2 validated skills (persona.validated_skills)
    // - Industry: must match persona.industry (unless pivot=true)
    // - Role Title / Seniority: must align with current title OR match progression
    .filter((x) => x.overlapCount >= 2)
    .filter((x) => (pivot ? true : x.industryMatched))
    .filter((x) => x.titleAligned || x.progressionOk);

  // Fallback: if too strict, allow progression OR title alignment to be the only "role title/seniority" gate,
  // but keep skills+industry rules intact. (Still direct-match based on Final Persona.)
  const fallbackPool =
    scored.length >= 5
      ? scored
      : roles
          .map((r) => {
            const roleSkills = _uniqNorm(r.coreSkills || []);
            const overlap = roleSkills.filter((s) => personaSkills.includes(s));
            const overlapCount = overlap.length;

            const industryMatched =
              pivot ? true : !_normStr(personaIndustry) || _normStr(r.industry) === _normStr(personaIndustry);

            const titleOverlap = _roleTitleOverlapCount(personaCurrentRole, r.roleTitle);
            const titleAligned = titleOverlap >= 1;

            const progressionOk = _matchesProgression({
              personaCurrentRole,
              personaSeniority,
              roleTitle: r.roleTitle,
              roleSeniorityLevels: r.seniorityLevels
            });

            const score = overlapCount * 10 + (industryMatched ? 5 : -50) + (titleAligned ? 2 : 0) + (progressionOk ? 1 : 0);

            return { role: r, score, overlap, overlapCount, industryMatched, titleAligned, progressionOk };
          })
          .filter((x) => x.overlapCount >= 2)
          .filter((x) => (pivot ? true : x.industryMatched))
          .filter((x) => x.titleAligned || x.progressionOk);

  const top = [...fallbackPool].sort((a, b) => b.score - a.score).slice(0, 5);

  const recommendations = top.map((x) => {
    const threeTwoReport = buildThreeTwoReport(userSkillsForScoring, x.role.coreSkills || []);

    return {
      role_id: x.role.roleId,
      role_title: x.role.roleTitle,
      industry: x.role.industry,
      match_reason: _buildMatchReason({
        overlapSkills: x.overlap,
        industryMatched: x.industryMatched,
        titleAligned: x.titleAligned,
        progressionOk: x.progressionOk
      }),
      estimated_salary_range: x.role.estimatedSalaryRange || null,
      // Day 3 additive field
      threeTwoReport
    };
  });

  return {
    recommendations,
    meta: {
      personaUsed: {
        personaId: finalWrap?.personaId ?? personaId ?? null,
        current_role: personaCurrentRole || null,
        industry: personaIndustry || null,
        seniority_level: personaSeniority || null,
        validated_skills_count: personaSkills.length
      },
      pivot: Boolean(pivot),
      candidatesConsidered: roles.length
    }
  };
}

module.exports = {
  DEFAULT_ROLES_CATALOG,
  getRoleRecommendationsFromFinalPersona
};
