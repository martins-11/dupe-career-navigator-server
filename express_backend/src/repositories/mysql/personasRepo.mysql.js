'use strict';

const { dbQuery } = require('../../db/connection');
const { ensureMysqlSchemaCompatible } = require('../../db/schemaSelfHeal');
const { uuidV4 } = require('../../utils/uuid');

/**
 * MySQL repository for:
 * - personas
 * - persona_versions
 *
 * Assumes schema exists when enabled.
 */

// PUBLIC_INTERFACE
async function createPersona(input) {
  /** Create a persona. Optionally creates version 1 if personaJson provided. */
  const personaId = uuidV4();
  const now = new Date();

  await dbQuery(
    `
    INSERT INTO personas (id, user_id, title, created_at, updated_at)
    VALUES (?,?,?,?,?)
    `,
    [personaId, input.userId ?? null, input.title ?? null, now, now]
  );

  if (input.personaJson) {
    await createPersonaVersion(personaId, { version: 1, personaJson: input.personaJson });
  }

  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      title,
      created_at as createdAt,
      updated_at as updatedAt
    FROM personas
    WHERE id = ?
    `,
    [personaId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function getPersonaById(personaId) {
  /** Fetch a persona row by id. Returns null if not found. */
  const res = await dbQuery(
    `
    SELECT
      id,
      user_id as userId,
      title,
      created_at as createdAt,
      updated_at as updatedAt
    FROM personas
    WHERE id = ?
    `,
    [personaId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function updatePersona(personaId, patch) {
  /**
   * Update persona metadata (e.g., title).
   * personaJson is versioned and should be written via createPersonaVersion().
   */
  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    sets.push('title = ?');
    params.push(patch.title ?? null);
  }

  if (sets.length === 0) return await getPersonaById(personaId);

  sets.push('updated_at = ?');
  params.push(new Date());

  params.push(personaId);

  await dbQuery(
    `
    UPDATE personas
    SET ${sets.join(', ')}
    WHERE id = ?
    `,
    params
  );

  return await getPersonaById(personaId);
}

// PUBLIC_INTERFACE
async function createPersonaVersion(personaId, input) {
  /**
   * Create a persona version row.
   * If version is omitted, computes next version = max(version)+1.
   */
  let version = input.version;

  if (!version) {
    const latest = await dbQuery(
      `
      SELECT version
      FROM persona_versions
      WHERE persona_id = ?
      ORDER BY version DESC
      LIMIT 1
      `,
      [personaId]
    );
    version = (latest.rows[0]?.version ?? 0) + 1;
  }

  const id = uuidV4();

  await dbQuery(
    `
    INSERT INTO persona_versions (id, persona_id, version, persona_json, created_at)
    VALUES (?,?,?,?,?)
    `,
    [id, personaId, version, JSON.stringify(input.personaJson), new Date()]
  );

  const res = await dbQuery(
    `
    SELECT
      id,
      persona_id as personaId,
      version,
      persona_json as personaJson,
      created_at as createdAt
    FROM persona_versions
    WHERE id = ?
    `,
    [id]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function listPersonaVersions(personaId) {
  /** List persona versions (ascending). */
  const res = await dbQuery(
    `
    SELECT
      id,
      persona_id as personaId,
      version,
      persona_json as personaJson,
      created_at as createdAt
    FROM persona_versions
    WHERE persona_id = ?
    ORDER BY version ASC
    `,
    [personaId]
  );

  return res.rows;
}

// PUBLIC_INTERFACE
async function getLatestPersonaVersion(personaId) {
  /** Get the latest persona version (highest version). Returns null if none. */
  const res = await dbQuery(
    `
    SELECT
      id,
      persona_id as personaId,
      version,
      persona_json as personaJson,
      created_at as createdAt
    FROM persona_versions
    WHERE persona_id = ?
    ORDER BY version DESC
    LIMIT 1
    `,
    [personaId]
  );

  return res.rows[0] || null;
}

/**
 * Draft/final persistence (epic requirement)
 *
 * These tables are separate from the personas/persona_versions history:
 * - persona_drafts(id, persona_draft_json, alignment_score, created_at)
 * - persona_final(id, persona_final_json, alignment_score, created_at)
 *
 * The adapter layer (personasRepoAdapter) will call these methods when available.
 */

// PUBLIC_INTERFACE
async function saveDraft(personaId, draftJson) {
  /** Save a persona draft JSON blob to MySQL persona_drafts (persona-scoped), returning a small payload. */
  const id = uuidV4();
  const pid = String(personaId || '').trim();
  if (!pid) {
    const err = new Error('personaId is required to save a draft.');
    err.code = 'INVALID_PERSONA_ID';
    err.httpStatus = 400;
    throw err;
  }

  // Runtime-safe guard: if schema drift exists (persona_id missing), self-heal before executing.
  await ensureMysqlSchemaCompatible();

  await dbQuery(
    `
    INSERT INTO persona_drafts (id, persona_id, persona_draft_json, alignment_score, created_at)
    VALUES (?,?,?,?,?)
    `,
    [id, pid, JSON.stringify(draftJson ?? {}), 0, new Date()]
  );

  return {
    personaId: pid,
    draftId: id,
    draftJson,
    updatedAt: new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function getDraft(personaId) {
  /** Get the latest saved draft for a persona (strict personaId-scoped lookup). */
  const pid = String(personaId || '').trim();
  if (!pid) return null;

  // Runtime-safe guard: if schema drift exists (persona_id missing), self-heal before executing.
  await ensureMysqlSchemaCompatible();

  const res = await dbQuery(
    `
    SELECT id, persona_draft_json as draftJson, created_at as createdAt
    FROM persona_drafts
    WHERE persona_id = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [pid]
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  let draftJson = row.draftJson;
  if (typeof draftJson === 'string') {
    try {
      draftJson = JSON.parse(draftJson);
    } catch (_) {
      // leave as string if parsing fails
    }
  }

  return {
    personaId: pid,
    draftId: row.id,
    draftJson,
    updatedAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function saveFinal(personaId, finalJson) {
  /** Save a persona final JSON blob to MySQL persona_final (persona-scoped), returning a small payload. */
  const id = uuidV4();
  const pid = String(personaId || '').trim();
  if (!pid) {
    const err = new Error('personaId is required to save a final persona.');
    err.code = 'INVALID_PERSONA_ID';
    err.httpStatus = 400;
    throw err;
  }

  await dbQuery(
    `
    INSERT INTO persona_final (id, persona_id, persona_final_json, alignment_score, created_at)
    VALUES (?,?,?,?,?)
    `,
    [id, pid, JSON.stringify(finalJson ?? {}), 0, new Date()]
  );

  return {
    personaId: pid,
    finalId: id,
    finalJson,
    updatedAt: new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function getFinal(personaId) {
  /**
   * Get the latest finalized persona for a given personaId (strict personaId-scoped lookup).
   *
   * NOTE:
   * - persona_versions are version history; persona_final is the explicit "finalized" artifact.
   * - This method returns ONLY persona_final to ensure /api/recommendations/initial uses the true finalized persona.
   */
  const pid = String(personaId || '').trim();
  if (!pid) return null;

  const res = await dbQuery(
    `
    SELECT
      id,
      persona_id as personaId,
      persona_final_json as finalJson,
      created_at as createdAt
    FROM persona_final
    WHERE persona_id = ?
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [pid]
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  let finalJson = row.finalJson;
  if (typeof finalJson === 'string') {
    try {
      finalJson = JSON.parse(finalJson);
    } catch (_) {
      // leave as string if parsing fails
    }
  }

  return {
    personaId: pid,
    finalId: row.id,
    finalJson,
    updatedAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString()
  };
}

module.exports = {
  createPersona,
  getPersonaById,
  updatePersona,
  createPersonaVersion,
  listPersonaVersions,
  getLatestPersonaVersion,
  saveDraft,
  getDraft,
  saveFinal,
  getFinal
};
