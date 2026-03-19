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
 * PUBLIC_INTERFACE
 * GET /api/multiverse/graph
 */
router.get('/graph', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = GraphQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      const err = new Error('Invalid query parameters.');
      err.name = 'ZodError';
      err.issues = parsed.error.issues;
      err.httpStatus = 400;
      throw err;
    }

    const q = parsed.data;
    const graph = await multiverseExplorerService.buildMultiverseGraph({
      personaId: q.personaId ? String(q.personaId) : null,
      currentRoleTitle: q.currentRoleTitle ? String(q.currentRoleTitle) : 'Current Role',
      filters: {
        minSalaryLpa: q.minSalaryLpa,
        maxSalaryLpa: q.maxSalaryLpa,
        minSkillSimilarity: q.minSkillSimilarity,
        timeHorizon: q.timeHorizon,
      },
      limit: q.limit,
    });

    return res.json(graph);
  } catch (err) {
    return sendError(res, err);
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

    const details = await multiverseExplorerService.getPathDetails({
      personaId,
      pathId,
      currentRoleTitle,
      filters,
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

