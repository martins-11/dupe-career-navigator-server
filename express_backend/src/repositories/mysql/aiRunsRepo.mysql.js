'use strict';

const { dbQuery } = require('../../db/connection');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL AI runs repository.
 *
 * Assumes an 'ai_runs' table exists when enabled.
 */

// PUBLIC_INTERFACE
async function createAiRun(input) {
  /** Create an ai_run row in MySQL and return it. */
  const id = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO ai_runs (
      id, build_id, persona_id, status, provider, model, request_json, response_json, error_json, created_at, updated_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      id,
      input.buildId ?? null,
      input.personaId ?? null,
      input.status ?? 'running',
      input.provider ?? 'placeholder',
      input.model ?? null,
      JSON.stringify(input.request ?? {}),
      JSON.stringify(input.response ?? null),
      JSON.stringify(input.error ?? null),
      now,
      now
    ]
  );

  return await getAiRunById(id);
}

// PUBLIC_INTERFACE
async function getAiRunById(aiRunId) {
  /** Fetch ai_run by id. Returns null if not found. */
  const res = await dbQuery(
    `
    SELECT
      id,
      build_id as buildId,
      persona_id as personaId,
      status,
      provider,
      model,
      request_json as request,
      response_json as response,
      error_json as error,
      created_at as createdAt,
      updated_at as updatedAt
    FROM ai_runs
    WHERE id = ?
    `,
    [aiRunId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function updateAiRun(aiRunId, patch) {
  /** Update mutable fields on an ai_run row. */
  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'response')) {
    sets.push('response_json = ?');
    params.push(JSON.stringify(patch.response ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
    sets.push('error_json = ?');
    params.push(JSON.stringify(patch.error ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    sets.push('model = ?');
    params.push(patch.model ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
    sets.push('provider = ?');
    params.push(patch.provider ?? null);
  }

  if (sets.length === 0) return await getAiRunById(aiRunId);

  sets.push('updated_at = ?');
  params.push(new Date());

  params.push(aiRunId);

  await dbQuery(
    `
    UPDATE ai_runs
    SET ${sets.join(', ')}
    WHERE id = ?
    `,
    params
  );

  return await getAiRunById(aiRunId);
}

// PUBLIC_INTERFACE
async function listAiRunsByBuildId(buildId) {
  /** List ai_runs for a build (ascending by created_at). */
  const res = await dbQuery(
    `
    SELECT
      id,
      build_id as buildId,
      persona_id as personaId,
      status,
      provider,
      model,
      request_json as request,
      response_json as response,
      error_json as error,
      created_at as createdAt,
      updated_at as updatedAt
    FROM ai_runs
    WHERE build_id = ?
    ORDER BY created_at ASC
    `,
    [buildId]
  );

  return res.rows;
}

module.exports = {
  createAiRun,
  getAiRunById,
  updateAiRun,
  listAiRunsByBuildId
};
