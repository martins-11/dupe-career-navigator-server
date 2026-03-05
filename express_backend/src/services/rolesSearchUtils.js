'use strict';

/**
 * Utilities used by /api/roles/search:
 * - Extract proficiency-bearing skills from Finalized Persona shapes
 * - Provide scoring-ready user_skills array
 * - Localize salary ranges to India ₹LPA strings
 */

function _normStr(v) {
  return String(v || '').trim();
}

function _clampPercent(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function _tryReadNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * PUBLIC_INTERFACE
 */
function extractFinalPersonaObject(finalPersonaEnvelope) {
  /**
   * Normalize the repository return shapes into the actual final persona JSON object.
   * Repos may return:
   * - memory: finalJson object (direct)
   * - mysql: { personaId, finalId, finalJson, updatedAt }
   * - other: any object
   *
   * @param {any} finalPersonaEnvelope
   * @returns {object|null} final persona JSON object
   */
  if (!finalPersonaEnvelope || typeof finalPersonaEnvelope !== 'object') return null;

  // If it's an envelope with finalJson, unwrap.
  if (finalPersonaEnvelope.finalJson && typeof finalPersonaEnvelope.finalJson === 'object') {
    return finalPersonaEnvelope.finalJson;
  }

  // Otherwise assume it is already the persona object.
  if (!Array.isArray(finalPersonaEnvelope)) return finalPersonaEnvelope;

  return null;
}

/**
 * PUBLIC_INTERFACE
 */
function extractPersonaProficiencies(finalPersonaEnvelope) {
  /**
   * Extract [{name, proficiency}] from the finalized persona.
   *
   * Supports common shapes:
   * - persona.skills_with_proficiency = [{name, proficiency}]
   * - persona.user_skills = [{name, proficiency}] or [{skill_name, proficiency_percent}]
   * - persona.proficiencies = [{skill, percent}]
   *
   * Also supports the current Finalized Persona schema emitted by orchestration/personaService:
   * - professional_summary, core_competencies, technical_stack (languages/frameworks/databases/...)
   *
   * That schema typically does NOT carry explicit numeric proficiencies; to enable downstream
   * Day-3 scoring/validation we derive a reasonable default proficiency for these skills:
   * - core_competencies: 85 (treat as strengths / likely mastery)
   * - technical_stack.*: 70 (treat as solid working proficiency)
   *
   * This is intentionally conservative-but-useful: it enables `usedPersonaProficiencies=true`
   * and allows 3/2 validation to produce populated masteryAreas/growthAreas when personaId is provided.
   *
   * @param {any} finalPersonaEnvelope
   * @returns {Array<{name:string, proficiency:number}>}
   */
  const personaObj = extractFinalPersonaObject(finalPersonaEnvelope) || {};

  // 1) Prefer explicit proficiency-bearing lists when present.
  const candidates = [
    personaObj.skills_with_proficiency,
    personaObj.skillsWithProficiency,
    personaObj.user_skills,
    personaObj.userSkills,
    personaObj.proficiencies,
    personaObj.skillProficiencies,
  ];

  const out = [];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;

    for (const row of c) {
      if (!row) continue;

      if (typeof row === 'string') {
        // A string-only skill cannot produce proficiency-based scoring.
        continue;
      }

      if (typeof row !== 'object') continue;

      const name = _normStr(row.name || row.skill || row.skill_name || row.skillName || row.label);
      const raw =
        row.proficiency ??
        row.proficiencyPercent ??
        row.proficiency_percent ??
        row.percent ??
        row.score ??
        null;

      const n = _clampPercent(_tryReadNumber(raw));
      if (!name || n == null) continue;

      out.push({ name, proficiency: n });
    }

    if (out.length) break;
  }

  // 2) If nothing explicit exists, derive proficiencies from the finalized persona schema.
  if (out.length === 0) {
    const derived = [];

    const addMany = (names, proficiency) => {
      for (const n of Array.isArray(names) ? names : []) {
        const name = _normStr(n);
        const p = _clampPercent(_tryReadNumber(proficiency));
        if (!name || p == null) continue;
        derived.push({ name, proficiency: p });
      }
    };

    // Core competencies are effectively "strengths" in this schema.
    addMany(personaObj.core_competencies, 85);

    // Technical stack is typically tool/language/framework familiarity.
    const ts = personaObj.technical_stack && typeof personaObj.technical_stack === 'object' ? personaObj.technical_stack : {};
    addMany(ts.languages, 70);
    addMany(ts.frameworks, 70);
    addMany(ts.databases, 70);
    addMany(ts.cloud_and_devops, 70);
    addMany(ts.tools, 70);

    // Deduplicate by case-insensitive name, keep max proficiency.
    const byKey = new Map();
    for (const row of derived) {
      const key = row.name.toLowerCase();
      const prev = byKey.get(key);
      if (!prev || (prev.proficiency ?? 0) < (row.proficiency ?? 0)) byKey.set(key, row);
    }

    out.push(...Array.from(byKey.values()));
  }

  // Sort for determinism (highest proficiency first).
  out.sort((a, b) => b.proficiency - a.proficiency);
  return out;
}

