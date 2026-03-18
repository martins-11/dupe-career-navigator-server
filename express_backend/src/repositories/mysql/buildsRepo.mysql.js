import { dbQuery } from '../../db/connection.js';
import { uuidV4 } from '../../utils/uuid.js';

/**
 * MySQL builds repository.
 *
 * Assumes a 'builds' table exists when enabled.
 */

// PUBLIC_INTERFACE
export async function createBuild(input) {
  /** Create a build row in MySQL and return it. */
  // IMPORTANT:
  // The workflow layer (workflowService) generates the canonical build/workflow id.
  // Downstream tables (e.g., ai_runs.build_id) reference that id via FK, so this repo
  // must honor a caller-provided input.id to prevent FK failures.
  const id = input?.id || uuidV4();
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
export async function getBuildById(buildId) {
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
export async function updateBuild(buildId, patch) {
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

const buildsRepoMysql = {
  createBuild,
  getBuildById,
  updateBuild
};

export default buildsRepoMysql;
