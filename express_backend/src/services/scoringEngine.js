'use strict';

/**
 * Day 3 Scoring Engine
 *
 * Implements:
 * 1) Mastery detection (>= 80%)
 * 2) Growth detection (20% - 60% inclusive)
 * 3) 3/2 validation check: select top 3 mastery + top 2 growth against role requirements.
 *
 * This module is intentionally framework-agnostic (pure functions) so it can be used
 * by services and tested in isolation.
 */

const MASTERY_THRESHOLD = 80;
const GROWTH_MIN = 20;
const GROWTH_MAX = 60;

function _normStr(v) {
  return String(v || '')
    .trim()
    .toLowerCase();
}

function _toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _clampPercent(v) {
  if (v == null) return null;
  return Math.max(0, Math.min(100, v));
}

function _skillNameFromUserSkill(userSkill) {
  if (userSkill == null) return null;

  // Accept common shapes:
  // - { name: 'React', proficiency: 90 }
  // - { skill: 'React', proficiency: 90 }
  // - { skill_name: 'React', proficiency_percent: 90 }
  // - 'React' (unsupported for 3/2 because no proficiency)
  if (typeof userSkill === 'string') return String(userSkill);
  if (typeof userSkill !== 'object') return null;

  return (
    userSkill.name ||
    userSkill.skill ||
    userSkill.skill_name ||
    userSkill.skillName ||
    userSkill.label ||
    null
  );
}

function _proficiencyFromUserSkill(userSkill) {
  if (userSkill == null || typeof userSkill !== 'object') return null;

  // Accept common shapes:
  // - proficiency (0-100)
  // - proficiencyPercent
  // - proficiency_percent
  // - percent
  const raw =
    userSkill.proficiency ??
    userSkill.proficiencyPercent ??
    userSkill.proficiency_percent ??
    userSkill.percent ??
    userSkill.score ??
    null;

  const n = _toNumber(raw);
  return _clampPercent(n);
}

function _asRoleRequirementsArray(roleRequirements) {
  // Expect roleRequirements to be an array of skill names.
  if (Array.isArray(roleRequirements)) return roleRequirements;

  // Support a role object shape: { coreSkills: [...] } (as used by roles catalog)
  if (roleRequirements && typeof roleRequirements === 'object' && Array.isArray(roleRequirements.coreSkills)) {
    return roleRequirements.coreSkills;
  }

  return [];
}

// PUBLIC_INTERFACE
function classifySkillProficiency(userSkills) {
  /**
   * Classify user skills into mastery and growth lists based on Day 3 thresholds.
   *
   * Mastery: proficiency >= 80
   * Growth:  20 <= proficiency <= 60
   *
   * @param {Array<object>} userSkills Array of user skill objects with a skill name + proficiency percent.
   * @returns {{
   *   mastery: Array<{ name: string, proficiency: number }>,
   *   growth: Array<{ name: string, proficiency: number }>,
   *   other: Array<{ name: string, proficiency: number }>,
   * }}
   */
  const mastery = [];
  const growth = [];
  const other = [];

  for (const s of Array.isArray(userSkills) ? userSkills : []) {
    const nameRaw = _skillNameFromUserSkill(s);
    const proficiency = _proficiencyFromUserSkill(s);
    const name = nameRaw ? String(nameRaw).trim() : null;

    if (!name || proficiency == null) continue;

    const row = { name, proficiency };

    if (proficiency >= MASTERY_THRESHOLD) {
      mastery.push(row);
    } else if (proficiency >= GROWTH_MIN && proficiency <= GROWTH_MAX) {
      growth.push(row);
    } else {
      other.push(row);
    }
  }

  // Sort descending proficiency to allow deterministic "top N" selection.
  mastery.sort((a, b) => b.proficiency - a.proficiency);
  growth.sort((a, b) => b.proficiency - a.proficiency);
  other.sort((a, b) => b.proficiency - a.proficiency);

  return { mastery, growth, other };
}

