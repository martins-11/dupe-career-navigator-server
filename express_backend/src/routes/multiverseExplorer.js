import express from 'express';
import { getZodSync } from '../utils/zod.js';
import { sendError } from '../utils/errors.js';
import multiverseBookmarksRepo from '../repositories/multiverseBookmarksRepoAdapter.js';
import multiverseExplorerService from '../services/multiverseExplorerService.js';

const { z } = getZodSync();
const router = express.Router();

/**
 * Multiverse Explorer APIs.
 *
 * Endpoints:
 * - GET  /api/multiverse/graph
 * - POST /api/multiverse/graph
 * - GET  /api/multiverse/nodes/:id
 * - GET  /api/multiverse/paths/:id
 * - GET  /api/multiverse/bookmarks
 * - PUT  /api/multiverse/bookmarks
 * - DELETE /api/multiverse/bookmarks
 *
 * Persistence:
 * - Bookmarks persist to MySQL when configured; otherwise in-memory fallback.
 */

const GraphQuerySchema = z
  .object({
    personaId: z.string().min(1).optional(),
    currentRoleTitle: z.string().min(1).optional(),

    minSalaryLpa: z.coerce.number().optional(),
    maxSalaryLpa: z.coerce.number().optional(),
    minSkillSimilarity: z.coerce.number().min(0).max(100).optional(),
    timeHorizon: z.enum(['Near', 'Mid', 'Far']).optional(),
    limit: z.coerce.number().min(3).max(100).optional(),
  })
  .strict();

const GraphPostBodySchema = z
  .object({
    personaId: z.string().min(1),
    currentRoleTitle: z.string().min(1).optional(),
    filters: z
      .object({
        minSalaryLpa: z.number().optional(),
        maxSalaryLpa: z.number().optional(),
        minSkillSimilarity: z.number().min(0).max(100).optional(),
        timeHorizon: z.enum(['Near', 'Mid', 'Far']).optional(),
      })
      .optional(),
    limit: z.number().min(3).max(100).optional(),
  })
  .passthrough();

/**
 * Small in-process cache for the multiverse graph.
 *
 * Why:
 * - /api/multiverse/graph is called on Explore Multiverse page load and must respond quickly.
 * - Graph construction may cascade into DB reads and/or Bedrock-backed recommendation generation
 *   via exploreRecommendationsPoolService, which can exceed proxy timeouts in preview.
 *
 * This cache provides:
 * - short TTL caching for repeated UI calls (filters/limit toggles)
 * - stale-while-fallback behavior if the live build exceeds a time budget
 *
 * NOTE: This is process-local (no cross-instance sharing). That is intentional for minimal risk.
 */
const _graphCache = new Map(); // key -> { value, expiresAtMs }

/**
 * Build a stable cache key from validated query params.
 */
function _graphCacheKey(q) {
  return JSON.stringify({
    personaId: q.personaId ? String(q.personaId) : null,
    currentRoleTitle: q.currentRoleTitle ? String(q.currentRoleTitle) : 'Current Role',
    filters: {
      minSalaryLpa: q.minSalaryLpa ?? null,
      maxSalaryLpa: q.maxSalaryLpa ?? null,
      minSkillSimilarity: q.minSkillSimilarity ?? null,
      timeHorizon: q.timeHorizon ?? null,
    },
    limit: q.limit ?? null,
  });
}

function _getCachedGraph(key) {
  const hit = _graphCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAtMs) {
    _graphCache.delete(key);
    return null;
  }
  return hit.value;
}

function _setCachedGraph(key, value, ttlMs) {
  const ms = Number.isFinite(ttlMs) ? Math.max(250, ttlMs) : 8000;
  _graphCache.set(key, { value, expiresAtMs: Date.now() + ms });
}

/**
 * Deterministic minimal skeleton graph (safe fallback).
 * Keeps the Explore UI alive even when upstream work is slow/unavailable.
 */
function _skeletonGraph({ personaId, currentRoleTitle, filtersApplied, reason }) {
  const centerLabel = currentRoleTitle || 'Current Role';
  return {
    meta: {
      personaId: personaId || null,
      center: { id: 'current', label: centerLabel },
      filtersApplied: { ...(filtersApplied || {}) },
      poolMeta: { fallback: true, reason: reason || 'timeout_or_error' },
    },
    nodes: [
      {
        id: 'current',
        type: 'current_role',
        label: centerLabel,
        level: 0,
        data: { title: centerLabel, industry: null, requiredSkills: [], salaryRange: null, experienceRange: null },
      },
    ],
    edges: [],
    detailsByNodeId: {
      current: {
        id: 'current',
        title: centerLabel,
        industry: null,
        requiredSkills: [],
        averageSalary: null,
        transitionTimeline: null,
        skillGap: { missingSkills: [], matchingSkills: [], similarityScore: null },
      },
    },
    paths: [],
  };
}

