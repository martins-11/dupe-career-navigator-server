'use strict';

const express = require('express');
const { z } = require('zod');
const { sendError } = require('../utils/errors');
const rolesRepo = require('../repositories/rolesRepoAdapter');
const recommendationsService = require('../services/recommendationsService');
const mindmapViewStateRepo = require('../repositories/mindmapViewStateRepoAdapter');

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

  const requiredSet = new Set(requiredSkills.map((s) => String(s).toLowerCase()));
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
      similarityScore:
        requiredSkills.length > 0 ? Math.round((overlap.length / requiredSkills.length) * 100) : null
    }
  };
}

/**
 * Query schema for GET /api/mindmap/graph
 */
const GraphQuerySchema = z
  .object({
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
 * PUBLIC_INTERFACE
 * GET /api/mindmap/graph
 *
 * Returns mind map graph data suitable for zoom/pan rendering:
 * {
 *   meta: { center: { id, label }, filtersApplied: {...} },
 *   nodes: Array<{ id, label, type, level, data:{...} }>,
 *   edges: Array<{ id, source, target, type, label?, data:{ timeHorizon? } }>,
 *   detailsByNodeId: Record<string, { requiredSkills, averageSalary, transitionTimeline, skillGap } >
 * }
 *
 * Notes:
 * - The server includes per-node details payload so the UI can render the drill-down panel without
 *   additional round-trips.
 * - "Current role" is derived from query.currentRoleTitle (fallbacks to "Current Role" if absent).
 * - Future role branches are generated from the catalog and heuristics (until a dedicated paths model exists).
 */
router.get('/graph', async (req, res) => {
  try {
    const parsed = GraphQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      throw err;
    }

    const q = parsed.data;
    const limit = Number.isFinite(q.limit) ? q.limit : 18;

    // Center node: user current role (for now derived from query; later can be derived from persona).
    const centerRole = {
      roleId: 'current',
      roleTitle: _normalizeLabel(q.currentRoleTitle || 'Current Role'),
      industry: null,
      coreSkills: [] // can be populated later from persona finalized skills.
    };
    const centerNode = _roleToNode(centerRole, { isCenter: true, level: 0 });

    // Load future roles from catalog.
    const catalog = await _loadCatalogRoles();
    const candidates = _safeArray(catalog)
      .map((r) => {
        // Create node with a pseudo similarity score (when catalog lacks scoring):
        // Use number of skills as a weak proxy and clamp 30-90 for UI variability.
        const requiredSkills = _safeArray(r?.coreSkills || r?.skills_required || r?.required_skills).filter(Boolean);
        const sim = Math.max(30, Math.min(90, 35 + requiredSkills.length * 5));
        // Level heuristic based on "seniority" fields if present.
        const level = r?.seniorityLevel || r?.seniority_level ? 2 : 1;
        return _roleToNode(r, { isCenter: false, level, score: sim });
      })
      .filter((n) => n?.id && n?.label);

    // Apply node filters
    let filtered = _applyFiltersToNodes([centerNode, ...candidates], {
      minSalaryLpa: q.minSalaryLpa,
      maxSalaryLpa: q.maxSalaryLpa,
      minSkillSimilarity: q.minSkillSimilarity
    });

    // Cap to limit but keep center node.
    const center = filtered.find((n) => n.type === 'current_role') || centerNode;
    const rest = filtered.filter((n) => n.type !== 'current_role').slice(0, Math.max(0, limit - 1));
    filtered = [center, ...rest];

    // Build simple branching edges radiating from center.
    // Time horizon heuristic based on node.level.
    const edges = [];
    for (const node of rest) {
      const timeHorizon = node.level <= 1 ? 'Near' : node.level === 2 ? 'Mid' : 'Far';
      if (q.timeHorizon && q.timeHorizon !== timeHorizon) continue;
      edges.push(
        _buildEdge({
          from: center.id,
          to: node.id,
          label: timeHorizon,
          timeHorizon
        })
      );
    }

    // If time horizon filter removed edges, also remove orphan nodes (except center).
    const connectedTargets = new Set(edges.map((e) => e.target));
    const nodes = [center, ...rest.filter((n) => connectedTargets.has(n.id))];

    // Build per-node detail payloads.
    const detailsByNodeId = {};
    for (const node of nodes) {
      detailsByNodeId[node.id] = _buildDetailsForNode(node, { centerNode: center });
    }

    return res.json({
      meta: {
        center: { id: center.id, label: center.label },
        filtersApplied: {
          minSalaryLpa: q.minSalaryLpa ?? null,
          maxSalaryLpa: q.maxSalaryLpa ?? null,
          minSkillSimilarity: q.minSkillSimilarity ?? null,
          timeHorizon: q.timeHorizon ?? null,
          limit
        }
      },
      nodes,
      edges,
      detailsByNodeId
    });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/mindmap/nodes/:id
 *
 * Returns per-node details payload for a specific node id.
 * This is useful if the frontend wants to lazy-load detail panels, though /graph already includes it.
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

    // We rebuild from the catalog; for now treat nodeId as roleId.
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
        // Persist which nodes are expanded/open in the UI.
        expandedNodeIds: z.array(z.string().min(1)).optional(),
        // Optional: any UI-specific preferences (filters etc).
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
 *
 * Saves mind map view state (zoom/pan/expanded nodes) so the UI can restore it later.
 *
 * Request body:
 * {
 *   userId: string,
 *   mapKey?: string, // optional namespace (default "default")
 *   state: { zoom?, pan?, expandedNodeIds?, ui? }
 * }
 *
 * Response:
 * {
 *   status: "ok",
 *   persistence: { type: "mysql"|"memory", usedFallback: boolean },
 *   viewState: { userId, mapKey, state, updatedAt }
 * }
 */
router.post('/view-state', async (req, res) => {
  try {
    // This endpoint is called frequently (autosave). It must be resilient:
    // - Client bugs or race conditions should not create noisy 400s.
    // - We treat empty payloads as a no-op (200) and let callers continue using localStorage.
    const body = req.body || {};
    const hasUserId = body && typeof body.userId === 'string' && body.userId.trim().length > 0;
    const hasState = body && typeof body.state === 'object' && body.state != null;

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

    // Determine whether DB is intended to be used (informational only).
    const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
    const engine = getDbEngine();
    const dbCapable = engine === 'mysql' && isDbConfigured() && isMysqlConfigured();

    let usedFallback = false;
    let viewState = null;
    if (dbCapable) {
      // Adapter will still fallback on runtime DB failures.
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
 *
 * Loads the latest saved mind map view state for the user.
 *
 * Response:
 * {
 *   status: "ok",
 *   viewState: { userId, mapKey, state, updatedAt } | null
 * }
 *
 * Notes:
 * - Returns 200 with viewState=null when no saved state exists.
 * - Gracefully falls back to in-memory storage when DB is unavailable.
 */
router.get('/view-state', async (req, res) => {
  try {
    // Be tolerant: if userId is missing/empty, treat as "no saved state" rather than failing.
    // This prevents UI boot flows from breaking when a caller hasn't resolved a user key yet.
    const userIdRaw = req.query?.userId;
    const userId =
      typeof userIdRaw === 'string' && userIdRaw.trim().length > 0 ? userIdRaw.trim() : null;

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

module.exports = router;
