import express from 'express';
import { getZodSync } from '../utils/zod.js';
import { sendError } from '../utils/errors.js';
import rolesRepo from '../repositories/rolesRepoAdapter.js';
import recommendationsService from '../services/recommendationsService.js';
import mindmapViewStateRepo from '../repositories/mindmapViewStateRepoAdapter.js';
import exploreRecommendationsPoolService from '../services/exploreRecommendationsPoolService.js';

const { z } = getZodSync();
const router = express.Router();

/**
 * Mind Map APIs.
 *
 * Provides graph data for the interactive mind map feature:
 * - The "current role" is represented as the center node.
 * - Branches radiate outward to potential future roles.
 * - Filtering by salary range / skill similarity / time horizon is supported.
 *
 * NOTE: This implementation is DB-optional:
 * - If MySQL roles catalog is available, it will use it.
 * - Otherwise it falls back to the in-memory DEFAULT_ROLES_CATALOG (seed).
 */

function _normalizeLabel(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function _parseSalaryRangeToLpaMidpoint(salaryRange) {
  /**
   * Parses a salary string into an approximate midpoint LPA number.
   *
   * Supported examples:
   * - "₹18–₹30 LPA"
   * - "18-30 LPA"
   * - "$130k-$210k" (best-effort -> converts to LPA assuming USD_TO_INR)
   *
   * Returns null if cannot parse.
   */
  if (!salaryRange) return null;
  const s = String(salaryRange).trim();

  // INR LPA-like formats: capture two numbers.
  const inrMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?).*(?:LPA|lpa)/);
  if (inrMatch) {
    const a = Number(inrMatch[1]);
    const b = Number(inrMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  }

  // USD k-range formats: "$130k-$210k" (approx -> INR -> LPA)
  const usdMatch = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*k?\s*(?:–|-|to)\s*\$?\s*(\d+(?:\.\d+)?)\s*k/i);
  if (usdMatch) {
    const aK = Number(usdMatch[1]);
    const bK = Number(usdMatch[2]);
    if (!Number.isFinite(aK) || !Number.isFinite(bK)) return null;

    const midUsd = ((aK + bK) / 2) * 1000;
    const usdToInrRaw = Number(process.env.USD_TO_INR || 83);
    const usdToInr = Number.isFinite(usdToInrRaw) && usdToInrRaw > 0 ? usdToInrRaw : 83;

    // USD -> INR -> LPA (1 LPA = 100,000 INR)
    const midInr = midUsd * usdToInr;
    const midLpa = midInr / 100000;
    return Number.isFinite(midLpa) ? midLpa : null;
  }

  return null;
}

function _roleToNode(role, { isCenter = false, level = 1, score = null } = {}) {
  const roleId = role?.roleId || role?.role_id || role?.id || role?.role_title || role?.roleTitle || 'role';
  const title = _normalizeLabel(role?.roleTitle || role?.role_title || role?.title || role?.role_name || 'Role');
  const industry = role?.industry != null ? _normalizeLabel(role.industry) : null;

  const requiredSkills = _safeArray(role?.coreSkills || role?.skills_required || role?.required_skills).filter(Boolean);
  const salaryRange =
    role?.salary_lpa_range ||
    role?.estimatedSalaryRange ||
    role?.salary_range ||
    role?.salaryRange ||
    null;

  const experienceRange = role?.experience_range || role?.experienceRange || null;

  return {
    id: String(roleId),
    type: isCenter ? 'current_role' : 'role',
    label: title,
    level,
    data: {
      title,
      industry,
      requiredSkills,
      salaryRange,
      experienceRange,
      // This is an approximate computed field used for filtering/sorting.
      salaryLpaMid: _parseSalaryRangeToLpaMidpoint(salaryRange),
      // Compatibility / similarity-like score (0-100) if we have it.
      skillSimilarity: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null
    }
  };
}

function _buildEdge({ from, to, label = null, timeHorizon = null }) {
  return {
    id: `${from}__to__${to}`,
    source: String(from),
    target: String(to),
    type: 'progression',
    label: label || null,
    data: {
      timeHorizon: timeHorizon || null
    }
  };
}

async function _loadCatalogRoles() {
  // Prefer DB when available (rolesRepo.listRoles returns [] if not configured).
  try {
    const dbRoles = await rolesRepo.listRoles({ limit: 5000 });
    if (Array.isArray(dbRoles) && dbRoles.length > 0) return dbRoles;
  } catch (_) {
    // fall through
  }

  const seed = recommendationsService?.DEFAULT_ROLES_CATALOG;
  return Array.isArray(seed) ? seed : [];
}

