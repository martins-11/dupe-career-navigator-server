'use strict';

const { query } = require('../db/query');
const { uuidV4 } = require('../utils/uuid');

/**
 * Personas repository (scaffold).
 *
 * This repository targets the placeholder schema tables:
 * - personas
 * - persona_versions
 *
 * Requirement: safe stubs when DB env vars are not set.
 * We detect lack of DB configuration and throw a deterministic error that routes
 * translate to 503.
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
      'Database is not configured yet. Set PG_CONNECTION_STRING (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) to enable persona persistence.'
    );
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
}

// PUBLIC_INTERFACE
async function createPersona(input) {
  /** Create a persona. Optionally creates version 1 if personaJson provided. */
  ensureDbConfigured();

  const personaId = uuidV4();

  const personaRes = await query(
    `
    INSERT INTO personas (id, user_id, title)
    VALUES ($1,$2,$3)
    RETURNING
      id,
      user_id as "userId",
      title,
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    [personaId, input.userId ?? null, input.title ?? null]
  );

  const persona = personaRes.rows[0];

  // If initial JSON provided, store as version 1.
  if (input.personaJson) {
    await createPersonaVersion(personaId, { version: 1, personaJson: input.personaJson });
  }

  return persona;
}

// PUBLIC_INTERFACE
async function getPersonaById(personaId) {
  /** Fetch a persona row by id. Returns null if not found. */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      user_id as "userId",
      title,
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM personas
    WHERE id = $1
    `,
    [personaId]
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function updatePersona(personaId, patch) {
  /**
   * Update persona metadata (e.g., title).
   * Note: personaJson is versioned and should be written via createPersonaVersion().
   */
  ensureDbConfigured();

  // Build a minimal dynamic update (safe because we control column list).
  const sets = [];
  const params = [personaId];
  let idx = 2;

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    sets.push(`title = $${idx++}`);
    params.push(patch.title ?? null);
  }

  if (sets.length === 0) {
    // Nothing to update; return current persona.
    return await getPersonaById(personaId);
  }

  sets.push('updated_at = NOW()');

  const res = await query(
    `
    UPDATE personas
    SET ${sets.join(', ')}
    WHERE id = $1
    RETURNING
      id,
      user_id as "userId",
      title,
      created_at as "createdAt",
      updated_at as "updatedAt"
    `,
    params
  );

  return res.rows[0] || null;
}

// PUBLIC_INTERFACE
async function createPersonaVersion(personaId, input) {
  /**
   * Create a persona version row.
   * If version is omitted, computes next version = max(version)+1.
   */
  ensureDbConfigured();

  let version = input.version;

  if (!version) {
    const latest = await query(
      `
      SELECT version
      FROM persona_versions
      WHERE persona_id = $1
      ORDER BY version DESC
      LIMIT 1
      `,
      [personaId]
    );
    version = (latest.rows[0]?.version ?? 0) + 1;
  }

  const id = uuidV4();

  const res = await query(
    `
    INSERT INTO persona_versions (id, persona_id, version, persona_json)
    VALUES ($1,$2,$3,$4::jsonb)
    RETURNING
      id,
      persona_id as "personaId",
      version,
      persona_json as "personaJson",
      created_at as "createdAt"
    `,
    [id, personaId, version, JSON.stringify(input.personaJson)]
  );

  return res.rows[0];
}

// PUBLIC_INTERFACE
async function listPersonaVersions(personaId) {
  /** List persona versions (ascending). */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      persona_id as "personaId",
      version,
      persona_json as "personaJson",
      created_at as "createdAt"
    FROM persona_versions
    WHERE persona_id = $1
    ORDER BY version ASC
    `,
    [personaId]
  );

  return res.rows;
}

// PUBLIC_INTERFACE
async function getLatestPersonaVersion(personaId) {
  /** Get the latest persona version (highest version). Returns null if none. */
  ensureDbConfigured();

  const res = await query(
    `
    SELECT
      id,
      persona_id as "personaId",
      version,
      persona_json as "personaJson",
      created_at as "createdAt"
    FROM persona_versions
    WHERE persona_id = $1
    ORDER BY version DESC
    LIMIT 1
    `,
    [personaId]
  );

  return res.rows[0] || null;
}

module.exports = {
  isDbConfigured,
  createPersona,
  getPersonaById,
  updatePersona,
  createPersonaVersion,
  listPersonaVersions,
  getLatestPersonaVersion
};
