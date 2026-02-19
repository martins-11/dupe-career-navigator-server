'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL builds repository.
 *
 * Assumes a 'builds' table exists when enabled.
 */

// PUBLIC_INTERFACE
async function createBuild(input) {
  /** Create a build row in MySQL and return it. */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO builds (
      id, persona_id, document_id, status, progress, message, current_step, steps_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?)
    `,
    [
      id,
      input.personaId ?? null,
      input.documentId ?? null,
      input.status ?? 'queued',
      input.progress ?? 0,
      input.message ?? null,
      input.currentStep ?? null,
      JSON.stringify(input.steps ?? []),
      now,
      now
    ]
  );

  return await getBuildById(id);
}

// PUBLIC_INTERFACE
async function getBuildById(buildId) {
  /** Fetch build by id. Returns null if not found. */
  const res = await dbQuery(
    `
    SELECT
      id,
      persona_id as personaId,
      document_id as documentId,
      status,
      progress,
      message,
      current_step as currentStep,
      steps_json as steps,
      created_at as createdAt,
      updated_at as updatedAt
    FROM builds
    WHERE id = ?
    `,
    [buildId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function updateBuild(buildId, patch) {
  /** Update mutable build fields. */
  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'progress')) {
    sets.push('progress = ?');
    params.push(patch.progress);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
    sets.push('message = ?');
    params.push(patch.message ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'currentStep')) {
    sets.push('current_step = ?');
    params.push(patch.currentStep ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'steps')) {
    sets.push('steps_json = ?');
    params.push(JSON.stringify(patch.steps ?? []));
  }

  if (sets.length === 0) return await getBuildById(buildId);

  sets.push('updated_at = ?');
  params.push(new Date());

  params.push(buildId);

  await dbQuery(
    `
    UPDATE builds
    SET ${sets.join(', ')}
    WHERE id = ?
    `,
    params
  );

  return await getBuildById(buildId);
}

module.exports = {
  createBuild,
  getBuildById,
  updateBuild
};