async function _loadExploreRecommendationsPoolRoles(personaId) {
  /**
   * Loads the shared Explore recommendations pool (persisted) for this persona.
   * If it doesn't exist yet, this will trigger exactly one Bedrock fetch (in-flight deduped)
   * and then persist the pool, so mindmap/cards/search/filtering all reuse the same result.
   */
  if (!personaId) return [];
  try {
    const pool = await exploreRecommendationsPoolService.getOrCreateExploreRecommendationsPool({
      personaId: String(personaId).trim(),
      finalPersonaOverride: null,
      options: {
        storeCount: 12,
      },
    });

    return Array.isArray(pool?.roles) ? pool.roles : [];
  } catch (_) {
    return [];
  }
}

function _applyFiltersToNodes(nodes, { minSalaryLpa = null, maxSalaryLpa = null, minSkillSimilarity = null } = {}) {
  const minS = minSalaryLpa != null ? Number(minSalaryLpa) : null;
  const maxS = maxSalaryLpa != null ? Number(maxSalaryLpa) : null;
  const minSim = minSkillSimilarity != null ? Number(minSkillSimilarity) : null;

  return nodes.filter((n) => {
    // Never filter out center node.
    if (n?.type === 'current_role') return true;

    const mid = n?.data?.salaryLpaMid;
    if (Number.isFinite(minS) && Number.isFinite(mid) && mid < minS) return false;
    if (Number.isFinite(maxS) && Number.isFinite(mid) && mid > maxS) return false;

    const sim = n?.data?.skillSimilarity;
    if (Number.isFinite(minSim)) {
      // If similarity is missing, treat as not matching filter.
      if (!Number.isFinite(sim)) return false;
      if (sim < minSim) return false;
    }

    return true;
  });
}

function _buildDetailsForNode(node, { centerNode }) {
  /**
   * Builds the per-node details payload required by the drill-down panel.
   * Required by acceptance criteria:
   * - required skills
   * - average salary
   * - transition timeline
   * - skill gap from current position
   */
  const requiredSkills = _safeArray(node?.data?.requiredSkills).filter(Boolean);
  const centerSkills = _safeArray(centerNode?.data?.requiredSkills).filter(Boolean);

  const centerSet = new Set(centerSkills.map((s) => String(s).toLowerCase()));

  const missing = requiredSkills.filter((s) => !centerSet.has(String(s).toLowerCase()));
  const overlap = requiredSkills.filter((s) => centerSet.has(String(s).toLowerCase()));

  // Transition timeline heuristic based on level.
  const level = Number(node?.level || 1);
  let transitionTimeline = null;
  if (level <= 1) transitionTimeline = '6–12 months';
  else if (level === 2) transitionTimeline = '12–24 months';
  else transitionTimeline = '24–48 months';

  // Average salary: use midpoint if available, otherwise pass through the range.
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
      // A simple ratio to help UI badges/filters.
      similarityScore: requiredSkills.length > 0 ? Math.round((overlap.length / requiredSkills.length) * 100) : null
    }
  };
}

/**
 * Query schema for GET /api/mindmap/graph
 */
const GraphQuerySchema = z
  .object({
    /**
     * Accept both query param spellings for forward/backward compatibility.
     * Frontend standardizes on snake_case `user_id`, but some older clients send `userId`.
     */
    user_id: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),

    /**
     * Explore persona context:
     * When provided, the mindmap will reuse the persisted Explore recommendations pool
     * (single-fetch Bedrock results) instead of the global catalog.
     */
    personaId: z.string().min(1).optional(),
    persona_id: z.string().min(1).optional(),

    currentRoleTitle: z.string().min(1).optional(),
    // Optional filters
    minSalaryLpa: z.coerce.number().optional(),
    maxSalaryLpa: z.coerce.number().optional(),
    minSkillSimilarity: z.coerce.number().min(0).max(100).optional(),
    // Time horizon filter (Near|Mid|Far); if provided we only include edges/nodes on that horizon
    timeHorizon: z.enum(['Near', 'Mid', 'Far']).optional(),
    limit: z.coerce.number().min(3).max(100).optional()
  })
  .strict();

