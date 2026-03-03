'use strict';

const express = require('express');

const router = express.Router();

/**
 * Recommendations APIs (boilerplate).
 *
 * These are scaffold endpoints requested by the Career Navigator app.
 * They are safe placeholders: no external AI calls and no DB requirements.
 */

// PUBLIC_INTERFACE
router.get('/roles', async (req, res) => {
  /**
   * Return a curated list of recommended roles.
   *
   * Response: { roles: Array<{ id: string, title: string, description?: string, tags?: string[] }> }
   */
  return res.json({
    roles: [
      {
        id: 'software_engineer',
        title: 'Software Engineer',
        description: 'Builds and maintains software products.',
        tags: ['engineering', 'coding']
      },
      {
        id: 'data_analyst',
        title: 'Data Analyst',
        description: 'Analyzes datasets to support business decisions.',
        tags: ['data', 'analytics']
      },
      {
        id: 'product_manager',
        title: 'Product Manager',
        description: 'Owns product direction, requirements, and delivery.',
        tags: ['product', 'strategy']
      }
    ]
  });
});

// PUBLIC_INTERFACE
router.post('/compare', async (req, res) => {
  /**
   * Compare two roles (placeholder).
   *
   * Body: { leftRoleId: string, rightRoleId: string, context?: object }
   * Response: { leftRoleId, rightRoleId, comparison: { summary, differences: string[] } }
   */
  const leftRoleId = req.body?.leftRoleId;
  const rightRoleId = req.body?.rightRoleId;

  if (!leftRoleId || !rightRoleId) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Both leftRoleId and rightRoleId are required.'
    });
  }

  return res.json({
    leftRoleId,
    rightRoleId,
    comparison: {
      summary: 'Placeholder comparison (AI-backed comparison pending).',
      differences: [
        'Day-to-day responsibilities differ by organization.',
        'Skill emphasis differs depending on team/product.'
      ]
    }
  });
});

module.exports = router;
