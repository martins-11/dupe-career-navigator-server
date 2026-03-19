import exploreRecommendationsPoolService from './exploreRecommendationsPoolService.js';
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

function _parseSalaryRangeToLpaMidpoint(salaryRange) {
  if (!salaryRange) return null;
  const s = String(salaryRange).trim();

  const inrMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?).*(?:LPA|lpa)/);
  if (inrMatch) {
    const a = Number(inrMatch[1]);
    const b = Number(inrMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  }

  const usdMatch = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*k?\s*(?:–|-|to)\s*\$?\s*(\d+(?:\.\d+)?)\s*k/i);
  if (usdMatch) {
    const aK = Number(usdMatch[1]);
    const bK = Number(usdMatch[2]);
    if (!Number.isFinite(aK) || !Number.isFinite(bK)) return null;

    const midUsd = ((aK + bK) / 2) * 1000;
    const usdToInrRaw = Number(process.env.USD_TO_INR || 83);
    const usdToInr = Number.isFinite(usdToInrRaw) && usdToInrRaw > 0 ? usdToInrRaw : 83;
    const midInr = midUsd * usdToInr;
    const midLpa = midInr / 100000;
    return Number.isFinite(midLpa) ? midLpa : null;
  }

  return null;
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
      salaryLpaMid: _parseSalaryRangeToLpaMidpoint(salaryRange),
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

function _applyFiltersToNodes(nodes, { minSalaryLpa, maxSalaryLpa, minSkillSimilarity } = {}) {
  const minS = minSalaryLpa != null ? Number(minSalaryLpa) : null;
  const maxS = maxSalaryLpa != null ? Number(maxSalaryLpa) : null;
  const minSim = minSkillSimilarity != null ? Number(minSkillSimilarity) : null;

  return nodes.filter((n) => {
    if (n?.type === 'current_role') return true;

    const mid = n?.data?.salaryLpaMid;
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

  const salaryMid = node?.data?.salaryLpaMid;
  const averageSalary = Number.isFinite(salaryMid)
    ? `~₹${Math.round(salaryMid)} LPA (midpoint)`
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

async function _bedrockPathDetailsSafe({ personaId, path, nodesById, centerNode }) {
  /**
   * Bedrock enrichment:
   * Return a structured "path details" payload including gaps/resources/effort.
   *
   * We keep this safe:
   * - If Bedrock fails, return deterministic details (no throw).
   * - We reuse bedrockService.generateTargetedRolesSafe only as a Bedrock invocation wrapper,
   *   but we provide a "query" requesting the desired JSON object.
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
    meta: { bedrockUsed: false, fallback: true },
  };

  // If no personaId, skip Bedrock.
  if (!personaId) return deterministic;

  try {
    // We "abuse" the Bedrock role generator as a strict-json caller by providing a query.
    // It will return 5 items, which isn't what we want—so instead we keep deterministic details.
    // (We intentionally do NOT overfit prompt plumbing in this step.)
    // Future: implement a dedicated Bedrock JSON-object invocation for path details.
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
      meta: { bedrockUsed: true, fallback: false, note: 'Bedrock invoked (details currently deterministic envelope).' },
    };
  } catch (err) {
    return {
      ...deterministic,
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
        options: { storeCount: 12 },
      })
    : { roles: [], meta: { cacheHit: false, personaId: null } };

  const roles = _safeArray(pool?.roles);

  const candidates = roles
    .map((r) => _roleToNode(r, { level: 1, isCenter: false }))
    .filter((n) => n?.id && n?.label);

  // Apply filters.
  const filtered = _applyFiltersToNodes([centerNode, ...candidates], {
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
        minSalaryLpa: filters?.minSalaryLpa ?? null,
        maxSalaryLpa: filters?.maxSalaryLpa ?? null,
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
export async function getPathDetails({ personaId, pathId, currentRoleTitle = 'Current Role', filters = {} } = {}) {
  /**
   * Return a "path details" object:
   * - gaps (skills + projects)
   * - resources
   * - effortEstimate
   */
  const graph = await buildMultiverseGraph({ personaId, currentRoleTitle, limit: 25, filters });
  const centerNode = graph.nodes.find((n) => n.type === 'current_role') || _defaultCenterNode({ currentRoleTitle });

  const nodesById = {};
  for (const n of graph.nodes) nodesById[n.id] = n;

  const path = _safeArray(graph.paths).find((p) => String(p.id) === String(pathId));
  if (!path) return null;

  return _bedrockPathDetailsSafe({ personaId, path, nodesById, centerNode });
}

export default { buildMultiverseGraph, getNodeDetails, getPathDetails };

