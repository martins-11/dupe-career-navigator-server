import exploreRecommendationsPoolService from './exploreRecommendationsPoolService.js';
import personasRepo from '../repositories/personasRepoAdapter.js';
import { buildThreeTwoReport, scoreRoleCompatibility } from './scoringEngine.js';

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Multiverse Explorer service layer.
 *
 * Responsibilities:
 * - Build a "multiverse graph" from the persisted Explore recommendations pool for a persona.
 * - Apply server-side filters (salary, similarity, time horizon) to keep payload bounded.
 * - Provide node details and path details drill-down payloads.
 *
 * Multiverse path details enrichment:
 * - For the selected pathType (lateral|vertical|pivot|non_linear), generate EXACTLY 5 role-card
 *   recommendations constrained to that pathType.
 * - These role cards are persona-personalized using the finalized persona (when available).
 * - Role cards include enough detail to power the frontend "RoleCard" drill-down:
 *   salary/experience/skills/responsibilities + compatibility score.
 *
 * Resilience:
 * - If Bedrock is unavailable or times out, return deterministic fallback role cards (still pathType-labeled).
 * - If a client uses a legacy path id (e.g., passing a role title instead of "path_1"), we attempt
 *   to resolve it to a real path to avoid infinite 404/refetch loops.
 */