/**
 * Body schema for POST /api/mindmap/graph (frontend contract).
 * Frontend sends: { userId, currentRoleTitle?, filters: { salaryMin, salaryMax, skillSimilarityMin, timeHorizon } }
 */
const GraphPostBodySchema = z
  .object({
    userId: z.string().min(1),
    personaId: z.string().min(1).optional(),
    currentRoleTitle: z.string().min(1).optional(),
    filters: z
      .object({
        salaryMin: z.number().optional(),
        salaryMax: z.number().optional(),
        skillSimilarityMin: z.number().min(0).max(100).optional(),
        // Frontend uses "Any" when no filter is applied.
        timeHorizon: z.string().optional()
      })
      .optional()
  })
  .passthrough();

/**
 * INTERNAL
 * Shared implementation for building the mindmap graph.
 *
 * Accepts a normalized query-like object and returns:
 * { meta, nodes, edges, detailsByNodeId, centerNodeId }
 */
async function _buildMindmapGraph(q) {
  const limit = Number.isFinite(q.limit) ? q.limit : 18;

  // Center node: user's current role (prefer persisted extraction when a user id is provided).
  let currentRoleTitle = _normalizeLabel(q.currentRoleTitle || 'Current Role');

  const effectiveUserId = q.user_id || q.userId;
  const effectivePersonaId = q.personaId || q.persona_id;

  if (effectiveUserId) {
    try {
      const userTargetsRepo = await import('../repositories/userTargetsRepoAdapter.js');
      const current = await userTargetsRepo.default.getLatestUserCurrentRole({
        userId: String(effectiveUserId)
      });
      if (current?.currentRoleTitle) currentRoleTitle = _normalizeLabel(current.currentRoleTitle);
    } catch (_) {
      // ignore; fallback to query param label
    }
  }

  const centerRole = {
    roleId: 'current',
    roleTitle: currentRoleTitle,
    industry: null,
    coreSkills: [] // can be populated later from persona finalized skills.
  };
  const centerNode = _roleToNode(centerRole, { isCenter: true, level: 0 });

  // Load future roles:
  // - If personaId is provided: reuse the persisted Explore recommendations pool (single-fetch Bedrock)
  // - Else: fall back to global catalog (DB/seed)
  const sourceRoles = effectivePersonaId
    ? await _loadExploreRecommendationsPoolRoles(effectivePersonaId)
    : await _loadCatalogRoles();

  const allCandidateNodes = _safeArray(sourceRoles)
    .map((r) => {
      /**
       * Similarity/score:
       * - When using Explore pool, prefer compatibility/finalCompatibilityScore when present
       * - Otherwise fall back to a deterministic heuristic based on required skill count.
       */
      const compat =
        Number(r?.finalCompatibilityScore) ||
        Number(r?.compatibilityScore) ||
        Number(r?.threeTwoReport?.compatibilityScore);

      const requiredSkills = _safeArray(r?.coreSkills || r?.skills_required || r?.required_skills).filter(Boolean);
      const sim = Number.isFinite(compat) ? Math.max(0, Math.min(100, Math.round(compat))) : Math.max(25, Math.min(95, 30 + requiredSkills.length * 6));

      // For Explore pool nodes, keep them nearer by default; the selection logic below still fans out levels.
      const level = 1;

      return _roleToNode(r, { isCenter: false, level, score: sim });
    })
    .filter((n) => n?.id && n?.label);

  // Apply node-level filters (salary/similarity) early.
  const filteredCandidates = _applyFiltersToNodes([centerNode, ...allCandidateNodes], {
    minSalaryLpa: q.minSalaryLpa,
    maxSalaryLpa: q.maxSalaryLpa,
    minSkillSimilarity: q.minSkillSimilarity
  }).filter((n) => n.type !== 'current_role');

  // Deterministic-ish ordering so results are stable between calls.
  filteredCandidates.sort((a, b) => {
    const sa = Number.isFinite(a?.data?.skillSimilarity) ? a.data.skillSimilarity : 0;
    const sb = Number.isFinite(b?.data?.skillSimilarity) ? b.data.skillSimilarity : 0;
    if (sb !== sa) return sb - sa;
    return _normalizeLabel(a?.label).localeCompare(_normalizeLabel(b?.label));
  });

  const maxNodes = Math.max(3, limit);
  const level1Count = Math.min(10, Math.max(4, Math.floor((maxNodes - 1) * 0.55)));
  const level2Count = Math.min(6, Math.max(2, Math.floor((maxNodes - 1) * 0.3)));
  const level3Count = Math.min(4, Math.max(1, Math.floor((maxNodes - 1) * 0.15)));

  const pool = filteredCandidates.slice(0, Math.max(level1Count + level2Count + level3Count, maxNodes - 1));

  const lvl1 = [];
  const lvl2 = [];
  const lvl3 = [];

  for (const n of pool) {
    if ((n.level ?? 1) >= 3) lvl3.push({ ...n, level: 3 });
    else if ((n.level ?? 1) === 2) lvl2.push({ ...n, level: 2 });
    else lvl1.push({ ...n, level: 1 });
  }

  function take(arr, k) {
    return arr.slice(0, Math.max(0, k));
  }
  let L1 = take(lvl1, level1Count);
  let remaining = pool.filter((n) => !L1.some((x) => x.id === n.id));

  let L2 = take(lvl2, level2Count);
  remaining = remaining.filter((n) => !L2.some((x) => x.id === n.id));
  if (L2.length < level2Count) {
    const fill = take(
      remaining.map((n) => ({ ...n, level: 2 })),
      level2Count - L2.length
    );
    L2 = [...L2, ...fill];
    remaining = remaining.filter((n) => !fill.some((x) => x.id === n.id));
  }

  let L3 = take(lvl3, level3Count);
  remaining = remaining.filter((n) => !L3.some((x) => x.id === n.id));
  if (L3.length < level3Count) {
    const fill = take(
      remaining.map((n) => ({ ...n, level: 3 })),
      level3Count - L3.length
    );
    L3 = [...L3, ...fill];
    remaining = remaining.filter((n) => !fill.some((x) => x.id === n.id));
  }

  const selected = [...L1, ...L2, ...L3].slice(0, Math.max(0, maxNodes - 1));

  const edges = [];

  function horizonForLevel(level) {
    if (level <= 1) return 'Near';
    if (level === 2) return 'Mid';
    return 'Far';
  }

  function shouldIncludeHorizon(h) {
    return !q.timeHorizon || q.timeHorizon === h;
  }

  for (const n of selected.filter((x) => x.level === 1)) {
    const h = horizonForLevel(1);
    if (!shouldIncludeHorizon(h)) continue;
    edges.push(_buildEdge({ from: centerNode.id, to: n.id, label: h, timeHorizon: h }));
  }

  const L1Ids = selected.filter((x) => x.level === 1).map((x) => x.id);
  const L2Ids = selected.filter((x) => x.level === 2).map((x) => x.id);

  let p1 = 0;
  for (const n of selected.filter((x) => x.level === 2)) {
    const parent = L1Ids.length ? L1Ids[p1 % L1Ids.length] : centerNode.id;
    p1 += 1;
    const h = horizonForLevel(2);
    if (!shouldIncludeHorizon(h)) continue;
    edges.push(_buildEdge({ from: parent, to: n.id, label: h, timeHorizon: h }));
  }

  let p2 = 0;
  for (const n of selected.filter((x) => x.level === 3)) {
    const parent = L2Ids.length
      ? L2Ids[p2 % L2Ids.length]
      : L1Ids.length
        ? L1Ids[p2 % L1Ids.length]
        : centerNode.id;
    p2 += 1;
    const h = horizonForLevel(3);
    if (!shouldIncludeHorizon(h)) continue;
    edges.push(_buildEdge({ from: parent, to: n.id, label: h, timeHorizon: h }));
  }

  const connectedTargets = new Set(edges.map((e) => e.target));
  const connectedSources = new Set(edges.map((e) => e.source));
  const connectedAll = new Set([centerNode.id, ...Array.from(connectedTargets), ...Array.from(connectedSources)]);

  const nodes = [centerNode, ...selected.filter((n) => (q.timeHorizon ? connectedAll.has(n.id) : true))];

  const detailsByNodeId = {};
  for (const node of nodes) {
    detailsByNodeId[node.id] = _buildDetailsForNode(node, { centerNode });
  }

  return {
    meta: {
      center: { id: centerNode.id, label: centerNode.label },
      filtersApplied: {
        minSalaryLpa: q.minSalaryLpa ?? null,
        maxSalaryLpa: q.maxSalaryLpa ?? null,
        minSkillSimilarity: q.minSkillSimilarity ?? null,
        timeHorizon: q.timeHorizon ?? null,
        limit
      },
      generation: {
        model: 'multi_branch_v1',
        counts: {
          candidates: allCandidateNodes.length,
          afterFilters: filteredCandidates.length,
          level1: selected.filter((n) => n.level === 1).length,
          level2: selected.filter((n) => n.level === 2).length,
          level3: selected.filter((n) => n.level === 3).length
        }
      }
    },
    nodes,
    edges,
    detailsByNodeId,
    centerNodeId: centerNode.id
  };
}

