'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL repository for user_targets table.
 */

// PUBLIC_INTERFACE
async function upsertUserTargetRole({ userId, roleId, timeHorizon }) {
  /**
   * Insert a new user target role selection.
   *
   * We treat this as append-only; "latest" is determined by updated_at/created_at ordering.
   */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO user_targets (id, user_id, role_id, time_horizon, created_at, updated_at)
    VALUES (?,?,?,?,?,?)
    `,
    [id, userId, roleId, timeHorizon, now, now]
  );

  return { id, userId, roleId, timeHorizon, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

// PUBLIC_INTERFACE
async function getLatestUserTargetRole({ userId }) {
  /** Return the latest target role selection for a given user id, or null. */
  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      role_id as roleId,
      time_horizon as timeHorizon,
      created_at as createdAt,
      updated_at as updatedAt
    FROM user_targets
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return res.rows?.[0] || null;
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole
};
