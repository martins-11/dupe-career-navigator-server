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

module.exports = {
  createPersona,
  getPersonaById,
  updatePersona,
  createPersonaVersion,
  listPersonaVersions,
  getLatestPersonaVersion
};