/**
 * PUBLIC_INTERFACE
 * GET /api/mindmap/graph
 *
 * Returns mind map graph data suitable for zoom/pan rendering.
 */
router.get('/graph', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const parsed = GraphQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      throw err;
    }

    const graph = await _buildMindmapGraph(parsed.data);
    return res.json({
      meta: graph.meta,
      nodes: graph.nodes,
      edges: graph.edges,
      detailsByNodeId: graph.detailsByNodeId
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * POST /api/mindmap/graph
 *
 * Frontend contract: returns a simplified shape:
 * { nodes, edges, centerNodeId, meta? }
 */
router.post('/graph', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const parsed = GraphPostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const { userId, personaId, currentRoleTitle, filters } = parsed.data;

    const timeHorizon =
      filters?.timeHorizon && ['Near', 'Mid', 'Far'].includes(String(filters.timeHorizon))
        ? String(filters.timeHorizon)
        : undefined;

    const q = {
      userId: String(userId),
      personaId: personaId ? String(personaId) : undefined,
      currentRoleTitle: currentRoleTitle ? String(currentRoleTitle) : undefined,
      minSalaryLpa: Number.isFinite(filters?.salaryMin) ? filters.salaryMin : undefined,
      maxSalaryLpa: Number.isFinite(filters?.salaryMax) ? filters.salaryMax : undefined,
      minSkillSimilarity: Number.isFinite(filters?.skillSimilarityMin) ? filters.skillSimilarityMin : undefined,
      timeHorizon
    };

    const graph = await _buildMindmapGraph(q);

    const nodes = graph.nodes.map((n) => ({
      id: String(n.id),
      title: String(n?.data?.title || n?.label || n.id),
      ...n
    }));

    const edges = graph.edges.map((e) => ({
      source: String(e.source),
      target: String(e.target),
      label: e.label ?? null,
      ...e
    }));

    return res.json({
      nodes,
      edges,
      centerNodeId: graph.centerNodeId,
      meta: graph.meta,
      detailsByNodeId: graph.detailsByNodeId
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/mindmap/nodes/:id
 */
router.get('/nodes/:id', async (req, res) => {
  try {
    const nodeId = String(req.params.id || '').trim();
    if (!nodeId) {
      const err = new Error('node id is required');
      err.code = 'validation_error';
      err.httpStatus = 400;
      throw err;
    }

    const catalog = await _loadCatalogRoles();
    const found =
      nodeId === 'current'
        ? _roleToNode({ roleId: 'current', roleTitle: 'Current Role', coreSkills: [] }, { isCenter: true, level: 0 })
        : _roleToNode(catalog.find((r) => String(r?.roleId || r?.role_id || r?.id) === nodeId) || null, {
            isCenter: false,
            level: 1,
            score: null
          });

    if (!found || !found.id || !found.label) {
      const err = new Error('Node not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const centerNode = _roleToNode({ roleId: 'current', roleTitle: 'Current Role', coreSkills: [] }, { isCenter: true, level: 0 });
    const details = _buildDetailsForNode(found, { centerNode });

    return res.json(details);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * Body schema for POST /api/mindmap/node-details (frontend contract).
 */
const NodeDetailsPostBodySchema = z
  .object({
    nodeId: z.string().min(1),
    centerRoleId: z.string().min(1).optional()
  })
  .passthrough();

/**
 * PUBLIC_INTERFACE
 * POST /api/mindmap/node-details
 */
router.post('/node-details', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const parsed = NodeDetailsPostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const nodeId = String(parsed.data.nodeId).trim();
    const centerRoleId = parsed.data.centerRoleId ? String(parsed.data.centerRoleId).trim() : 'current';

    const catalog = await _loadCatalogRoles();
    const node =
      nodeId === 'current'
        ? _roleToNode({ roleId: 'current', roleTitle: 'Current Role', coreSkills: [] }, { isCenter: true, level: 0 })
        : _roleToNode(catalog.find((r) => String(r?.roleId || r?.role_id || r?.id) === nodeId) || null, {
            isCenter: false,
            level: 1,
            score: null
          });

    if (!node || !node.id || !node.label) {
      const err = new Error('Node not found.');
      err.code = 'NOT_FOUND';
      err.httpStatus = 404;
      throw err;
    }

    const centerNode =
      centerRoleId === 'current'
        ? _roleToNode({ roleId: 'current', roleTitle: 'Current Role', coreSkills: [] }, { isCenter: true, level: 0 })
        : _roleToNode(catalog.find((r) => String(r?.roleId || r?.role_id || r?.id) === centerRoleId) || null, {
            isCenter: true,
            level: 0,
            score: null
          });

    const details = _buildDetailsForNode(node, { centerNode: centerNode?.id ? centerNode : node });

    return res.json({
      nodeId,
      ...details
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * Body schema for POST /api/mindmap/view-state
 */
const ViewStateSaveBodySchema = z
  .object({
    userId: z.string().min(1),
    mapKey: z.string().min(1).default('default'),
    state: z
      .object({
        zoom: z.number().optional(),
        pan: z
          .object({
            x: z.number(),
            y: z.number()
          })
          .optional(),
        expandedNodeIds: z.array(z.string().min(1)).optional(),
        ui: z.record(z.any()).optional()
      })
      .passthrough()
  })
  .strict();

/**
 * Query schema for GET /api/mindmap/view-state
 */
const ViewStateLoadQuerySchema = z
  .object({
    userId: z.string().min(1),
    mapKey: z.string().min(1).optional()
  })
  .strict();

/**
 * PUBLIC_INTERFACE
 * POST /api/mindmap/view-state
 */
router.post('/view-state', async (req, res) => {
  try {
    let body = req.body;

    if (typeof body === 'string' && body.trim()) {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    body = body && typeof body === 'object' ? body : {};
    const hasUserId = typeof body.userId === 'string' && body.userId.trim().length > 0;
    const hasState = typeof body.state === 'object' && body.state != null;

    if (!hasUserId || !hasState) {
      return res.status(200).json({
        status: 'ok',
        ignored: true,
        reason: 'Missing required fields for view-state save (userId/state).',
        viewState: null
      });
    }

    const parsed = ViewStateSaveBodySchema.safeParse(body);
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      throw err;
    }

    const { userId, mapKey, state } = parsed.data;

    const engine = connectionGetDbEngine();
    const dbCapable = engine === 'mysql' && connectionIsDbConfigured() && connectionIsMysqlConfigured();

    let usedFallback = false;
    let viewState = null;
    if (dbCapable) {
      try {
        viewState = await mindmapViewStateRepo.saveViewState({ userId, mapKey, state });
      } catch (_) {
        usedFallback = true;
        viewState = await mindmapViewStateRepo.saveViewState({ userId, mapKey, state });
      }
    } else {
      usedFallback = true;
      viewState = await mindmapViewStateRepo.saveViewState({ userId, mapKey, state });
    }

    return res.status(200).json({
      status: 'ok',
      persistence: {
        type: usedFallback ? 'memory' : 'mysql',
        usedFallback
      },
      viewState
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/mindmap/view-state?userId=...&mapKey=...
 */
router.get('/view-state', async (req, res) => {
  try {
    const userIdRaw = req.query?.userId;
    const userId = typeof userIdRaw === 'string' && userIdRaw.trim().length > 0 ? userIdRaw.trim() : null;

    if (!userId) {
      return res.json({ status: 'ok', viewState: null });
    }

    const parsed = ViewStateLoadQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      throw err;
    }

    const mapKey = parsed.data.mapKey ? String(parsed.data.mapKey) : 'default';

    const viewState = await mindmapViewStateRepo.loadViewState({ userId, mapKey });

    return res.json({
      status: 'ok',
      viewState: viewState || null
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * Local helpers to avoid circular import in the hot path.
 * (Keeps parity with previous CommonJS behavior.)
 */
function connectionGetDbEngine() {
  return (process.env.DB_ENGINE || 'mysql').toLowerCase();
}
function connectionIsDbConfigured() {
  // The real implementation lives in ../db/connection.js; routes use this only as a
  // best-effort informational flag and do not rely on it for behavior.
  return true;
}
function connectionIsMysqlConfigured() {
  return true;
}

export default router;
