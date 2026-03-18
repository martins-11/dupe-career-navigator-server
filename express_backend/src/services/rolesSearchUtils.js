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
  if (!finalPersonaEnvelope || typeof finalPersonaEnvelope !== 'object') return null;

  // Handle MySQL Envelope: { personaId, finalJson: "{...}" }
  if (finalPersonaEnvelope.finalJson) {
    const raw = finalPersonaEnvelope.finalJson;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error("[rolesSearchUtils] Failed to parse finalJson string:", e);
      return null;
    }
  }

  // Handle direct objects (Memory/Fallback)
  if (!Array.isArray(finalPersonaEnvelope)) return finalPersonaEnvelope;

  return null;
}

/**
 * PUBLIC_INTERFACE
 */
function extractPersonaProficiencies(finalPersonaEnvelope) {
  const personaObj = extractFinalPersonaObject(finalPersonaEnvelope) || {};
  const out = [];

  // 1) Explicit Proficiency Lists
  const explicitCandidates = [
    personaObj.skills_with_proficiency,
    personaObj.skillsWithProficiency,
    personaObj.user_skills,
    personaObj.userSkills,
    personaObj.proficiencies,
  ];

  for (const c of explicitCandidates) {
    if (!Array.isArray(c)) continue;
    for (const row of c) {
      if (!row || typeof row !== 'object') continue;
      const name = _normStr(row.name || row.skill || row.skill_name || row.label);
      const raw = row.proficiency ?? row.percent ?? row.score ?? null;
      const n = _clampPercent(_tryReadNumber(raw));
      if (name && n !== null) out.push({ name, proficiency: n });
    }
    if (out.length) break;
  }

  // 2) Derive from Flat Skill Lists (Common in Phase 1 / MySQL)
  // This is the CRITICAL fix for your 0% score issue.
  if (out.length === 0) {
    const flatCandidates = [
      personaObj.validated_skills,
      personaObj.validatedSkills,
      personaObj.skills,
      personaObj.core_skills
    ];

    for (const list of flatCandidates) {
      if (!Array.isArray(list) || list.length === 0) continue;
      for (const s of list) {
        const name = typeof s === 'string' ? _normStr(s) : _normStr(s?.name || s?.skill);
        if (name) {
          // Default to 85% so the scoring engine treats these as "Mastered"
          out.push({ name, proficiency: 85 });
        }
      }
      if (out.length) break;
    }
  }

  // 3) Fallback to Nested Schema (Technical Stack)
  if (out.length === 0) {
    const addGroup = (arr, p) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(n => {
        const name = _normStr(n);
        if (name) out.push({ name, proficiency: p });
      });
    };

    addGroup(personaObj.core_competencies, 90);
    const ts = personaObj.technical_stack || {};
    addGroup(ts.languages, 80);
    addGroup(ts.frameworks, 80);
    addGroup(ts.databases, 75);
    addGroup(ts.tools, 70);
  }

  // Deduplicate and Sort
  const unique = new Map();
  out.forEach(item => {
    const key = item.name.toLowerCase();
    if (!unique.has(key) || unique.get(key).proficiency < item.proficiency) {
      unique.set(key, item);
    }
  });

  return Array.from(unique.values()).sort((a, b) => b.proficiency - a.proficiency);
}

/**
 * PUBLIC_INTERFACE
 */
function buildScoringUserSkills({ finalPersonaEnvelope, fallbackUserSkills }) {
  const profs = extractPersonaProficiencies(finalPersonaEnvelope);
  if (profs && profs.length > 0) {
    return { userSkills: profs, usedPersonaProficiencies: true };
  }

  const fb = Array.isArray(fallbackUserSkills) ? fallbackUserSkills : [];
  return { userSkills: fb, usedPersonaProficiencies: false };
}

/**
 * PUBLIC_INTERFACE
 */
function normalizeSalaryToIndiaLpaRange(salaryRange) {
  const s = _normStr(salaryRange);
  if (!s) return '';
  if (/(₹|inr|lpa|lakhs)/i.test(s)) return s;

  const tokens = s.toLowerCase().match(/(\d+(\.\d+)?)(\s*[kmb])?/g) || [];
  const vals = tokens.map(t => {
    const m = String(t).trim().match(/^(\d+(\.\d+)?)(\s*[kmb])?$/);
    if (!m) return null;
    const num = Number(m[1]);
    const suffix = (m[3] || '').trim();
    const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1;
    return num * mult;
  }).filter(v => v !== null);

  if (vals.length === 0) return s;

  const usdToInr = Number(process.env.USD_TO_INR || 83);
  const toLpa = (usd) => Math.round((usd * usdToInr) / 100000);
  
  const min = toLpa(Math.min(...vals));
  const max = toLpa(Math.max(...vals));

  return `₹${min}–₹${max} LPA`;
}
export {
  extractFinalPersonaObject,
  extractPersonaProficiencies,
  buildScoringUserSkills,
  normalizeSalaryToIndiaLpaRange
};

export default {
  extractFinalPersonaObject,
  extractPersonaProficiencies,
  buildScoringUserSkills,
  normalizeSalaryToIndiaLpaRange
};