function _normalizeLabel(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function _slugify(v) {
  return _normalizeLabel(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function _parseSalaryRangeToUsdKMidpoint(salaryRange) {
  /**
   * Parse salary range to a numeric midpoint in *thousands USD* (k USD).
   *
   * Supports:
   * - "$120k–$180k"
   * - "$120000-$180000"
   * - "USD 120k to 180k"
   *
   * If an INR/LPA string is encountered (legacy data), return null to avoid mixing units.
   */
  if (!salaryRange) return null;
  const s = String(salaryRange).trim();

  // Legacy India formats (do not attempt to convert).
  if (/(₹|inr|lpa|lakhs)/i.test(s)) return null;

  const m = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*([kmb])?\s*(?:–|-|to)\s*\$?\s*(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const mult = (suffix) => {
    const t = String(suffix || '').toLowerCase();
    if (t === 'k') return 1;
    if (t === 'm') return 1000;
    if (t === 'b') return 1000000;
    return 1;
  };

  const aK = a * mult(m[2]);
  const bK = b * mult(m[4]);

  return (aK + bK) / 2;
}

function _roleIdFromPoolRole(r) {
  return String(r?.role_id || r?.roleId || r?.id || r?.role_title || r?.title || '').trim();
}

function _roleTitleFromPoolRole(r) {
  return _normalizeLabel(r?.role_title || r?.roleTitle || r?.title || r?.name || 'Role');
}

function _roleIndustryFromPoolRole(r) {
  const v = r?.industry;
  return v != null ? _normalizeLabel(v) : null;
}

function _roleSkillsFromPoolRole(r) {
  return _safeArray(r?.required_skills || r?.skills_required || r?.coreSkills).filter(Boolean);
}

function _roleSalaryRangeFromPoolRole(r) {
  return r?.salary_lpa_range || r?.salary_range || r?.salaryRange || null;
}

function _roleExperienceRangeFromPoolRole(r) {
  return r?.experience_range || r?.experienceRange || null;
}

function _compatScoreFromPoolRole(r) {
  const compat =
    Number(r?.finalCompatibilityScore) ||
    Number(r?.compatibilityScore) ||
    Number(r?.threeTwoReport?.compatibilityScore);
  return Number.isFinite(compat) ? Math.max(0, Math.min(100, Math.round(compat))) : null;
}

function _roleToNode(role, { level = 1, isCenter = false } = {}) {
  const id = _roleIdFromPoolRole(role) || (isCenter ? 'current' : '');
  const title = _roleTitleFromPoolRole(role);
  const industry = _roleIndustryFromPoolRole(role);

  const requiredSkills = _roleSkillsFromPoolRole(role);
  const salaryRange = _roleSalaryRangeFromPoolRole(role);
  const experienceRange = _roleExperienceRangeFromPoolRole(role);
  const skillSimilarity = _compatScoreFromPoolRole(role);

  return {
    id: String(id),
    type: isCenter ? 'current_role' : 'role',
    label: title,
    level,
    data: {
      title,
      industry,
      requiredSkills,
      salaryRange,
      experienceRange,
      salaryUsdKMid: _parseSalaryRangeToUsdKMidpoint(salaryRange),
      skillSimilarity,
    },
  };
}

function _buildEdge({ from, to, label = null, timeHorizon = null }) {
  return {
    id: `${from}__to__${to}`,
    source: String(from),
    target: String(to),
    type: 'progression',
    label: label || null,
    data: { timeHorizon: timeHorizon || null },
  };
}

function _applyFiltersToNodes(nodes, { minSalaryUsdK, maxSalaryUsdK, minSalaryLpa, maxSalaryLpa, minSkillSimilarity } = {}) {
  // Canonical: USD thousands (k). Legacy aliases are accepted.
  const minS = (minSalaryUsdK ?? minSalaryLpa) != null ? Number(minSalaryUsdK ?? minSalaryLpa) : null;
  const maxS = (maxSalaryUsdK ?? maxSalaryLpa) != null ? Number(maxSalaryUsdK ?? maxSalaryLpa) : null;
  const minSim = minSkillSimilarity != null ? Number(minSkillSimilarity) : null;

  return nodes.filter((n) => {
    if (n?.type === 'current_role') return true;

    const mid = n?.data?.salaryUsdKMid;
    if (Number.isFinite(minS) && Number.isFinite(mid) && mid < minS) return false;
    if (Number.isFinite(maxS) && Number.isFinite(mid) && mid > maxS) return false;

    const sim = n?.data?.skillSimilarity;
    if (Number.isFinite(minSim)) {
      if (!Number.isFinite(sim)) return false;
      if (sim < minSim) return false;
    }

    return true;
  });
}

function _detailsForNode(node, centerNode) {
  const requiredSkills = _safeArray(node?.data?.requiredSkills).filter(Boolean);
  const centerSkills = _safeArray(centerNode?.data?.requiredSkills).filter(Boolean);
  const centerSet = new Set(centerSkills.map((s) => String(s).toLowerCase()));

  const missing = requiredSkills.filter((s) => !centerSet.has(String(s).toLowerCase()));
  const overlap = requiredSkills.filter((s) => centerSet.has(String(s).toLowerCase()));

  const level = Number(node?.level || 1);
  let transitionTimeline = null;
  if (level <= 1) transitionTimeline = '6–12 months';
  else if (level === 2) transitionTimeline = '12–24 months';
  else transitionTimeline = '24–48 months';

  const salaryMid = node?.data?.salaryUsdKMid;
  const averageSalary = Number.isFinite(salaryMid)
    ? `~$${Math.round(salaryMid)}k (midpoint)`
    : node?.data?.salaryRange || null;

  return {
    id: node.id,
    title: node.data?.title || node.label,
    industry: node.data?.industry || null,
    requiredSkills,
    averageSalary,
    transitionTimeline,
    skillGap: {
      missingSkills: missing,
      matchingSkills: overlap,
      similarityScore: requiredSkills.length > 0 ? Math.round((overlap.length / requiredSkills.length) * 100) : null,
    },
  };
}

function _horizonForLevel(level) {
  if (level <= 1) return 'Near';
  if (level === 2) return 'Mid';
  return 'Far';
}

function _defaultCenterNode({ currentRoleTitle = 'Current Role' } = {}) {
  return _roleToNode(
    { role_id: 'current', role_title: _normalizeLabel(currentRoleTitle), required_skills: [] },
    { level: 0, isCenter: true }
  );
}

function _buildDeterministicPathsFromNodes({ centerNode, nodes, maxPaths = 6 }) {
  /**
   * Build a few "paths" as arrays of nodeIds.
   * This is deterministic and used as a fallback when the client doesn't pass pathIds,
   * or when Bedrock is unavailable.
   */
  const roleNodes = nodes.filter((n) => n.type !== 'current_role');

  // Split by level and by score-ish (skillSimilarity).
  const lvl1 = roleNodes.filter((n) => n.level === 1);
  const lvl2 = roleNodes.filter((n) => n.level === 2);
  const lvl3 = roleNodes.filter((n) => n.level === 3);

  const byScoreDesc = (a, b) => Number(b?.data?.skillSimilarity || 0) - Number(a?.data?.skillSimilarity || 0);

  lvl1.sort(byScoreDesc);
  lvl2.sort(byScoreDesc);
  lvl3.sort(byScoreDesc);

  const paths = [];
  for (let i = 0; i < Math.min(maxPaths, lvl1.length || 0); i += 1) {
    const a = lvl1[i];
    const b = lvl2[i % Math.max(1, lvl2.length)] || null;
    const c = lvl3[i % Math.max(1, lvl3.length)] || null;

    const nodeIds = [centerNode.id, a.id];
    if (b) nodeIds.push(b.id);
    if (c) nodeIds.push(c.id);

    paths.push({
      id: `path_${i + 1}`,
      title: nodeIds
        .slice(1)
        .map((id) => roleNodes.find((n) => n.id === id)?.label || id)
        .join(' → '),
      nodeIds,
      meta: {
        horizon: _horizonForLevel(Math.max(a.level || 1, b?.level || 1, c?.level || 1)),
      },
    });
  }

  // Always return at least one path.
  if (paths.length === 0 && roleNodes.length > 0) {
    const first = roleNodes[0];
    paths.push({
      id: 'path_1',
      title: `${centerNode.label} → ${first.label}`,
      nodeIds: [centerNode.id, first.id],
      meta: { horizon: _horizonForLevel(first.level || 1) },
    });
  }

  return paths;
}

function _resolveBedrockModelId({ override = null, envKeys = [] } = {}) {
  if (override && String(override).trim()) return String(override).trim();
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && String(val).trim()) return String(val).trim();
  }
  return 'anthropic.claude-3-5-sonnet-20240620-v1:0';
}

function _getBedrockClient() {
  const region =
    process.env.BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AMAZON_REGION ||
    process.env.AWS_SDK_REGION;

  if (!region) {
    const err = new Error(
      'Missing AWS region for BedrockRuntimeClient. Set BEDROCK_REGION, AWS_REGION, or AWS_DEFAULT_REGION.'
    );
    err.code = 'missing_aws_region';
    err.details = { tried: ['BEDROCK_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AMAZON_REGION', 'AWS_SDK_REGION'] };
    throw err;
  }

  const maxAttemptsRaw = Number(process.env.BEDROCK_MAX_ATTEMPTS || 2);
  const maxAttempts =
    Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.max(1, Math.min(5, maxAttemptsRaw)) : 2;

  return new BedrockRuntimeClient({ region, maxAttempts });
}

function _extractClaudeText(bedrockJson) {
  const content = bedrockJson?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (texts.length > 0) return texts.join('\n').trim();
  }
  if (typeof bedrockJson?.outputText === 'string') return bedrockJson.outputText.trim();
  return '';
}

function _extractFirstJsonArray(text) {
  if (!text) return null;
  let trimmed = String(text).trim();

  // Remove fenced blocks if present
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) trimmed = fenced[1].trim();

  // Remove common Claude wrappers
  trimmed = trimmed.replace(/<\/?(thinking|analysis|answer|final|output|response)\b[^>]*>/gi, '').trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;

  // Balanced scan respecting strings
  const starts = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === '[') starts.push(i);
  if (starts.length === 0) return null;

  const extractFrom = (start) => {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '[') depth += 1;
      if (ch === ']') depth -= 1;

      if (depth === 0 && i > start) {
        const candidate = trimmed.slice(start, i + 1).trim();
        return candidate.startsWith('[') && candidate.endsWith(']') ? candidate : null;
      }
    }

    return null;
  };

  for (const s of starts) {
    const c = extractFrom(s);
    if (c) return c;
  }
  return null;
}

