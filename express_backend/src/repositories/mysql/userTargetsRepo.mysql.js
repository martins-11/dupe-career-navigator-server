'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL repository for user_targets table.
 *
 * Table supports two independent concepts:
 * - target role selection: (role_id, time_horizon)
 * - current role extraction: (current_role_title, current_role_source)
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
    INSERT INTO user_targets (
      id, user_id,
      role_id, time_horizon,
      current_role_title, current_role_source,
      created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?)
    `,
    [id, userId, roleId, timeHorizon, null, null, now, now]
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
    WHERE user_id = ? AND role_id IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return res.rows?.[0] || null;
}

// PUBLIC_INTERFACE
async function upsertUserCurrentRole({ userId, currentRoleTitle, source = 'bedrock' }) {
  /**
   * Insert a new "current role" extraction record for the user.
   * Append-only; latest is most recent.
   */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO user_targets (
      id, user_id,
      role_id, time_horizon,
      current_role_title, current_role_source,
      created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?)
    `,
    [id, userId, null, null, currentRoleTitle, source, now, now]
  );

  return {
    id,
    userId,
    currentRoleTitle,
    source,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

// PUBLIC_INTERFACE
async function getLatestUserCurrentRole({ userId }) {
  /** Return the latest current role extraction for a given user id, or null. */
  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      current_role_title as currentRoleTitle,
      current_role_source as source,
      created_at as createdAt,
      updated_at as updatedAt
    FROM user_targets
    WHERE user_id = ? AND current_role_title IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return res.rows?.[0] || null;
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole,
  upsertUserCurrentRole,
  getLatestUserCurrentRole,
};
