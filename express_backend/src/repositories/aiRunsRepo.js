'use strict';

const { query } = require('../db/query');
const { uuidV4 } = require('../utils/uuid');

/**
 * AI Runs repository (PostgreSQL scaffold).
 *
 * This file preserves Postgres scaffolding for later RDS integration.
 * Runtime does not require this because aiRunsRepoAdapter defaults to memory.
 *
 * Expected future tables (not created in this task):
 * - ai_runs
 *
 * Suggested columns:
 * - id (uuid pk)
 * - build_id (uuid nullable)
 * - persona_id (uuid nullable)
 * - status (text) running|succeeded|failed
 * - provider (text, e.g. 'anthropic'|'openai'|'placeholder')
 * - model (text nullable)
 * - request_json (jsonb)
 * - response_json (jsonb)
 * - error_json (jsonb)
 * - created_at, updated_at
 */

// PUBLIC_INTERFACE
function isDbConfigured() {
  /** Returns true if any PostgreSQL connection env var appears to be set. */
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

function ensureDbConfigured() {
  if (!isDbConfigured()) {
    const err = new Error(
      'Database is not configured yet. Set PG_CONNECTION_STRING (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) to enable ai_runs persistence.'
    );
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
}

// PUBLIC_INTERFACE
async function createAiRun(input) {
  /** Create an ai_run row in Postgres and return it. */
  ensureDbConfigured();

  const id = uuidV4();

  const res = await query(
    `
    INSERT INTO ai_runs (
      id, build_id, persona_id, status, provider, model, request_json, response_json, error_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)
    RETURNING
      id,
      build_id as "buildId",
      persona_id as "personaId",
      status,
      provider,
      model,
      request_json as "request",
      response_json as "response",
      error_json as "error",
      created_at as "createdAt",
      updated_at as "updatedAt"
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
      JSON.stringify(input.error ?? null)
    ]
  );

  return res.rows[0];
}

// PUBLIC_INTERFACE
async function getAiRunById(aiRunId) {
  /** Fetch ai_run by id. Returns null if not found. */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      build_id as "buildId",
      persona_id as "personaId",
      status,
      provider,
      model,
      request_json as "request",
      response_json as "response",
      error_json as "error",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM ai_runs
    WHERE id = $1
    `,
    [aiRunId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function updateAiRun(aiRunId, patch) {
  /** Update mutable fields on an ai_run row. */
  ensureDbConfigured();

  const sets = [];
  const params = [aiRunId];
  let idx = 2;

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    sets.push(`status = $${idx++}`);
    params.push(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'response')) {
    sets.push(`response_json = $${idx++}::jsonb`);
    params.push(JSON.stringify(patch.response ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
    sets.push(`error_json = $${idx++}::jsonb`);
    params.push(JSON.stringify(patch.error ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    sets.push(`model = $${idx++}`);
    params.push(patch.model ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
    sets.push(`provider = $${idx++}`);
    params.push(patch.provider ?? null);
  }

  if (sets.length === 0) return await getAiRunById(aiRunId);

  sets.push('updated_at = NOW()');

  const res = await query(
    `
    UPDATE ai_runs
    SET ${sets.join(', ')}
    WHERE id = $1
    RETURNING
      id,
      build_id as "buildId",
      persona_id as "personaId",
      status,
      provider,
      model,
      request_json as "request",
      response_json as "response",
      error_json as "error",
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    params
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function listAiRunsByBuildId(buildId) {
  /** List ai_runs for a build (ascending by created_at). */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      build_id as "buildId",
      persona_id as "personaId",
      status,
      provider,
      model,
      request_json as "request",
      response_json as "response",
      error_json as "error",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM ai_runs
    WHERE build_id = $1
    ORDER BY created_at ASC
    `,
    [buildId]
  );

  return res.rows;
}

module.exports = {
  isDbConfigured,
  createAiRun,
  getAiRunById,
  updateAiRun,
  listAiRunsByBuildId
};