function _extractPersonaSkillProficiencies(finalPersonaObj) {
  /**
   * Extract proficiency-bearing skills from a Final Persona (best-effort).
   * Returns: [{ name, proficiency }]
   */
  const p = finalPersonaObj && typeof finalPersonaObj === 'object' && !Array.isArray(finalPersonaObj) ? finalPersonaObj : {};

  const candidates = [
    p.skills_with_proficiency,
    p.skillsWithProficiency,
    p.user_skills,
    p.userSkills,
    p.skillProficiencies,
    p.proficiencies,
    // sometimes "skills" are objects with proficiency
    p.skills,
  ];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || !arr.length) continue;

    const out = [];
    for (const row of arr) {
      if (!row) continue;
      if (typeof row === 'string') continue;
      if (typeof row !== 'object' || Array.isArray(row)) continue;

      const name = _normalizeLabel(row.name || row.skill || row.skill_name || row.skillName || row.label || row.title || '');
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

function _extractPersonaContextForPrompt(finalPersonaObj) {
  /**
   * Build a small, stable persona context to personalize Claude output.
   * Keep it compact to avoid token blow-ups.
   */
  const p = finalPersonaObj && typeof finalPersonaObj === 'object' && !Array.isArray(finalPersonaObj) ? finalPersonaObj : {};

  const industry =
    _normalizeLabel(p.industry || p.profile?.industry || p.domain || p.profile?.domain || '') || 'N/A';

  const seniority =
    _normalizeLabel(p.seniority_level || p.seniorityLevel || p.seniority || p.profile?.seniority || '') || 'N/A';

  const headline =
    _normalizeLabel(p.profile?.headline || p.current_role || p.currentRole || p.title || p.professional_title || '') ||
    'N/A';

  const validatedSkillsRaw = p.validated_skills || p.validatedSkills || p.skills || [];
  const validatedSkills = _safeArray(validatedSkillsRaw)
    .map((s) => (typeof s === 'string' ? _normalizeLabel(s) : _normalizeLabel(s?.name || s?.skill || s?.label || '')))
    .filter(Boolean)
    .slice(0, 28);

  const profs = _extractPersonaSkillProficiencies(p).slice(0, 18);
  const profInline = profs.length ? profs.map((s) => `${s.name}:${s.proficiency}%`).join(', ') : 'N/A';

  return {
    industry,
    seniority,
    headline,
    validatedSkills,
    profInline,
  };
}

async function _loadFinalPersonaObjSafe(personaId) {
  /**
   * Best-effort final persona load:
   * - final -> latest version -> draft
   * Returns {} if not found / invalid.
   */
  const pid = String(personaId || '').trim();
  if (!pid) return {};

  const coerce = (value) => {
    if (!value) return null;
    let v = value;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch (_) {
        return null;
      }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v.finalJson || v.personaJson || v.final || v.persona || v.draftJson || v.draft || v;
  };

  try {
    const finalWrap = await personasRepo.getFinal(pid);
    const finalObj = coerce(finalWrap?.finalJson || finalWrap);
    if (finalObj) return finalObj;
  } catch (_) {
    // ignore
  }

  try {
    const latest = await personasRepo.getLatestPersonaVersion(pid);
    const latestObj = coerce(latest?.personaJson || latest);
    if (latestObj) return latestObj;
  } catch (_) {
    // ignore
  }

  try {
    const draftWrap = await personasRepo.getDraft(pid);
    const draftObj = coerce(draftWrap?.draftJson || draftWrap);
    if (draftObj) return draftObj;
  } catch (_) {
    // ignore
  }

  return {};
}

function _buildMultiversePathRolesPrompt({
  pathType,
  currentRoleTitle,
  pathRoleTitles,
  targetRoleTitle,
  personaContext,
}) {
  const pt = String(pathType || '').trim() || 'lateral';
  const allowed = new Set(['lateral', 'vertical', 'pivot', 'non_linear']);
  const normalizedPathType = allowed.has(pt) ? pt : 'lateral';

  const pathInline = Array.isArray(pathRoleTitles) && pathRoleTitles.length ? pathRoleTitles.join(' → ') : 'N/A';

  const definitionByType = {
    lateral:
      'LATERAL = same seniority band; similar compensation band; leverage existing core skills; change domain or function is allowed ONLY if skill overlap stays high and seniority does NOT jump.',
    vertical:
      'VERTICAL = upward progression in the same function/track; increased scope, leadership or complexity; higher seniority; NOT a domain change. Titles should reflect clear leveling up.',
    pivot:
      'PIVOT = intentional shift to a different function/track; requires meaningful reskilling; still plausible based on persona strengths. Avoid pure lateral/vertical variants.',
    non_linear:
      'NON_LINEAR = unconventional path: cross-functional, portfolio career, or role hybridization; can include sideways + up/down moves; emphasize optionality and experimentation while staying realistic.',
  };

  const hardConstraintsByType = {
    lateral: [
      'ONLY recommend roles that are lateral moves: similar seniority to current.',
      'Do NOT recommend clear promotions (e.g., Lead/Manager/Head) unless current role already implies that seniority.',
      'Do NOT recommend far pivots that require large reskilling.',
    ],
    vertical: [
      'ONLY recommend roles that are vertical moves: higher seniority/scope than current.',
      'Do NOT recommend lateral titles at the same level.',
      'Stay in the same function/track as implied by the current role + path.',
    ],
    pivot: [
      'ONLY recommend roles that are pivots into a different function/track.',
      'Do NOT recommend simple lateral variants of the current function.',
      'Each role must explicitly reflect the new track (e.g., Engineering -> Product, Sales -> Customer Success, etc.).',
    ],
    non_linear: [
      'ONLY recommend non-linear roles: hybrid/cross-functional/portfolio-style options that create optionality.',
      'Do NOT return standard linear ladder steps only.',
      'Keep it realistic and employable (avoid gimmicks).',
    ],
  };

  const constraints = hardConstraintsByType[normalizedPathType] || hardConstraintsByType.lateral;
  const definition = definitionByType[normalizedPathType] || definitionByType.lateral;

  const ctx = personaContext && typeof personaContext === 'object' ? personaContext : {};
  const validatedSkillsInline = Array.isArray(ctx.validatedSkills) && ctx.validatedSkills.length ? ctx.validatedSkills.join(', ') : 'N/A';

  return [
    'You are an expert career mobility strategist for the US job market.',
    'You must return role cards that are detailed enough for a frontend drill-down UI.',
    '',
    'ABSOLUTE OUTPUT RULES (JSON-ONLY; ZERO EXTRA TEXT):',
    '1) Output MUST be valid JSON (RFC 8259).',
    '2) Output MUST be a single JSON array (not an object).',
    '3) Output MUST contain NO markdown, NO code fences, NO commentary, NO headings.',
    '4) Output MUST contain EXACTLY 5 elements.',
    '',
    'MULTIVERSE PATH TYPE (AUTHORITATIVE):',
    `- pathType: "${normalizedPathType}"`,
    `- definition: ${definition}`,
    '',
    'HARD CONSTRAINTS (MUST OBEY):',
    ...constraints.map((c) => `- ${c}`),
    '',
    'PERSONA CONTEXT (AUTHORITATIVE):',
    `- headline/current role signal: "${_normalizeLabel(ctx.headline || 'N/A')}"`,
    `- industry: "${_normalizeLabel(ctx.industry || 'N/A')}"`,
    `- seniority: "${_normalizeLabel(ctx.seniority || 'N/A')}"`,
    `- validated skills: [${validatedSkillsInline}]`,
    `- skill proficiencies (name:percent): [${_normalizeLabel(ctx.profInline || 'N/A')}]`,
    '',
    'PATH CONTEXT:',
    `- currentRoleTitle: "${_normalizeLabel(currentRoleTitle || 'Current Role')}"`,
    `- selectedPath: "${_normalizeLabel(pathInline)}"`,
    `- targetRoleTitle (last step): "${_normalizeLabel(targetRoleTitle || 'Target Role')}"`,
    '',
    'TASK:',
    `Recommend EXACTLY 5 US-market roles that STRICTLY match the pathType="${normalizedPathType}" AND fit the PERSONA CONTEXT.`,
    '',
    'SCHEMA (MUST MATCH EXACTLY):',
    'Return a JSON array of 5 objects. EACH object MUST have ALL of these keys:',
    '- "role_id": string (stable id; MUST start with "bedrock-rec-")',
    '- "role_title": string (non-empty; unique across all 5 roles)',
    '- "industry": string (non-empty)',
    '- "salary_range": string (USD only; include "$"; realistic; e.g., "$120k–$180k")',
    '- "experience_range": string (e.g., "3–5 years")',
    '- "description": string (2–3 sentences; role-specific; no bullet lists)',
    '- "key_responsibilities": string[] (EXACTLY 3 items; 8–20 words each)',
    '- "required_skills": string[] (6–8 UNIQUE items; concrete skills; mix technical + soft)',
    '- "pathType": string (MUST equal the given pathType exactly)',
    '- "whyThisMatchesPathType": string (1–2 sentences; explicitly justify why it matches the chosen pathType)',
    '- "confidence": number (0–100 integer)',
    '',
    'VALIDATION CHECKLIST (DO THIS BEFORE YOU OUTPUT):',
    '- Count check: array length is exactly 5.',
    '- Every item has pathType exactly equal to the given pathType.',
    '- Titles are unique (case-insensitive).',
    '- key_responsibilities length is exactly 3 for every item.',
    '- required_skills length is 6–8 for every item and contains no duplicates.',
    '- salary_range contains "$" for every item.',
    '',
    'OUTPUT:',
    'Return ONLY the JSON array.',
  ].join('\n');
}

function _normalizeMultiverseRecommendedRole(raw, { pathType, idx }) {
  const title = _normalizeLabel(raw?.role_title || raw?.title || raw?.roleTitle || '');
  if (!title) return null;

  const normalizedPathType = ['lateral', 'vertical', 'pivot', 'non_linear'].includes(String(pathType)) ? String(pathType) : 'lateral';
  const slug = _slugify(title) || `role-${idx + 1}`;

  const roleIdRaw = _normalizeLabel(raw?.role_id || raw?.roleId || '');
  const roleId = roleIdRaw && roleIdRaw.startsWith('bedrock-rec-') ? roleIdRaw : `bedrock-rec-${slug}`;

  const industry = _normalizeLabel(raw?.industry || '') || 'Technology';
  const salaryRange = _normalizeLabel(raw?.salary_range || raw?.salaryRange || '') || '$120k–$180k';
  const experienceRange = _normalizeLabel(raw?.experience_range || raw?.experienceRange || '') || '3–6 years';

  const description = _normalizeLabel(raw?.description || '') || `Role aligned to ${normalizedPathType} constraints for this persona.`;

  const keyResponsibilities = _safeArray(raw?.key_responsibilities || raw?.keyResponsibilities)
    .map((s) => _normalizeLabel(typeof s === 'string' ? s : s?.text || s?.label || ''))
    .filter(Boolean)
    .slice(0, 3);

  const requiredSkills = _safeArray(raw?.required_skills || raw?.requiredSkills || raw?.skills_required || raw?.skillsRequired)
    .map((s) => _normalizeLabel(typeof s === 'string' ? s : s?.name || s?.skill || s?.label || ''))
    .filter(Boolean);

  // Enforce constraints: exactly 3 responsibilities, 6–8 required skills, unique skills.
  const resp = keyResponsibilities.length === 3 ? keyResponsibilities : [...keyResponsibilities, 'Deliver measurable outcomes through cross-functional collaboration', 'Own end-to-end execution and quality across stakeholders', 'Use data to prioritize improvements and manage tradeoffs'].slice(0, 3);

  const dedupSkills = [];
  const seen = new Set();
  for (const s of requiredSkills) {
    const k = s.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    dedupSkills.push(s);
  }
  const skills = (dedupSkills.length >= 6 ? dedupSkills : [...dedupSkills, 'Communication', 'Problem Solving', 'Stakeholder Management', 'Collaboration', 'Ownership', 'Technical Writing'])
    .slice(0, 8);

  const why = _normalizeLabel(raw?.whyThisMatchesPathType || raw?.why || raw?.rationale || '') || `This role fits the ${normalizedPathType} constraints for a realistic next move.`;

  const confRaw = Number(raw?.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(100, Math.round(confRaw))) : Math.max(25, 65 - idx * 4);

  return {
    role_id: roleId,
    role_title: title,
    industry,
    salary_range: salaryRange,
    experience_range: experienceRange,
    description,
    key_responsibilities: resp,
    required_skills: skills,
    // Back-compat aliases used by some UIs
    skills_required: skills,
    pathType: normalizedPathType,
    whyThisMatchesPathType: why,
    confidence,
  };
}

async function _generatePathTypeConstrainedRoleRecsSafe({
  pathType,
  currentRoleTitle,
  pathRoleTitles,
  targetRoleTitle,
  finalPersonaObj,
  timeBudgetMs,
  skipBedrock = false,
} = {}) {
  const deterministic = () => {
    const normalizedPathType = ['lateral', 'vertical', 'pivot', 'non_linear'].includes(String(pathType)) ? String(pathType) : 'lateral';
    const base =
      normalizedPathType === 'vertical'
        ? ['Senior', 'Lead', 'Staff', 'Principal', 'Manager']
        : normalizedPathType === 'pivot'
          ? ['Associate', 'Specialist', 'Analyst', 'Strategist', 'Consultant']
          : normalizedPathType === 'non_linear'
            ? ['Hybrid', 'Cross-Functional', 'Portfolio', 'Generalist', 'Builder']
            : ['Lateral', 'Adjacent', 'Peer', 'Parallel', 'Sideways'];

    return base.slice(0, 5).map((t, idx) => {
      const roleTitle = `${t} Role Option ${idx + 1}`;
      return _normalizeMultiverseRecommendedRole(
        {
          role_id: `bedrock-rec-${normalizedPathType}-${idx + 1}`,
          role_title: roleTitle,
          industry: 'Technology',
          salary_range: '$120k–$180k',
          experience_range: '3–6 years',
          description: 'Fallback recommendation due to Bedrock unavailability.',
          key_responsibilities: [
            'Deliver scoped outcomes aligned to business goals and constraints',
            'Collaborate with stakeholders to define requirements and success metrics',
            'Improve quality through iteration, measurement, and clear communication',
          ],
          required_skills: ['Communication', 'Problem Solving', 'Collaboration', 'Ownership', 'Technical Skills', 'Stakeholder Management'],
          pathType: normalizedPathType,
          whyThisMatchesPathType: 'Fallback recommendation due to Bedrock unavailability.',
          confidence: Math.max(10, 55 - idx * 4),
        },
        { pathType: normalizedPathType, idx }
      );
    });
  };

  // If we're explicitly asked to skip Bedrock (or we have essentially no time), return deterministic output immediately.
  const budget = Number(timeBudgetMs);
  if (skipBedrock === true || (Number.isFinite(budget) && budget > 0 && budget < 250)) {
    return deterministic();
  }

  try {
    const modelId = _resolveBedrockModelId({
      override: null,
      envKeys: ['BEDROCK_MULTIVERSE_MODEL_ID', 'BEDROCK_RECOMMENDATIONS_MODEL_ID', 'BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID'],
    });

    const personaContext = _extractPersonaContextForPrompt(finalPersonaObj);

    const prompt = _buildMultiversePathRolesPrompt({
      pathType,
      currentRoleTitle,
      pathRoleTitles,
      targetRoleTitle,
      personaContext,
    });

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1400,
      temperature: 0.25,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };

    const client = _getBedrockClient();
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify(body)),
    });

    // Enforce a strict timeout so the endpoint doesn't exceed proxy budgets and cause empty UI.
    const timeoutMsRaw = Number(process.env.MULTIVERSE_RECS_BEDROCK_TIMEOUT_MS || 1600);
    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.max(350, Math.min(8000, timeoutMsRaw))
        : 1600;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let resp;
    try {
      // AWS SDK v3 supports abortSignal via request handler options.
      resp = await client.send(cmd, { abortSignal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    const jsonStr = Buffer.from(resp.body).toString('utf-8');
    const bedrockJson = JSON.parse(jsonStr);

    const rawText = _extractClaudeText(bedrockJson);
    const arrText = _extractFirstJsonArray(rawText);
    if (!arrText) throw new Error('No JSON array found in Bedrock output.');

    const parsed = JSON.parse(arrText);
    if (!Array.isArray(parsed)) throw new Error('Parsed Bedrock output is not an array.');

    const normalizedPathType = ['lateral', 'vertical', 'pivot', 'non_linear'].includes(String(pathType)) ? String(pathType) : 'lateral';

    const out = [];
    const seenTitle = new Set();

    for (let i = 0; i < parsed.length; i += 1) {
      const norm = _normalizeMultiverseRecommendedRole(parsed[i], { pathType: normalizedPathType, idx: i });
      if (!norm) continue;

      const key = norm.role_title.toLowerCase();
      if (seenTitle.has(key)) continue;
      seenTitle.add(key);

      out.push({
        ...norm,
        meta: { bedrockUsed: true, fallback: false },
      });

      if (out.length >= 5) break;
    }

    if (out.length === 5) return out;

    // pad deterministically
    const pad = deterministic();
    const combined = [...out];
    for (const r of pad) {
      if (combined.length >= 5) break;
      if (!r) continue;
      const key = String(r.role_title || '').toLowerCase();
      if (seenTitle.has(key)) continue;
      seenTitle.add(key);
      combined.push({ ...r, pathType: normalizedPathType });
    }

    return combined.slice(0, 5);
  } catch (_) {
    return deterministic();
  }
}

function _scoreRecommendedRoles({ finalPersonaObj, roles }) {
  /**
   * Compute compatibility scores + threeTwoReport for each recommended role card.
   * If persona proficiencies are missing, we still return deterministic compatibilityScore=0.
   */
  const skillsWithProf = _extractPersonaSkillProficiencies(finalPersonaObj);
  const hasProfs = Array.isArray(skillsWithProf) && skillsWithProf.length > 0;

  return (Array.isArray(roles) ? roles : []).map((r) => {
    const requiredSkills = Array.isArray(r?.required_skills) ? r.required_skills : Array.isArray(r?.skills_required) ? r.skills_required : [];
    if (!hasProfs) {
      return {
        ...r,
        compatibilityScore: 0,
        finalCompatibilityScore: 0,
        threeTwoReport: { status: 'not_validated', masteryAreas: [], growthAreas: [], score: 0 },
        masteryAreas: [],
        growthAreas: [],
        match_metadata: {
          ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
          scoring: { hadUserProficiencies: false, requiredSkillsCount: requiredSkills.length },
        },
      };
    }

    const threeTwo = buildThreeTwoReport(skillsWithProf, requiredSkills);
    const compat = scoreRoleCompatibility(skillsWithProf, requiredSkills);

    const validationScore = threeTwo?.status === 'validated' ? 100 : 0;
    const finalCompatibilityScore = Math.max(0, Math.min(100, Math.round(0.6 * (compat?.score || 0) + 0.4 * validationScore)));

    return {
      ...r,
      compatibilityScore: compat?.score ?? 0,
      finalCompatibilityScore,
      threeTwoReport: threeTwo,
      masteryAreas: compat?.masteryAreas ?? [],
      growthAreas: compat?.growthAreas ?? [],
      match_metadata: {
        ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
        scoring: { hadUserProficiencies: true, requiredSkillsCount: requiredSkills.length, threeTwoStatus: threeTwo?.status || null },
      },
    };
  });
}

function _resolveLegacyPathId(graph, pathId) {
  /**
   * Legacy hardening:
   * Some clients mistakenly call /api/multiverse/paths/:id using a role title like
   * "Backend Engineer (Node.js)" instead of the backend-defined path ids ("path_1").
   *
   * We try to resolve:
   * 1) exact path.id match
   * 2) exact path.title match (case-insensitive)
   * 3) contains a node whose label/title matches pathId (case-insensitive)
   */
  const pid = _normalizeLabel(pathId);
  if (!pid) return null;

  const paths = _safeArray(graph?.paths);
  const nodes = _safeArray(graph?.nodes);

  const nodesById = new Map();
  for (const n of nodes) nodesById.set(String(n?.id), n);

  const byId = paths.find((p) => String(p?.id) === pid);
  if (byId) return byId;

  const lower = pid.toLowerCase();
  const byTitle = paths.find((p) => _normalizeLabel(p?.title).toLowerCase() === lower);
  if (byTitle) return byTitle;

  for (const p of paths) {
    const nodeIds = _safeArray(p?.nodeIds);
    for (const nid of nodeIds) {
      const n = nodesById.get(String(nid));
      const label = _normalizeLabel(n?.data?.title || n?.label || '');
      if (label && label.toLowerCase() === lower) return p;
    }
  }

  return null;
}

async function _buildPathDetailsSafe({ personaId, graph, path, centerNode, pathType, finalPersonaObj, timeBudgetMs, skipBedrock }) {
  const nodesById = {};
  for (const n of graph.nodes) nodesById[n.id] = n;

  const pathRoleTitlesAll = _safeArray(path?.nodeIds)
    .map((id) => nodesById[id]?.data?.title || nodesById[id]?.label)
    .filter(Boolean)
    .slice(0, 8);

  const steps = pathRoleTitlesAll.slice(1); // exclude current node
  const targetTitle = steps[steps.length - 1] || 'Target Role';

  const recommendedRolesRaw = await _generatePathTypeConstrainedRoleRecsSafe({
    pathType,
    currentRoleTitle: centerNode?.label,
    pathRoleTitles: steps,
    targetRoleTitle: targetTitle,
    finalPersonaObj,
    timeBudgetMs,
    skipBedrock,
  });

  const scoredRecommendedRoles = _scoreRecommendedRoles({ finalPersonaObj, roles: recommendedRolesRaw }).map((r) => ({
    ...r,
    match_metadata: {
      ...(r.match_metadata && typeof r.match_metadata === 'object' ? r.match_metadata : {}),
      source: 'multiverse_path_recs',
      personaId: personaId || null,
      pathType: String(pathType || 'lateral'),
      bedrockUsed: Boolean(r?.meta?.bedrockUsed),
      fallback: Boolean(r?.meta?.fallback),
    },
  }));

  const deterministicEffort =
    path?.meta?.horizon === 'Far' ? '18–36 months' : path?.meta?.horizon === 'Mid' ? '9–18 months' : '3–9 months';

  const targetNodeId = path?.nodeIds?.[path.nodeIds.length - 1];
  const gapSkills =
    _detailsForNode(nodesById[targetNodeId] || {}, centerNode)?.skillGap?.missingSkills || [];

  return {
    pathId: path.id,
    title: path.title || null,
    steps,
    nodeIds: path.nodeIds,
    pathType: String(pathType || 'lateral'),
    targetRoleTitle: targetTitle,
    effortEstimate: {
      level: path?.meta?.horizon || 'Near',
      timeline: deterministicEffort,
    },
    gaps: {
      missingSkills: gapSkills,
      suggestedProjects: [`Build a portfolio project aligned to ${targetTitle}`, 'Ship a measurable improvement in your current role'],
    },
    resources: {
      learning: ['Official documentation', 'Role-specific roadmap', 'Hands-on labs'],
      certification: ['Optional: role-relevant certification (if applicable)'],
    },
    recommendedRoles: scoredRecommendedRoles,
    meta: {
      bedrockUsed: scoredRecommendedRoles.some((r) => r?.match_metadata?.bedrockUsed === true),
      fallback: scoredRecommendedRoles.every((r) => r?.meta?.fallback === true),
    },
  };
}

// PUBLIC_INTERFACE
export async function buildMultiverseGraph({
  personaId,
  currentRoleTitle = 'Current Role',
  filters = {},
  limit = 18,
  timeBudgetMs = undefined,
} = {}) {
  /**
   * Build the Multiverse Explorer graph.
   *
   * Inputs:
   * - personaId (required for personalized pool; if missing, graph is still returned using empty pool)
   * - filters: { minSalaryUsdK, maxSalaryUsdK, minSalaryLpa, maxSalaryLpa, minSkillSimilarity, timeHorizon }
   *
   * Output:
   * { meta, nodes, edges, detailsByNodeId, paths }
   */
  const centerNode = _defaultCenterNode({ currentRoleTitle });

  // If we're operating under an extremely tight time budget, skip pool generation entirely.
  // This is used by safe-fallback flows to guarantee a fast response.
  const tb = Number(timeBudgetMs);
  const pool =
    personaId && !(Number.isFinite(tb) && tb > 0 && tb < 250)
      ? await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
          personaId: String(personaId).trim(),
          finalPersonaOverride: null,
          options: { storeCount: 12, timeBudgetMs },
        })
      : { roles: [], meta: { cacheHit: false, personaId: personaId || null, fallback: true, reason: 'time_budget_too_small_or_missing' } };

  const roles = _safeArray(pool?.roles);

  const candidates = roles
    .map((r) => _roleToNode(r, { level: 1, isCenter: false }))
    .filter((n) => n?.id && n?.label);

  // Apply filters.
  const filtered = _applyFiltersToNodes([centerNode, ...candidates], {
    minSalaryUsdK: filters?.minSalaryUsdK,
    maxSalaryUsdK: filters?.maxSalaryUsdK,
    minSalaryLpa: filters?.minSalaryLpa,
    maxSalaryLpa: filters?.maxSalaryLpa,
    minSkillSimilarity: filters?.minSkillSimilarity,
  }).filter((n) => n.type !== 'current_role');

  // Sort by similarity desc, then title.
  filtered.sort((a, b) => {
    const sa = Number.isFinite(a?.data?.skillSimilarity) ? a.data.skillSimilarity : 0;
    const sb = Number.isFinite(b?.data?.skillSimilarity) ? b.data.skillSimilarity : 0;
    if (sb !== sa) return sb - sa;
    return _normalizeLabel(a?.label).localeCompare(_normalizeLabel(b?.label));
  });

  const maxNodes = Math.max(3, Math.min(100, Number(limit) || 18));
  const selected = filtered.slice(0, Math.max(0, maxNodes - 1));

  // Assign levels (fan-out).
  const level1Count = Math.min(10, Math.max(4, Math.floor((maxNodes - 1) * 0.55)));
  const level2Count = Math.min(6, Math.max(2, Math.floor((maxNodes - 1) * 0.3)));
  const level3Count = Math.min(4, Math.max(1, Math.floor((maxNodes - 1) * 0.15)));

  const L1 = selected.slice(0, level1Count).map((n) => ({ ...n, level: 1 }));
  const rest = selected.slice(level1Count);

  const L2 = rest.slice(0, level2Count).map((n) => ({ ...n, level: 2 }));
  const rest2 = rest.slice(level2Count);

  const L3 = rest2.slice(0, level3Count).map((n) => ({ ...n, level: 3 }));

  const nodesAll = [centerNode, ...L1, ...L2, ...L3];

  // Build edges with optional horizon filter.
  const timeHorizon =
    filters?.timeHorizon && ['Near', 'Mid', 'Far'].includes(String(filters.timeHorizon)) ? String(filters.timeHorizon) : null;

  const edges = [];
  const includeH = (h) => !timeHorizon || timeHorizon === h;

  for (const n of L1) {
    const h = _horizonForLevel(1);
    if (!includeH(h)) continue;
    edges.push(_buildEdge({ from: centerNode.id, to: n.id, label: h, timeHorizon: h }));
  }

  for (let i = 0; i < L2.length; i += 1) {
    const parent = L1.length ? L1[i % L1.length].id : centerNode.id;
    const h = _horizonForLevel(2);
    if (!includeH(h)) continue;
    edges.push(_buildEdge({ from: parent, to: L2[i].id, label: h, timeHorizon: h }));
  }

  for (let i = 0; i < L3.length; i += 1) {
    const parent = L2.length ? L2[i % L2.length].id : L1.length ? L1[i % L1.length].id : centerNode.id;
    const h = _horizonForLevel(3);
    if (!includeH(h)) continue;
    edges.push(_buildEdge({ from: parent, to: L3[i].id, label: h, timeHorizon: h }));
  }

  // If horizon filter applied, remove unconnected nodes.
  const connected = new Set([centerNode.id]);
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  const nodes = timeHorizon ? nodesAll.filter((n) => connected.has(n.id)) : nodesAll;

  const detailsByNodeId = {};
  for (const n of nodes) {
    detailsByNodeId[n.id] = _detailsForNode(n, centerNode);
  }

  const paths = _buildDeterministicPathsFromNodes({ centerNode, nodes });

  return {
    meta: {
      personaId: personaId || null,
      center: { id: centerNode.id, label: centerNode.label },
      filtersApplied: {
        minSalaryUsdK: (filters?.minSalaryUsdK ?? filters?.minSalaryLpa) ?? null,
        maxSalaryUsdK: (filters?.maxSalaryUsdK ?? filters?.maxSalaryLpa) ?? null,
        minSkillSimilarity: filters?.minSkillSimilarity ?? null,
        timeHorizon: timeHorizon ?? null,
        limit: maxNodes,
      },
      poolMeta: pool?.meta || {},
    },
    nodes,
    edges,
    detailsByNodeId,
    paths,
  };
}

