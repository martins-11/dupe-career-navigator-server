'use strict';

const express = require('express');
const userTargetsRepo = require('../repositories/userTargetsRepoAdapter');

const router = express.Router();

/**
 * Profile APIs:
 * - roles context: current role (from ingestion) + target role (from Explore)
 *
 * DB-optional via repository adapters.
 */

// PUBLIC_INTERFACE
router.get('/roles', async (req, res) => {
  /**
   * Get role context for a user:
   * - currentRole: latest extracted current role (or null)
   * - targetRole: latest persisted target role selection (or null)
   *
   * Query:
   * - user_id: string (required)
   *
   * Response:
   * {
   *   status: "ok",
   *   userId: string,
   *   currentRole: { currentRoleTitle, source, updatedAt } | null,
   *   targetRole: { roleId, timeHorizon, updatedAt } | null,
   *   persistence?: { available: boolean }
   * }
   */
  const userId = String(req.query?.user_id || '').trim();
  if (!userId) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'user_id query parameter is required.',
    });
  }

  try {
    const [current, target] = await Promise.all([
      userTargetsRepo.getLatestUserCurrentRole({ userId }),
      userTargetsRepo.getLatestUserTargetRole({ userId }),
    ]);

    return res.json({
      status: 'ok',
      userId,
      currentRole: current
        ? {
            currentRoleTitle: current.currentRoleTitle ?? null,
            source: current.source || null,
            updatedAt: current.updatedAt || null,
          }
        : null,
      targetRole: target
        ? {
            roleId: target.roleId ?? null,
            timeHorizon: target.timeHorizon || null,
            updatedAt: target.updatedAt || null,
          }
        : null,
      persistence: { available: true },
    });
  } catch (e) {
    // Degrade gracefully: do not break UI boot flows, but DO log so failures aren't silent.
    // eslint-disable-next-line no-console
    console.error('[profile:/roles] Failed to load role context', {
      userId,
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
    });

    return res.json({
      status: 'ok',
      userId,
      currentRole: null,
      targetRole: null,
      persistence: { available: false },
    });
  }
});

module.exports = router;
