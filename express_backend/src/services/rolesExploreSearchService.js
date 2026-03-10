'use strict';

const bedrockService = require('./bedrockService');
const personasRepo = require('../repositories/personasRepoAdapter');
const { buildThreeTwoReport, scoreRoleCompatibility } = require('./scoringEngine');
const { extractFinalPersonaObject, buildScoringUserSkills, normalizeSalaryToIndiaLpaRange } = require('./rolesSearchUtils');

function _normStr(v) {
  return String(v || '').trim();
}

/**
 * Normalizes strings for "fuzzy" comparison (e.g., Node.js === nodejs)
 */
function _normalizeForFuzzyMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
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
  const candidates = [p.validated_skills, p.validatedSkills, p.skills, p.core_skills];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    return arr
      .map((x) => (typeof x === 'string' ? x : x?.name || x?.skill || x?.label))
      .map((s) => _normStr(s))
      .filter(Boolean)
      .slice(0, 30);
  }
  return [];
}

function _decorateAndScoreRoles({ roles, scoringUserSkills }) {
  const out = [];
  
  for (const r of Array.isArray(roles) ? roles : []) {
    const rawReq = r.required_skills || r.skills_required || [];
    const requiredSkills = Array.isArray(rawReq) 
      ? rawReq.map(s => _normStr(s)).filter(Boolean).slice(0, 10)
      : [];

    /**
     * FUZZY MATCHING LOGIC:
     * We create a version of user skills where names match the AI's output
     * if they are semantically the same (e.g. "Node.js" vs "NodeJS").
     */
    const fuzzyUserSkills = scoringUserSkills.map(uSkill => {
      const uNorm = _normalizeForFuzzyMatch(uSkill.name || uSkill.skill);
      const matchingReqSkill = requiredSkills.find(rSkill => _normalizeForFuzzyMatch(rSkill) === uNorm);
      
      return {
        ...uSkill,
        name: matchingReqSkill || uSkill.name // Temporarily rename to match role for the scoring engine
      };
    });

    const report = buildThreeTwoReport(fuzzyUserSkills, requiredSkills);
    const compat = scoreRoleCompatibility(fuzzyUserSkills, requiredSkills);

    const requiredSkillsCount = requiredSkills.length;
    const masteryCount = Array.isArray(compat.masteryAreas) ? compat.masteryAreas.length : 0;
    const growthCount = Array.isArray(compat.growthAreas) ? compat.growthAreas.length : 0;

    const masteryScore = requiredSkillsCount ? Math.round((masteryCount / requiredSkillsCount) * 100) : 0;
    const growthScore = requiredSkillsCount ? Math.round((growthCount / requiredSkillsCount) * 100) : 0;

    out.push({
      ...r,
      salary_range: normalizeSalaryToIndiaLpaRange(r.salary_range || ''),
      required_skills: requiredSkills,

      // Keep existing payload, but add explicit fields the frontend rings can reliably use.
      threeTwoReport: {
        ...report,
        compatibilityScore: compat.score,
      },
      compatibilityScore: compat.score,
      finalCompatibilityScore: Math.max(
        0,
        Math.min(
          100,
          Math.round(0.6 * (compat.score || 0) + 0.4 * (report.status === 'validated' ? 100 : 0))
        )
      ),

      masteryAreas: compat.masteryAreas,
      growthAreas: compat.growthAreas,
      masteryScore,
      growthScore,
      masteryCount,
      growthCount,

      match_metadata: {
        ...(r.match_metadata || {}),
        scoring: {
          usedFuzzyMatching: true,
          matchedSkillCount: report.masteryAreas.length + report.growthAreas.length,
          requiredSkillsCount,
          threeTwoValidationScore: report.status === 'validated' ? 100 : 0,
        },
      },
    });
  }

  out.sort((a, b) => (b.compatibilityScore || 0) - (a.compatibilityScore || 0));
  return out;
}

// PUBLIC_INTERFACE
async function exploreSearchRolesPersonaDriven({ q, limit = 30, personaId = null } = {}) {
  const searchQuery = _normStr(q);
  
  let finalEnvelope = null;
  let finalPersonaObj = null;

  if (personaId) {
    try {
      finalEnvelope = await _loadFinalPersonaEnvelope(personaId);
      finalPersonaObj = extractFinalPersonaObject(finalEnvelope);
    } catch (err) {
      console.error("[ExploreService] DB Load Error:", err.message);
    }
  }

  const validatedSkillNames = _extractValidatedSkillNames(finalPersonaObj);
  const { userSkills: scoringUserSkills } = buildScoringUserSkills({
    finalPersonaEnvelope: finalEnvelope,
    fallbackUserSkills: []
  });

  const bedrock = await bedrockService.generateTargetedRolesSafe({
    query: searchQuery,
    finalPersonaObj: finalPersonaObj || {},
    scoringUserSkills,
    validated_skills: validatedSkillNames
  });

  const roles = Array.isArray(bedrock?.roles) ? bedrock.roles : [];
  const scored = _decorateAndScoreRoles({ roles, scoringUserSkills });

  return _safeSlice(scored, 5);
}

module.exports = { exploreSearchRolesPersonaDriven };