// PUBLIC_INTERFACE
export async function getNodeDetails({ personaId, nodeId, currentRoleTitle = 'Current Role' } = {}) {
  /** Return a node details payload compatible with MindMapNodeDetails. */
  const graph = await buildMultiverseGraph({ personaId, currentRoleTitle, limit: 25, filters: {} });
  const node = graph.nodes.find((n) => String(n.id) === String(nodeId));
  if (!node) return null;
  return graph.detailsByNodeId[String(nodeId)] || null;
}

// PUBLIC_INTERFACE
export async function getPathDetails({
  personaId,
  pathId,
  currentRoleTitle = 'Current Role',
  filters = {},
  pathType = 'lateral',
  timeBudgetMs = undefined,
  skipBedrock = false,
} = {}) {
  /**
   * Return a "path details" object:
   * - steps
   * - gaps (skills + projects)
   * - resources
   * - effortEstimate
   * - recommendedRoles (persona-personalized AND pathType-constrained)
   *
   * Reliability:
   * - `timeBudgetMs` is forwarded to upstream pool generation.
   * - `skipBedrock=true` forces deterministic recommendedRoles (used for safe fallback on timeouts).
   */
  const graph = await buildMultiverseGraph({ personaId, currentRoleTitle, limit: 25, filters, timeBudgetMs });
  const centerNode = graph.nodes.find((n) => n.type === 'current_role') || _defaultCenterNode({ currentRoleTitle });

  const resolvedPath = _resolveLegacyPathId(graph, pathId);
  if (!resolvedPath) return null;

  const finalPersonaObj = personaId ? await _loadFinalPersonaObjSafe(personaId) : {};

  return _buildPathDetailsSafe({
    personaId,
    graph,
    path: resolvedPath,
    centerNode,
    pathType,
    finalPersonaObj,
    timeBudgetMs,
    skipBedrock,
  });
}

export default { buildMultiverseGraph, getNodeDetails, getPathDetails };

