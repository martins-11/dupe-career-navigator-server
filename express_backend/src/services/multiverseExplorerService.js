import exploreRecommendationsPoolService from './exploreRecommendationsPoolService.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import bedrockService from './bedrockService.js';

/**
 * Multiverse Explorer service layer.
 *
 * Responsibilities:
 * - Build a "multiverse graph" from the persisted Explore recommendations pool for a persona.
 * - Apply server-side filters (salary, similarity, time horizon) to keep payload bounded.
 * - Provide node details and path details drill-down payloads.
 *
 * NOTE:
 * - This implementation is designed to be robust in DB-optional environments:
 *   - Explore pool service already persists to MySQL or memory via holisticPersonaRepoAdapter.
 * - Bedrock is used to enrich path details when available, but the API always returns
 *   a deterministic fallback details object if Bedrock is unavailable.
 */

function _normalizeLabel(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
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
    return 1; // assume already in k if no suffix and values look like k; caller accepts rough parsing
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

  const byScoreDesc = (a, b) => (Number(b?.data?.skillSimilarity || 0) - Number(a?.data?.skillSimilarity || 0));

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

function _buildMultiversePathRolesPrompt({ pathType, currentRoleTitle, pathRoleTitles, targetRoleTitle }) {
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
      'NON_LINEAR = unconventional path: cross-functional, portfolio career, or role hybridization; can include sideways + up/down moves; emphasize optionality and experimentation while staying realistic.'
  };

  const hardConstraintsByType = {
    lateral: [
      'ONLY recommend roles that are lateral moves: similar seniority to current.',
      'Do NOT recommend clear promotions (e.g., Lead/Manager/Head) unless current role already implies that seniority.',
      'Do NOT recommend far pivots that require large reskilling.'
    ],
    vertical: [
      'ONLY recommend roles that are vertical moves: higher seniority/scope than current.',
      'Do NOT recommend lateral titles at the same level.',
      'Stay in the same function/track as implied by the current role + path.'
    ],
    pivot: [
      'ONLY recommend roles that are pivots into a different function/track.',
      'Do NOT recommend simple lateral variants of the current function.',
      'Each role must explicitly reflect the new track (e.g., Engineering -> Product, Sales -> Customer Success, etc.).'
    ],
    non_linear: [
      'ONLY recommend non-linear roles: hybrid/cross-functional/portfolio-style options that create optionality.',
      'Do NOT return standard linear ladder steps only.',
      'Keep it realistic and employable (avoid gimmicks).'
    ]
  };

  const constraints = hardConstraintsByType[normalizedPathType] || hardConstraintsByType.lateral;
  const definition = definitionByType[normalizedPathType] || definitionByType.lateral;

  return [
    'You are an expert career mobility strategist for the Indian job market.',
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
    'PATH CONTEXT:',
    `- currentRoleTitle: "${_normalizeLabel(currentRoleTitle || 'Current Role')}"`,
    `- selectedPath: "${_normalizeLabel(pathInline)}"`,
    `- targetRoleTitle (last step): "${_normalizeLabel(targetRoleTitle || 'Target Role')}"`,
    '',
    'TASK:',
    `Recommend EXACTLY 5 India-market roles that STRICTLY match the pathType="${normalizedPathType}".`,
    'These are role recommendations for the user to consider next within this multiverse path.',
    '',
    'SCHEMA (MUST MATCH EXACTLY):',
    'Return a JSON array of 5 objects. EACH object MUST have ALL of these keys:',
    '- "role_title": string (non-empty; unique across all 5 roles)',
    '- "pathType": string (MUST equal the given pathType exactly)',
    '- "whyThisMatchesPathType": string (1-2 sentences; explicitly justify why it is lateral/vertical/pivot/non_linear)',
    '- "confidence": number (0-100 integer)',
    '',
    'VALIDATION CHECKLIST (DO THIS BEFORE YOU OUTPUT):',
    '- Count check: array length is exactly 5.',
    '- Every item has pathType exactly equal to the given pathType.',
    '- Titles are unique (case-insensitive).',
    '- All roles obey the HARD CONSTRAINTS for the pathType.',
    '',
    'OUTPUT:',
    'Return ONLY the JSON array.'
  ].join('\n');
}

