'use strict';

const express = require('express');
const { z } = require('zod');
const buildsService = require('../services/buildsService');

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
 * - This scaffold uses in-memory state (process-local).
 * - When DB/queue integration is added, these endpoints should remain stable.
 */

const BuildCreateRequest = z.object({
  personaId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  mode: z.enum(['persona_build', 'workflow']).nullable().optional()
});

function validationError(res, parsed) {
  return res.status(400).json({ error: 'validation_error', details: parsed.error.flatten() });
}

router.post('/', async (req, res) => {
  const parsed = BuildCreateRequest.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);

  // Even if DB is configured, this scaffold is in-memory; expose capability info for operators.
  const dbConfigured = buildsService.isDbConfiguredForBuilds();

  const build = buildsService.createBuild(parsed.data);
  return res.status(201).json({
    ...build,
    persistence: {
      type: 'memory',
      dbConfigured
    }
  });
});

router.get('/:id', async (req, res) => {
  const build = buildsService.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'not_found' });
  return res.json(build);
});

router.get('/:id/status', async (req, res) => {
  const status = buildsService.getBuildStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'not_found' });
  return res.json(status);
});

router.post('/:id/cancel', async (req, res) => {
  const status = buildsService.cancelBuild(req.params.id);
  if (!status) return res.status(404).json({ error: 'not_found' });
  return res.json(status);
});

module.exports = router;
