'use strict';

const express = require('express');

const router = express.Router();

/**
 * Career paths APIs (boilerplate).
 *
 * Placeholder endpoints that return deterministic sample data.
 */

// PUBLIC_INTERFACE
router.get('/multiverse', async (req, res) => {
  /**
   * Return a "multiverse" of potential career paths (placeholder).
   *
   * Response: { paths: Array<{ id, title, steps: string[] }> }
   */
  return res.json({
    paths: [
      {
        id: 'path_1',
        title: 'Engineer → Senior Engineer → Tech Lead',
        steps: ['Engineer', 'Senior Engineer', 'Tech Lead']
      },
      {
        id: 'path_2',
        title: 'Analyst → Senior Analyst → Analytics Manager',
        steps: ['Analyst', 'Senior Analyst', 'Analytics Manager']
      }
    ]
  });
});

module.exports = router;
