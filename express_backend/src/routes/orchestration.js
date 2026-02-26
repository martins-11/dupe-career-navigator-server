'use strict';

const express = require('express');
const orchestrationService = require('../services/orchestrationService');
const { sendError } = require('../utils/errors');

const router = express.Router();

/**
 * Orchestration APIs.
 *
 * These endpoints intentionally compose existing features:
 * - builds/workflows (in-memory)
 * - uploads/documents (memory repo default)
 * - extraction/normalization services
 * - AI persona generation placeholder (strict schema validated)
 *
 * They do NOT require DB or AI credentials.
 */



// PUBLIC_INTERFACE
router.post('/start', async (req, res) => {
  /**
   * Start a build/workflow and create an orchestration session.
   *
   * Body: OrchestrationStartRequest
   * Returns: { build, orchestration }
   */
  try {
    const out = await orchestrationService.startOrchestration(req.body || {});
    return res.status(201).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/run-all', async (req, res) => {
  /**
   * Run the full build workflow end-to-end in a single call.
   *
   * This endpoint composes:
   * - orchestration start (creates buildId for polling)
   * - link upload/documents
   * - extract+normalize (requires extracted text to already exist, typically via /uploads/* side effects)
   * - persona draft generation (placeholder)
   * - optional finalize
   *
   * Poll progress via:
   * - GET /builds/:id/status (build/workflow progress)
   * - GET /orchestration/builds/:id (run-all step trace + artifacts)
   */
  try {
    const out = await orchestrationService.runAllOrchestration(req.body || {});
    return res.status(201).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.get('/builds/:id', async (req, res) => {
  /**
   * Get orchestration record for a build id (link state).
   */
  try {
    const orch = orchestrationService.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'not_found', message: 'Orchestration record not found.' });
    return res.json(orch);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/builds/:id/link-upload', async (req, res) => {
  /**
   * Link an uploadId + documentIds to an existing build id.
   *
   * This is useful because /uploads/* endpoints intentionally keep their response stable
   * (they do not currently return document ids).
   */
  try {
    const out = await orchestrationService.linkUploadToBuild(req.params.id, req.body || {});
    return res.status(200).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/builds/:id/extract-normalize', async (req, res) => {
  /**
   * Derive combined normalized text for the build from linked documents.
   *
   * Requires that extracted text already exists for those documents:
   * - via /uploads/* (side effect)
   * - or via /documents/:id/extracted-text
   */
  try {
    const out = await orchestrationService.extractAndNormalizeForBuild(req.params.id, req.body || {});
    return res.status(200).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/builds/:id/generate-draft', async (req, res) => {
  /**
   * Generate persona draft from normalized text (or provided override).
   *
   * Safe placeholder (no external AI calls).
   */
  try {
    const out = await orchestrationService.generatePersonaDraftForBuild(req.params.id, req.body || {});
    return res.status(200).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

// PUBLIC_INTERFACE
router.post('/builds/:id/finalize', async (req, res) => {
  /**
   * Finalize persona:
   * - saves final blob (memory repo default)
   * - optionally creates a new version
   */
  try {
    const out = await orchestrationService.finalizePersonaForBuild(req.params.id, req.body || {});
    return res.status(200).json(out);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