/**
 * PUBLIC_INTERFACE
 * GET /api/multiverse/graph
 */
router.get('/graph', async (req, res) => {
  try {
    /**
     * Cache guidance:
     * - allow short-lived caching in browsers/proxies
     * - stale-while-revalidate helps hide brief spikes
     */
    res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');

    const parsed = GraphQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const q = parsed.data;
    const key = _graphCacheKey(q);

    // 1) Fast path: return cached graph if available.
    const cached = _getCachedGraph(key);
    if (cached) {
      return res.json({ ...cached, meta: { ...(cached.meta || {}), cacheHit: true } });
    }

    const personaId = q.personaId ? String(q.personaId) : null;
    const currentRoleTitle = q.currentRoleTitle ? String(q.currentRoleTitle) : 'Current Role';
    const filters = {
      minSalaryLpa: q.minSalaryLpa,
      maxSalaryLpa: q.maxSalaryLpa,
      minSkillSimilarity: q.minSkillSimilarity,
      timeHorizon: q.timeHorizon,
    };
    const limit = q.limit;

    // 2) Enforce a strict time budget to avoid upstream 504s.
    const timeBudgetMsRaw = Number(process.env.MULTIVERSE_GRAPH_TIME_BUDGET_MS || 1200);
    const timeBudgetMs =
      Number.isFinite(timeBudgetMsRaw) && timeBudgetMsRaw > 0 ? Math.max(250, Math.min(5000, timeBudgetMsRaw)) : 1200;

    const buildPromise = multiverseExplorerService.buildMultiverseGraph({
      personaId,
      currentRoleTitle,
      filters,
      limit,
      /**
       * Forward a best-effort time budget down to the pool generator (if it honors it).
       * This is additive safety; the hard budget is enforced here via Promise.race.
       */
      timeBudgetMs,
    });

    const graph = await Promise.race([
      buildPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeBudgetMs)),
    ]);

    // 3) If build exceeded budget, serve a safe fallback quickly.
    if (!graph) {
      // If we have ANY prior cached value (even expired), prefer it as a stale fallback.
      // (We do not keep expired entries; so this is effectively “no prior value”.)
      const fallback = _skeletonGraph({
        personaId,
        currentRoleTitle,
        filtersApplied: {
          minSalaryLpa: filters.minSalaryLpa ?? null,
          maxSalaryLpa: filters.maxSalaryLpa ?? null,
          minSkillSimilarity: filters.minSkillSimilarity ?? null,
          timeHorizon: filters.timeHorizon ?? null,
          limit: Math.max(3, Math.min(100, Number(limit) || 18)),
        },
        reason: 'time_budget_exceeded',
      });

      // Cache the skeleton briefly to avoid request storms.
      _setCachedGraph(key, fallback, 1500);

      return res.json(fallback);
    }

    // Cache the successful response.
    _setCachedGraph(key, graph, Number(process.env.MULTIVERSE_GRAPH_CACHE_TTL_MS || 8000));

    return res.json(graph);
  } catch (err) {
    /**
     * Safe-fail behavior: the Explore Multiverse UI should not hard-fail on backend slowness.
     * Instead of returning a 5xx (which can surface as 504 upstream), return a minimal graph.
     */
    try {
      const q = GraphQuerySchema.safeParse(req.query || {});
      const data = q.success ? q.data : {};
      const personaId = data.personaId ? String(data.personaId) : null;
      const currentRoleTitle = data.currentRoleTitle ? String(data.currentRoleTitle) : 'Current Role';

      const fallback = _skeletonGraph({
        personaId,
        currentRoleTitle,
        filtersApplied: {
          minSalaryLpa: data.minSalaryLpa ?? null,
          maxSalaryLpa: data.maxSalaryLpa ?? null,
          minSkillSimilarity: data.minSkillSimilarity ?? null,
          timeHorizon: data.timeHorizon ?? null,
          limit: Math.max(3, Math.min(100, Number(data.limit) || 18)),
        },
        reason: err?.code || err?.name || 'error',
      });

      return res.json(fallback);
    } catch (_) {
      return sendError(res, err);
    }
  }
});

/**
 * PUBLIC_INTERFACE
 * POST /api/multiverse/graph
 */
