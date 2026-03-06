'use strict';

const { dbQuery } = require('../../db/connection');
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
  /** Save a persona draft JSON blob to MySQL persona_drafts, returning a small payload. */
  const id = uuidV4();

  await dbQuery(
    `
    INSERT INTO persona_drafts (id, persona_draft_json, alignment_score, created_at)
    VALUES (?,?,?,?)
    `,
    [id, JSON.stringify(draftJson ?? {}), 0, new Date()]
  );

  return {
    personaId,
    draftId: id,
    draftJson,
    updatedAt: new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function getDraft(personaId) {
  /** Get the latest saved draft for a persona. (Best-effort mapping; personaId isn't stored in table.) */
  // Schema note: persona_drafts table doesn't include persona_id in this scaffold.
  // Minimal behavior: return the latest draft row overall.
  const res = await dbQuery(
    `
    SELECT id, persona_draft_json as draftJson, created_at as createdAt
    FROM persona_drafts
    ORDER BY created_at DESC
    LIMIT 1
    `
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
    personaId,
    draftId: row.id,
    draftJson,
    updatedAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function saveFinal(personaId, finalJson) {
  /** Save a persona final JSON blob to MySQL persona_final, returning a small payload. */
  const id = uuidV4();

  await dbQuery(
    `
    INSERT INTO persona_final (id, persona_final_json, alignment_score, created_at)
    VALUES (?,?,?,?)
    `,
    [id, JSON.stringify(finalJson ?? {}), 0, new Date()]
  );

  return {
    personaId,
    finalId: id,
    finalJson,
    updatedAt: new Date().toISOString()
  };
}

// PUBLIC_INTERFACE
async function getFinal(personaId) {
  /**
   * Get the best available "finalized persona" for a given personaId.
   *
   * IMPORTANT:
   * - The scaffolded persona_final table does not include persona_id, so a strict lookup is impossible there.
   * - To keep /api/recommendations/initial truly persona-driven, we DO NOT return "latest overall" anymore.
   *
   * Resolution strategy:
   * 1) Prefer latest persona_versions.persona_json for the given personaId (canonical per-persona history).
   * 2) If none exists, return null (caller can 404).
   *
   * This preserves personaId semantics and prevents cross-persona contamination.
   */
  const id = String(personaId || '').trim();
  if (!id) return null;

  // Prefer latest versioned persona JSON for this personaId.
  const v = await getLatestPersonaVersion(id);
  if (v && v.personaJson != null) {
    let personaJson = v.personaJson;
    if (typeof personaJson === 'string') {
      try {
        personaJson = JSON.parse(personaJson);
      } catch (_) {
        // leave as string if parsing fails
      }
    }

    return {
      personaId: id,
      finalId: v.id,
      finalJson: personaJson,
      updatedAt: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString()
    };
  }

  return null;
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
