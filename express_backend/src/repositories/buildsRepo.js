import { query } from '../db/query.js';
import { uuidV4 } from '../utils/uuid.js';

/**
 * Builds repository (PostgreSQL scaffold).
 *
 * This file intentionally keeps a Postgres-shaped implementation for later AWS RDS integration.
 * It is NOT required for runtime today because buildsRepoAdapter defaults to memory unless DB env vars are set.
 *
 * Expected future tables (not created in this task):
 * - builds
 *
 * Suggested columns:
 * - id (uuid pk)
 * - persona_id (uuid nullable)
 * - document_id (uuid nullable)
 * - status (text)
 * - progress (int)
 * - message (text nullable)
 * - current_step (text nullable)
 * - steps_json (jsonb)
 * - created_at, updated_at
 */

// PUBLIC_INTERFACE
export function isDbConfigured() {
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
      'Database is not configured yet. Set PG_CONNECTION_STRING (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) to enable builds persistence.'
    );
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
}

// PUBLIC_INTERFACE
export async function createBuild(input) {
  /**
   * Create a build row in Postgres and return it.
   * NOTE: This is scaffold SQL; schema/table may evolve.
   */
  ensureDbConfigured();

  const id = uuidV4();

  const res = await query(
    `
    INSERT INTO builds (
      id, persona_id, document_id, status, progress, message, current_step, steps_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    RETURNING
      id,
      persona_id as "personaId",
      document_id as "documentId",
      status,
      progress,
      message,
      current_step as "currentStep",
      steps_json as "steps",
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    [
      id,
      input.personaId ?? null,
      input.documentId ?? null,
      input.status ?? 'queued',
      input.progress ?? 0,
      input.message ?? null,
      input.currentStep ?? null,
      JSON.stringify(input.steps ?? [])
    ]
  );

  return res.rows[0];
}

// PUBLIC_INTERFACE
export async function getBuildById(buildId) {
  /** Fetch build by id. Returns null if not found. */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      persona_id as "personaId",
      document_id as "documentId",
      status,
      progress,
      message,
      current_step as "currentStep",
      steps_json as "steps",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM builds
    WHERE id = $1
    `,
    [buildId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
export async function updateBuild(buildId, patch) {
  /**
   * Update mutable build fields.
   * NOTE: dynamic SQL kept minimal and restricted to known columns.
   */
  ensureDbConfigured();

  const sets = [];
  const params = [buildId];
  let idx = 2;

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    sets.push(`status = $${idx++}`);
    params.push(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'progress')) {
    sets.push(`progress = $${idx++}`);
    params.push(patch.progress);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
    sets.push(`message = $${idx++}`);
    params.push(patch.message ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'currentStep')) {
    sets.push(`current_step = $${idx++}`);
    params.push(patch.currentStep ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'steps')) {
    sets.push(`steps_json = $${idx++}::jsonb`);
    params.push(JSON.stringify(patch.steps ?? []));
  }

  if (sets.length === 0) return await getBuildById(buildId);

  sets.push('updated_at = NOW()');

  const res = await query(
    `
    UPDATE builds
    SET ${sets.join(', ')}
    WHERE id = $1
    RETURNING
      id,
      persona_id as "personaId",
      document_id as "documentId",
      status,
      progress,
      message,
      current_step as "currentStep",
      steps_json as "steps",
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    params
  );

  return res.rows[0] || null;
}

const buildsRepo = {
  isDbConfigured,
  createBuild,
  getBuildById,
  updateBuild
};

export default buildsRepo;