async function _generatePathTypeConstrainedRoleRecsSafe({
  pathType,
  currentRoleTitle,
  pathRoleTitles,
  targetRoleTitle
} = {}) {
  const deterministic = () => {
    const titles =
      pathType === 'vertical'
        ? ['Senior Role (Progression)', 'Lead Role (Progression)', 'Manager (Progression)', 'Principal (Progression)', 'Head (Progression)']
        : pathType === 'pivot'
          ? ['Pivot Role 1', 'Pivot Role 2', 'Pivot Role 3', 'Pivot Role 4', 'Pivot Role 5']
          : pathType === 'non_linear'
            ? ['Hybrid Role 1', 'Hybrid Role 2', 'Hybrid Role 3', 'Hybrid Role 4', 'Hybrid Role 5']
            : ['Lateral Role 1', 'Lateral Role 2', 'Lateral Role 3', 'Lateral Role 4', 'Lateral Role 5'];

    return titles.slice(0, 5).map((t, idx) => ({
      role_title: t,
      pathType: String(pathType || 'lateral'),
      whyThisMatchesPathType: 'Fallback recommendation due to Bedrock unavailability.',
      confidence: Math.max(10, 50 - idx * 3),
      meta: { bedrockUsed: false, fallback: true }
    }));
  };

  try {
    const modelId = _resolveBedrockModelId({
      override: null,
      envKeys: ['BEDROCK_MULTIVERSE_MODEL_ID', 'BEDROCK_RECOMMENDATIONS_MODEL_ID', 'BEDROCK_ROLE_MODEL_ID', 'BEDROCK_MODEL_ID']
    });

    const prompt = _buildMultiversePathRolesPrompt({
      pathType,
      currentRoleTitle,
      pathRoleTitles,
      targetRoleTitle
    });

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 900,
      temperature: 0.2,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    };

    const client = _getBedrockClient();
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify(body))
    });

    const resp = await client.send(cmd);
    const jsonStr = Buffer.from(resp.body).toString('utf-8');
    const bedrockJson = JSON.parse(jsonStr);

    const rawText = _extractClaudeText(bedrockJson);
    const arrText = _extractFirstJsonArray(rawText);
    if (!arrText) throw new Error('No JSON array found in Bedrock output.');

    const parsed = JSON.parse(arrText);
    if (!Array.isArray(parsed)) throw new Error('Parsed Bedrock output is not an array.');

    // Normalize and enforce pathType on the server too (belt-and-suspenders).
    const allowed = new Set(['lateral', 'vertical', 'pivot', 'non_linear']);
    const normalizedPathType = allowed.has(String(pathType)) ? String(pathType) : 'lateral';

    const out = [];
    const seen = new Set();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;

      const title = _normalizeLabel(item.role_title || item.title || item.roleTitle);
      if (!title) continue;

      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const why = _normalizeLabel(item.whyThisMatchesPathType || item.why || item.rationale || '');
      const confidenceRaw = Number(item.confidence);
      const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(100, Math.round(confidenceRaw))) : 50;

      out.push({
        role_title: title,
        pathType: normalizedPathType,
        whyThisMatchesPathType: why || `Recommended because it fits the ${normalizedPathType} path constraints.`,
        confidence,
        meta: { bedrockUsed: true, fallback: false }
      });

      if (out.length >= 5) break;
    }

    if (out.length === 5) return out;

    // If Bedrock returned insufficient valid items, pad with deterministic (still constrained to pathType).
    const padded = deterministic();
    return [...out, ...padded].slice(0, 5).map((r) => ({ ...r, pathType: normalizedPathType }));
  } catch (err) {
    return deterministic();
  }
}

