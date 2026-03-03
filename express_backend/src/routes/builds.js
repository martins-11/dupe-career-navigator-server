'use strict';

const express = require('express');
const { z } = require('zod');
const buildsService = require('../services/buildsService');
const { getDbEngine } = require('../db/connection');

const router = express.Router();

/**
 * Build/Workflow APIs (scaffold).
 *
 * Provides:
 * - POST /builds -> create a build/workflow
 * - GET /builds/:id -> full build record
 * - GET /builds/:id/status -> polling-friendly status projection
 * - POST /builds/:id/cancel -> cancel a running/queued build
 *
 * Notes:
 * - This scaffold uses in-memory state (process-local) by default.
 * - When DB integration is configured but temporarily unreachable (DNS, SG, whitelist),
 *   these routes MUST NOT crash the Node process; they should degrade gracefully.
 */

const BuildCreateRequest = z.object({
  personaId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  mode: z.enum(['persona_build', 'workflow']).nullable().optional()
});

function validationError(res, parsed) {
  return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
}

function isConnectivityError(err) {
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '').toLowerCase();

  // Common network/DNS/MySQL connect failure modes
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    msg.includes('getaddrinfo') ||
    msg.includes('connect') ||
    msg.includes('timeout')
  );
}

router.post('/', async (req, res) => {
  const parsed = BuildCreateRequest.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);

  try {
    const dbConfigured = buildsService.isDbConfiguredForBuilds();
    const build = await buildsService.createBuild(parsed.data);

    return res.status(201).json({
      ...build,
      persistence: {
        // NOTE: Keep the field stable; this is informational only.
        type: dbConfigured ? getDbEngine() : 'memory',
        dbConfigured
      }
    });
  } catch (err) {
    // Degrade gracefully if DB connectivity is broken and the service attempted DB persistence.
    if (isConnectivityError(err) || isConnectivityError(err?.cause)) {
      // eslint-disable-next-line no-console
      console.warn('[POST /builds] DB connectivity error; falling back to memory:', err);

      const build = await buildsService.createBuild({ ...parsed.data, forceMemory: true });

      return res.status(201).json({
        ...build,
        persistence: {
          type: 'memory',
          dbConfigured: false,
          degradedFrom: getDbEngine(),
          warning: 'DB_UNAVAILABLE_FALLBACK_TO_MEMORY'
        }
      });
    }

    // Unknown error -> safe error response (do not crash process)
    // eslint-disable-next-line no-console
    console.error('[POST /builds] Unhandled error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const build = await buildsService.getBuild(req.params.id);
    if (!build) return res.status(404).json({ error: 'not_found' });
    return res.json(build);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[GET /builds/:id] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const status = await buildsService.getBuildStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'not_found' });
    return res.json(status);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[GET /builds/:id/status] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const status = await buildsService.cancelBuild(req.params.id);
    if (!status) return res.status(404).json({ error: 'not_found' });
    return res.json(status);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[POST /builds/:id/cancel] error:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
});

module.exports = router;
