import express from 'express';
import { query } from '../db/query.js';
import { isDbConfigured } from '../db/connection.js';

const router = express.Router();

/**
 * Health endpoints.
 */

router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/db', async (req, res) => {
  try {
    // OpenAPI contract: return 503 when DB is not configured or not reachable.
    if (!isDbConfigured()) {
      return res.status(503).json({
        error: 'db_unavailable',
        message: 'Database is not configured (missing required env vars).'
      });
    }

    const r = await query('SELECT 1 as ok');
    return res.json({ status: 'ok', db: r.rows[0] || { ok: 1 } });
  } catch (err) {
    // Do not leak sensitive connection info; keep message but return ErrorResponse shape.
    return res.status(503).json({
      error: 'db_unavailable',
      message: err?.message ? String(err.message) : 'Database is unavailable.'
    });
  }
});

export default router;