async function _bedrockPathDetailsSafe({ personaId, path, nodesById, centerNode, pathType = 'lateral' }) {
  /**
   * Bedrock enrichment:
   * - Provide deterministic path details (gaps/resources/effort) ALWAYS.
   * - Additionally generate pathType-specific role recommendations, strictly constrained by pathType.
   *
   * Safety:
   * - If Bedrock fails, return deterministic envelope + deterministic recommendedRoles.
   * - Never throw from this function.
   */
  const pathRoleTitles = _safeArray(path?.nodeIds)
    .map((id) => nodesById[id]?.data?.title || nodesById[id]?.label)
    .filter(Boolean)
    .slice(0, 6);

  const targetTitle = pathRoleTitles[pathRoleTitles.length - 1] || 'Target Role';

  const deterministic = {
    pathId: path.id,
    title: path.title || null,
    nodeIds: path.nodeIds,
    pathType: String(pathType || 'lateral'),
    targetRoleTitle: targetTitle,
    effortEstimate: {
      level: path?.meta?.horizon || 'Near',
      timeline: path?.meta?.horizon === 'Far' ? '18–36 months' : path?.meta?.horizon === 'Mid' ? '9–18 months' : '3–9 months',
    },
    gaps: {
      missingSkills: _detailsForNode(nodesById[path.nodeIds[path.nodeIds.length - 1]] || {}, centerNode)?.skillGap?.missingSkills || [],
      suggestedProjects: [
        `Build a portfolio project aligned to ${targetTitle}`,
        'Ship a measurable improvement in your current role',
      ],
    },
    resources: {
      learning: ['Official documentation', 'Role-specific roadmap', 'Hands-on labs'],
      certification: ['Optional: role-relevant certification (if applicable)'],
    },
    recommendedRoles: [],
    meta: { bedrockUsed: false, fallback: true },
  };

  // Recommended roles (pathType constrained). If no personaId, still produce recs (prompt uses titles only).
  const recommendedRoles = await _generatePathTypeConstrainedRoleRecsSafe({
    pathType,
    currentRoleTitle: centerNode?.label,
    pathRoleTitles,
    targetRoleTitle: targetTitle
  });

  // If no personaId, skip any additional Bedrock calls beyond recs (already done) and return.
  if (!personaId) {
    return {
      ...deterministic,
      recommendedRoles,
      meta: { ...deterministic.meta, bedrockUsed: false, fallback: true }
    };
  }

  // Keep prior "invoke Bedrock" behavior minimal: treat as an optional side-effect marker only.
  try {
    await bedrockService.generateTargetedRolesSafe(
      {
        query: `Generate JSON ONLY: Provide gaps/resources/effort for moving from "${centerNode.label}" to "${targetTitle}" via [${pathRoleTitles.join(' -> ')}].`,
        requestType: 'searched',
        finalPersonaObj: {},
        skills: centerNode?.data?.requiredSkills || [],
      },
      { allowFallback: false }
    );

    return {
      ...deterministic,
      recommendedRoles,
      meta: { bedrockUsed: true, fallback: false, note: 'Bedrock invoked (details deterministic; role recs pathType-enforced).' },
    };
  } catch (err) {
    return {
      ...deterministic,
      recommendedRoles,
      meta: {
        bedrockUsed: false,
        fallback: true,
        bedrockError: { code: err?.code || err?.name || 'BEDROCK_FAILED', message: err?.message || String(err) },
      },
    };
  }
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
   * - filters: { minSalaryLpa, maxSalaryLpa, minSkillSimilarity, timeHorizon }
   *
   * Output:
   * { meta, nodes, edges, detailsByNodeId, paths }
   */
  const centerNode = _defaultCenterNode({ currentRoleTitle });

  const pool = personaId
    ? await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
        personaId: String(personaId).trim(),
        finalPersonaOverride: null,
        options: { storeCount: 12, timeBudgetMs },
      })
    : { roles: [], meta: { cacheHit: false, personaId: null } };

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
  const timeHorizon = filters?.timeHorizon && ['Near', 'Mid', 'Far'].includes(String(filters.timeHorizon)) ? String(filters.timeHorizon) : null;
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

  const nodesById = {};
  for (const n of nodes) nodesById[n.id] = n;

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
} = {}) {
  /**
   * Return a "path details" object:
   * - gaps (skills + projects)
   * - resources
   * - effortEstimate
   * - recommendedRoles (pathType-constrained; generated via Bedrock when available)
   */
  const graph = await buildMultiverseGraph({ personaId, currentRoleTitle, limit: 25, filters });
  const centerNode = graph.nodes.find((n) => n.type === 'current_role') || _defaultCenterNode({ currentRoleTitle });

  const nodesById = {};
  for (const n of graph.nodes) nodesById[n.id] = n;

  const path = _safeArray(graph.paths).find((p) => String(p.id) === String(pathId));
  if (!path) return null;

  return _bedrockPathDetailsSafe({ personaId, path, nodesById, centerNode, pathType });
}

export default { buildMultiverseGraph, getNodeDetails, getPathDetails };

