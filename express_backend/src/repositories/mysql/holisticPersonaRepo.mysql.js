'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL repository for Holistic Persona /api endpoint persistence.
 *
 * Tables:
 * - recommendations_roles
 * - recommendations_compare
 * - paths_multiverse
 * - plan_milestones
 * - profile_scoring
 */

function _jsonParseIfNeeded(v) {
  if (v == null) return v;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return v;
    }
  }
  return v;
}

// PUBLIC_INTERFACE
async function upsertRecommendationsRoles({ userId = null, personaId = null, buildId = null, inferredTags = [], roles }) {
  /** Upsert "latest roles recommendations" for a given build/persona/user. */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO recommendations_roles (
      id, user_id, persona_id, build_id, inferred_tags_json, roles_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?)
    `,
    [id, userId, personaId, buildId, JSON.stringify(inferredTags || []), JSON.stringify(roles || []), now, now]
  );

  return { id, userId, personaId, buildId, inferredTags, roles, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

// PUBLIC_INTERFACE
async function getLatestRecommendationsRoles({ userId = null, personaId = null, buildId = null }) {
  /** Get latest role recommendations row matching the most specific identifier provided (buildId > personaId > userId). */
  let where = '1=1';
  const params = [];

  if (buildId) {
    where = 'build_id = ?';
    params.push(buildId);
  } else if (personaId) {
    where = 'persona_id = ?';
    params.push(personaId);
  } else if (userId) {
    where = 'user_id = ?';
    params.push(userId);
  }

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      persona_id as personaId,
      build_id as buildId,
      inferred_tags_json as inferredTags,
      roles_json as roles,
      created_at as createdAt,
      updated_at as updatedAt
    FROM recommendations_roles
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    params
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  return {
    ...row,
    inferredTags: _jsonParseIfNeeded(row.inferredTags) || [],
    roles: _jsonParseIfNeeded(row.roles) || []
  };
}

// PUBLIC_INTERFACE
async function createRecommendationsCompare({ userId = null, personaId = null, buildId = null, leftRoleId, rightRoleId, comparison }) {
  /** Persist a role comparison matrix result. */
  const id = uuidV4();

  await dbQuery(
    `
    INSERT INTO recommendations_compare (
      id, user_id, persona_id, build_id, left_role_id, right_role_id, comparison_json, created_at
    )
    VALUES (?,?,?,?,?,?,?,?)
    `,
    [id, userId, personaId, buildId, leftRoleId, rightRoleId, JSON.stringify(comparison || {}), new Date()]
  );

  return { id, userId, personaId, buildId, leftRoleId, rightRoleId, comparison };
}

// PUBLIC_INTERFACE
async function getLatestRecommendationsCompare({ buildId = null, leftRoleId, rightRoleId }) {
  /** Fetch latest comparison for a buildId + (left,right). If buildId omitted, fetch latest overall for pair. */
  const where = [];
  const params = [];

  if (buildId) {
    where.push('build_id = ?');
    params.push(buildId);
  }
  where.push('left_role_id = ?');
  params.push(leftRoleId);
  where.push('right_role_id = ?');
  params.push(rightRoleId);

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      persona_id as personaId,
      build_id as buildId,
      left_role_id as leftRoleId,
      right_role_id as rightRoleId,
      comparison_json as comparison,
      created_at as createdAt
    FROM recommendations_compare
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT 1
    `,
    params
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  return { ...row, comparison: _jsonParseIfNeeded(row.comparison) || {} };
}

// PUBLIC_INTERFACE
async function upsertPathsMultiverse({ userId = null, personaId = null, buildId = null, paths }) {
  /** Persist paths multiverse results. */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO paths_multiverse (
      id, user_id, persona_id, build_id, paths_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?)
    `,
    [id, userId, personaId, buildId, JSON.stringify(paths || []), now, now]
  );

  return { id, userId, personaId, buildId, paths, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

// PUBLIC_INTERFACE
async function getLatestPathsMultiverse({ userId = null, personaId = null, buildId = null }) {
  /** Get latest paths multiverse row matching buildId/personaId/userId priority. */
  let where = '1=1';
  const params = [];

  if (buildId) {
    where = 'build_id = ?';
    params.push(buildId);
  } else if (personaId) {
    where = 'persona_id = ?';
    params.push(personaId);
  } else if (userId) {
    where = 'user_id = ?';
    params.push(userId);
  }

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      persona_id as personaId,
      build_id as buildId,
      paths_json as paths,
      created_at as createdAt,
      updated_at as updatedAt
    FROM paths_multiverse
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    params
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  return { ...row, paths: _jsonParseIfNeeded(row.paths) || [] };
}

// PUBLIC_INTERFACE
async function upsertPlanMilestones({ userId = null, personaId = null, buildId = null, goal, timeframeWeeks, focus = null, milestones }) {
  /** Persist a milestones plan. */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO plan_milestones (
      id, user_id, persona_id, build_id, goal, timeframe_weeks, focus, milestones_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?)
    `,
    [id, userId, personaId, buildId, goal, Number(timeframeWeeks) || 0, focus, JSON.stringify(milestones || []), now, now]
  );

  return {
    id,
    userId,
    personaId,
    buildId,
    goal,
    timeframeWeeks,
    focus,
    milestones,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

// PUBLIC_INTERFACE
async function getLatestPlanMilestones({ userId = null, personaId = null, buildId = null }) {
  /** Get latest milestones plan for build/persona/user priority. */
  let where = '1=1';
  const params = [];

  if (buildId) {
    where = 'build_id = ?';
    params.push(buildId);
  } else if (personaId) {
    where = 'persona_id = ?';
    params.push(personaId);
  } else if (userId) {
    where = 'user_id = ?';
    params.push(userId);
  }

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      persona_id as personaId,
      build_id as buildId,
      goal,
      timeframe_weeks as timeframeWeeks,
      focus,
      milestones_json as milestones,
      created_at as createdAt,
      updated_at as updatedAt
    FROM plan_milestones
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    params
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  return { ...row, milestones: _jsonParseIfNeeded(row.milestones) || [] };
}

// PUBLIC_INTERFACE
async function upsertProfileScoring({ userId = null, personaId = null, buildId = null, scoring }) {
  /** Persist profile scoring JSON (including overrides). */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO profile_scoring (
      id, user_id, persona_id, build_id, scoring_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?)
    `,
    [id, userId, personaId, buildId, JSON.stringify(scoring || {}), now, now]
  );

  return { id, userId, personaId, buildId, scoring, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

// PUBLIC_INTERFACE
async function getLatestProfileScoring({ userId = null, personaId = null, buildId = null }) {
  /** Get latest profile scoring row for build/persona/user priority. */
  let where = '1=1';
  const params = [];

  if (buildId) {
    where = 'build_id = ?';
    params.push(buildId);
  } else if (personaId) {
    where = 'persona_id = ?';
    params.push(personaId);
  } else if (userId) {
    where = 'user_id = ?';
    params.push(userId);
  }

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      persona_id as personaId,
      build_id as buildId,
      scoring_json as scoring,
      created_at as createdAt,
      updated_at as updatedAt
    FROM profile_scoring
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    params
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  return { ...row, scoring: _jsonParseIfNeeded(row.scoring) || {} };
}

module.exports = {
  upsertRecommendationsRoles,
  getLatestRecommendationsRoles,
  createRecommendationsCompare,
  getLatestRecommendationsCompare,
  upsertPathsMultiverse,
  getLatestPathsMultiverse,
  upsertPlanMilestones,
  getLatestPlanMilestones,
  upsertProfileScoring,
  getLatestProfileScoring
};
