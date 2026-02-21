'use strict';

const express = require('express');
const { query } = require('../db/query');

const router = express.Router();

/**
 * Health endpoints.
 */

router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/db', async (req, res) => {
  try {
    const r = await query('SELECT 1 as ok');
    res.json({ status: 'ok', db: r.rows[0] });
  } catch (err) {
    // Do not leak sensitive connection info; just show message.
    res.status(503).json({ status: 'degraded', db: 'unavailable', message: err.message });
  }
});

module.exports = router;
