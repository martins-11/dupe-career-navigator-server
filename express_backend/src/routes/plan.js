'use strict';

const express = require('express');

const router = express.Router();

/**
 * Plan APIs (boilerplate).
 */

// PUBLIC_INTERFACE
router.post('/milestones', async (req, res) => {
  /**
   * Create/derive milestones for a plan (placeholder).
   *
   * Body: { goal?: string, timeframeWeeks?: number, context?: object }
   * Response: { milestones: Array<{ id: string, title: string, description?: string, order: number }> }
   */
  const goal = (req.body?.goal && String(req.body.goal).trim()) || 'Career growth plan';
  const timeframeWeeks = Number(req.body?.timeframeWeeks || 12);

  return res.status(200).json({
    goal,
    timeframeWeeks,
    milestones: [
      { id: 'm1', title: 'Assess current skills', description: 'Identify strengths and gaps.', order: 1 },
      { id: 'm2', title: 'Build targeted projects', description: 'Ship 1–2 portfolio items.', order: 2 },
      { id: 'm3', title: 'Interview preparation', description: 'Practice, iterate, apply.', order: 3 }
    ]
  });
});

module.exports = router;