router.post('/graph', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = GraphPostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const b = parsed.data;

    const graph = await multiverseExplorerService.buildMultiverseGraph({
      personaId: String(b.personaId),
      currentRoleTitle: b.currentRoleTitle ? String(b.currentRoleTitle) : 'Current Role',
      filters: b.filters || {},
      limit: b.limit,
    });

    return res.json(graph);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/multiverse/nodes/:id
 */
router.get('/nodes/:id', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const nodeId = String(req.params.id || '').trim();
    if (!nodeId) {
      const err = new Error('node id is required');
      err.code = 'validation_error';
      err.httpStatus = 400;
      throw err;
    }

    const personaId = req.query?.personaId ? String(req.query.personaId).trim() : null;
    const currentRoleTitle = req.query?.currentRoleTitle ? String(req.query.currentRoleTitle).trim() : 'Current Role';

    const details = await multiverseExplorerService.getNodeDetails({ personaId, nodeId, currentRoleTitle });
    if (!details) {
      const err = new Error('Node not found.');
      err.code = 'NOT_FOUND';
      err.httpStatus = 404;
      throw err;
    }

    return res.json(details);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * GET /api/multiverse/paths/:id
 */
router.get('/paths/:id', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const pathId = String(req.params.id || '').trim();
    if (!pathId) {
      const err = new Error('path id is required');
      err.code = 'validation_error';
      err.httpStatus = 400;
      throw err;
    }

    const personaId = req.query?.personaId ? String(req.query.personaId).trim() : null;
    const currentRoleTitle = req.query?.currentRoleTitle ? String(req.query.currentRoleTitle).trim() : 'Current Role';

    const filters = {
      minSalaryLpa: req.query?.minSalaryLpa != null ? Number(req.query.minSalaryLpa) : undefined,
      maxSalaryLpa: req.query?.maxSalaryLpa != null ? Number(req.query.maxSalaryLpa) : undefined,
      minSkillSimilarity: req.query?.minSkillSimilarity != null ? Number(req.query.minSkillSimilarity) : undefined,
      timeHorizon: req.query?.timeHorizon ? String(req.query.timeHorizon) : undefined,
    };

    // Multiverse prompt control: enforce the selected multiverse path type.
    // Allowed: lateral | vertical | pivot | non_linear
    const pathType = req.query?.pathType ? String(req.query.pathType).trim() : 'lateral';

    const details = await multiverseExplorerService.getPathDetails({
      personaId,
      pathId,
      currentRoleTitle,
      filters,
      pathType,
    });

    if (!details) {
      const err = new Error('Path not found.');
      err.code = 'NOT_FOUND';
      err.httpStatus = 404;
      throw err;
    }

    return res.json(details);
  } catch (err) {
    return sendError(res, err);
  }
});

const BookmarksListQuerySchema = z
  .object({
    userId: z.string().min(1),
    bookmarkType: z.enum(['node', 'path']).optional(),
    limit: z.coerce.number().min(0).max(1000).optional(),
    offset: z.coerce.number().min(0).optional(),
  })
  .strict();

const BookmarkUpsertBodySchema = z
  .object({
    userId: z.string().min(1),
    bookmarkType: z.enum(['node', 'path']),
    bookmarkKey: z.string().min(1),
    payload: z.any().optional(),
  })
  .passthrough();

const BookmarkDeleteBodySchema = z
  .object({
    userId: z.string().min(1),
    bookmarkType: z.enum(['node', 'path']),
    bookmarkKey: z.string().min(1),
  })
  .strict();

/**
 * PUBLIC_INTERFACE
 * GET /api/multiverse/bookmarks?userId=...&bookmarkType=node|path
 */
router.get('/bookmarks', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = BookmarksListQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const { userId, bookmarkType, limit, offset } = parsed.data;
    const rows = await multiverseBookmarksRepo.listBookmarks({
      userId: String(userId),
      bookmarkType: bookmarkType ? String(bookmarkType) : null,
      limit,
      offset,
    });

    return res.json({ bookmarks: rows });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * PUT /api/multiverse/bookmarks
 *
 * Body:
 * { userId, bookmarkType: 'node'|'path', bookmarkKey, payload? }
 */
router.put('/bookmarks', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = BookmarkUpsertBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const { userId, bookmarkType, bookmarkKey, payload } = parsed.data;
    const record = await multiverseBookmarksRepo.upsertBookmark({
      userId: String(userId),
      bookmarkType: String(bookmarkType),
      bookmarkKey: String(bookmarkKey),
      payload: payload ?? null,
    });

    return res.json({ status: 'ok', bookmark: record });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * PUBLIC_INTERFACE
 * DELETE /api/multiverse/bookmarks
 *
 * Body:
 * { userId, bookmarkType: 'node'|'path', bookmarkKey }
 */
router.delete('/bookmarks', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = BookmarkDeleteBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const err = new Error('Invalid request body.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const { userId, bookmarkType, bookmarkKey } = parsed.data;
    const result = await multiverseBookmarksRepo.deleteBookmark({
      userId: String(userId),
      bookmarkType: String(bookmarkType),
      bookmarkKey: String(bookmarkKey),
    });

    return res.json({ status: 'ok', ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;