/**
 * PUBLIC_INTERFACE
 */
function buildScoringUserSkills({ finalPersonaEnvelope, fallbackUserSkills }) {
  /**
   * Build a scoring-ready user skills array.
   * Prefer Finalized Persona proficiencies; fall back to provided fallback skills.
   *
   * @param {{finalPersonaEnvelope:any, fallbackUserSkills:Array<{name:string, proficiency:number}>}} input
   * @returns {{ userSkills: Array<{name:string, proficiency:number}>, usedPersonaProficiencies: boolean }}
   */
  const profs = extractPersonaProficiencies(finalPersonaEnvelope);
  if (Array.isArray(profs) && profs.length > 0) {
    return { userSkills: profs, usedPersonaProficiencies: true };
  }

  const fb = Array.isArray(fallbackUserSkills) ? fallbackUserSkills : [];
  return { userSkills: fb, usedPersonaProficiencies: false };
}

/**
 * PUBLIC_INTERFACE
 */
function normalizeSalaryToIndiaLpaRange(salaryRange) {
  /**
   * Convert a salary range string to "₹x–₹y LPA" when possible.
   * If already INR/LPA-ish, returns as-is.
   * Best-effort USD "$130k-$210k" conversion based on USD_TO_INR env var (default 83).
   *
   * @param {string} salaryRange
   * @returns {string}
   */
  const s = _normStr(salaryRange);
  if (!s) return '';

  // If already INR/LPA-ish, keep it.
  if (/(₹|inr|lpa|lakhs)/i.test(s)) return s;

  // Extract numbers with optional k/m/b suffix.
  const tokens = s.toLowerCase().match(/(\d+(\.\d+)?)(\s*[kmb])?/g) || [];
  const vals = tokens
    .map((t) => {
      const m = String(t)
        .trim()
        .match(/^(\d+(\.\d+)?)(\s*[kmb])?$/);
      if (!m) return null;
      const num = Number(m[1]);
      if (!Number.isFinite(num)) return null;
      const suffix = (m[3] || '').trim();
      const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : suffix === 'b' ? 1000000000 : 1;
      return num * mult;
    })
    .filter((v) => Number.isFinite(v));

  if (vals.length === 0) return s;

  const usdToInrRaw = Number(process.env.USD_TO_INR || 83);
  const usdToInr = Number.isFinite(usdToInrRaw) && usdToInrRaw > 0 ? usdToInrRaw : 83;

  const toLpa = (usd) => Math.max(1, Math.round(((usd * usdToInr) / 100000) * 10) / 10); // 1 decimal
  const min = toLpa(Math.min(...vals));
  const max = toLpa(Math.max(...vals));

  return `₹${min}–₹${max} LPA`;
}

module.exports = {
  extractFinalPersonaObject,
  extractPersonaProficiencies,
  buildScoringUserSkills,
  normalizeSalaryToIndiaLpaRange,
};
