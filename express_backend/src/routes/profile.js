'use strict';

const express = require('express');

const router = express.Router();

/**
 * Profile APIs (boilerplate).
 */

// PUBLIC_INTERFACE
router.put('/scoring', async (req, res) => {
  /**
   * Update profile scoring inputs/results (placeholder).
   *
   * Body: { userId?: string, scoring?: object }
   * Response: { status: 'ok', scoring: object }
   */
  const scoring = req.body?.scoring || {};

  return res.json({
    status: 'ok',
    scoring: {
      ...scoring,
      // Add a deterministic placeholder overall score if not provided.
      overall: scoring.overall ?? 0
    }
  });
});

module.exports = router;
