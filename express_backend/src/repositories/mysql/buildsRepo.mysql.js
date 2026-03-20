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

/**
 * PUBLIC_INTERFACE
 * Link a single document to a build (best-effort).
 *
 * Expected table (when present):
 * - build_documents(build_id, document_id, created_at)
 *
 * Hardening behavior:
 * - If the table does not exist yet (older schema), this is a no-op (does not throw),
 *   so orchestration remains usable.
 */
export async function linkDocumentToBuild(buildId, documentId) {
  try {
    await dbQuery(
      `
      INSERT INTO build_documents (build_id, document_id, created_at)
      VALUES (?,?,?)
      `,
      [buildId, documentId, new Date()]
    );
    return { linked: true };
  } catch (err) {
    // Table missing or constraint violations should not break MVP flows.
    const msg = String(err?.message || '').toLowerCase();
    const code = String(err?.code || '').toUpperCase();

    // Common MySQL “table doesn't exist” patterns:
    if (code === 'ER_NO_SUCH_TABLE' || msg.includes("doesn't exist") || msg.includes('no such table')) {
      return { linked: false, reason: 'TABLE_MISSING' };
    }

    // Duplicate link is fine; treat as linked.
    if (code === 'ER_DUP_ENTRY' || msg.includes('duplicate')) {
      return { linked: true, deduped: true };
    }

    // Any other error: still no-op to preserve DB-optional behavior.
    return { linked: false, reason: 'LINK_FAILED' };
  }
}

/**
 * PUBLIC_INTERFACE
 * Link multiple documents to a build (best-effort).
 */
export async function linkDocumentsToBuild(buildId, documentIds) {
  const ids = Array.isArray(documentIds) ? documentIds.filter(Boolean) : [];
  let linkedCount = 0;

  // eslint-disable-next-line no-await-in-loop
  for (const documentId of ids) {
    const res = await linkDocumentToBuild(buildId, documentId);
    if (res && res.linked) linkedCount += 1;
  }

  return { linked: linkedCount > 0, count: linkedCount };
}

const buildsRepoMysql = {
  createBuild,
  getBuildById,
  updateBuild,
  linkDocumentToBuild,
  linkDocumentsToBuild
};

export default buildsRepoMysql;