// PUBLIC_INTERFACE
function validateThreeTwoBalance(userSkills, roleRequirements) {
  /**
   * Validate whether a user satisfies the "3 mastered + 2 growth" balance against a role's requirements.
   *
   * - We compare user skills against *role-required skills* (roleRequirements).
   * - We must select:
   *   - top 3 mastery skills that are also required by the role
   *   - top 2 growth skills that are also required by the role
   * - If role requires many skills, we still only pick the "best" 3 masteries and "best" 2 growth areas
   *   (by user proficiency) to see if the 3/2 balance can be satisfied.
   *
   * Return:
   * - isValidThreeTwo (boolean)
   * - masteryAreas (exact skill names selected)
   * - growthAreas (exact skill names selected)
   * - score: 100 if validated else 0 (kept simple per requirements example)
   *
   * @param {Array<object>} userSkills Array of user skill objects with proficiency percent.
   * @param {Array<string>|object} roleRequirements Array of role skill names OR a role object containing coreSkills.
   * @returns {{
   *  isValidThreeTwo: boolean,
   *  masteryAreas: string[],
   *  growthAreas: string[],
   *  score: number,
   * }}
   */
  const reqList = _asRoleRequirementsArray(roleRequirements);
  const reqNormSet = new Set((reqList || []).map(_normStr).filter(Boolean));

  const { mastery, growth } = classifySkillProficiency(userSkills);

  const masteryMatching = mastery.filter((s) => reqNormSet.has(_normStr(s.name)));
  const growthMatching = growth.filter((s) => reqNormSet.has(_normStr(s.name)));

  const masteryTop3 = masteryMatching.slice(0, 3).map((s) => s.name);
  const growthTop2 = growthMatching.slice(0, 2).map((s) => s.name);

  const isValidThreeTwo = masteryTop3.length === 3 && growthTop2.length === 2;

  return {
    isValidThreeTwo,
    masteryAreas: masteryTop3,
    growthAreas: growthTop2,
    score: isValidThreeTwo ? 100 : 0
  };
}

// PUBLIC_INTERFACE
function buildThreeTwoReport(userSkills, roleRequirements) {
  /**
   * Build the API-facing report object expected by Day 3 requirements.
   *
   * @param {Array<object>} userSkills
   * @param {Array<string>|object} roleRequirements
   * @returns {{
   *   status: 'validated'|'not_validated',
   *   masteryAreas: string[],
   *   growthAreas: string[],
   *   score: number
   * }}
   */
  const res = validateThreeTwoBalance(userSkills, roleRequirements);
  return {
    status: res.isValidThreeTwo ? 'validated' : 'not_validated',
    masteryAreas: res.masteryAreas,
    growthAreas: res.growthAreas,
    score: res.score
  };
}

function _normSkillSet(arr) {
  const set = new Set();
  for (const s of Array.isArray(arr) ? arr : []) {
    const k = _normStr(s);
    if (k) set.add(k);
  }
  return set;
}

// PUBLIC_INTERFACE
function scoreRoleCompatibility(userSkills, roleRequiredSkills) {
  /**
   * Day 3 real-time scoring (authoritative user_input_ref):
   * - Compare role required_skills against FinalizedPersona skills+proficiencies.
   * - Mastery: any skill where user proficiency >= 80%
   * - Growth:  any skill where user proficiency is 20%–60%
   * - Compatibility %: percentage of required_skills that are either Mastery or Growth.
   *
   * Returns both:
   * - score (0..100 integer)
   * - masteryAreas (intersection skill names)
   * - growthAreas (intersection skill names)
   *
   * @param {Array<object>} userSkills proficiency-bearing skills
   * @param {Array<string>|object} roleRequiredSkills array of required skill names (or role object w/ coreSkills)
   * @returns {{ score:number, masteryAreas:string[], growthAreas:string[] }}
   */
  const reqList = _asRoleRequirementsArray(roleRequiredSkills).map((s) => String(s || '').trim()).filter(Boolean);

  if (reqList.length === 0) {
    return { score: 0, masteryAreas: [], growthAreas: [] };
  }

  const reqNorm = _normSkillSet(reqList);

  const { mastery, growth } = classifySkillProficiency(userSkills);

  const masteryAreas = mastery
    .filter((s) => reqNorm.has(_normStr(s.name)))
    .slice(0, reqList.length) // keep stable
    .map((s) => s.name);

  const growthAreas = growth
    .filter((s) => reqNorm.has(_normStr(s.name)))
    .slice(0, reqList.length)
    .map((s) => s.name);

  const covered = new Set([...masteryAreas, ...growthAreas].map((s) => _normStr(s)).filter(Boolean));
  const score = Math.round((covered.size / reqNorm.size) * 100);

  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    masteryAreas,
    growthAreas
  };
}

module.exports = {
  classifySkillProficiency,
  validateThreeTwoBalance,
  buildThreeTwoReport,
  scoreRoleCompatibility
};
