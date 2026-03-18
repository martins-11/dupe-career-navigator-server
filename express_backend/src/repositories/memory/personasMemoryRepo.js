import { uuidV4 } from '../../utils/uuid.js';

/**
 * In-memory personas repository.
 *
 * Provides:
 * - persona CRUD compatible with existing /personas routes
 * - draft/final abstractions requested by the epic (saveDraft/getDraft/saveFinal)
 *
 * This repository is process-local and does not persist across restarts.
 */

const _personas = new Map(); // personaId -> persona (metadata)
const _personaVersions = new Map(); // personaId -> versions[]
const _draftsByPersonaId = new Map(); // personaId -> draft payload
const _finalByPersonaId = new Map(); // personaId -> final payload

function _nowIso() {
  return new Date().toISOString();
}

function _ensurePersonaExists(personaId) {
  return _personas.get(personaId) || null;
}

function _nextVersion(personaId) {
  const arr = _personaVersions.get(personaId) || [];
  const latest = arr.length ? arr[arr.length - 1].version : 0;
  return latest + 1;
}

// PUBLIC_INTERFACE
export async function createPersona(input) {
  /** Create a persona. If personaJson is provided, version 1 is created. */
  const id = uuidV4();
  const now = _nowIso();

  const persona = {
    id,
    userId: input.userId ?? null,
    title: input.title ?? null,
    createdAt: now,
    updatedAt: now
  };

  _personas.set(id, persona);
  _personaVersions.set(id, []);

  if (input.personaJson) {
    await createPersonaVersion(id, { version: 1, personaJson: input.personaJson });
  }

  return persona;
}

// PUBLIC_INTERFACE
export async function getPersonaById(personaId) {
  /** Fetch a persona row by id. Returns null if not found. */
  return _personas.get(personaId) || null;
}

// PUBLIC_INTERFACE
export async function updatePersona(personaId, patch) {
  /** Update persona metadata (title). Returns updated persona or null if not found. */
  const existing = _ensurePersonaExists(personaId);
  if (!existing) return null;

  const updated = {
    ...existing,
    title: Object.prototype.hasOwnProperty.call(patch, 'title') ? (patch.title ?? null) : existing.title,
    updatedAt: _nowIso()
  };

  _personas.set(personaId, updated);
  return updated;
}

// PUBLIC_INTERFACE
export async function createPersonaVersion(personaId, input) {
  /**
   * Create a persona version row.
   * If input.version omitted, auto-increment.
   */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  const versionNumber = input.version || _nextVersion(personaId);
  const id = uuidV4();
  const now = _nowIso();

  const row = {
    id,
    personaId,
    version: versionNumber,
    personaJson: input.personaJson,
    createdAt: now
  };

  const arr = _personaVersions.get(personaId) || [];
  // Keep list sorted ascending by version.
  arr.push(row);
  arr.sort((a, b) => a.version - b.version);
  _personaVersions.set(personaId, arr);

  return row;
}

// PUBLIC_INTERFACE
export async function listPersonaVersions(personaId) {
  /** List persona versions (ascending). Returns [] if persona exists but no versions. */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;
  return _personaVersions.get(personaId) || [];
}

// PUBLIC_INTERFACE
export async function getLatestPersonaVersion(personaId) {
  /** Get the latest persona version (highest version). Returns null if persona not found or no versions. */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  const arr = _personaVersions.get(personaId) || [];
  if (arr.length === 0) return null;
  return arr[arr.length - 1];
}

/**
 * Draft/final abstractions (epic requirement).
 * These are intentionally simple wrappers on top of persona versions for now.
 */

// PUBLIC_INTERFACE
export async function saveDraft(personaId, draftJson) {
  /** Save a draft persona JSON blob (in-memory). */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  const payload = {
    personaId,
    draftJson,
    updatedAt: _nowIso()
  };
  _draftsByPersonaId.set(personaId, payload);
  return payload;
}

// PUBLIC_INTERFACE
export async function getDraft(personaId) {
  /** Get the latest saved draft for a persona (in-memory). */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  return _draftsByPersonaId.get(personaId) || null;
}

// PUBLIC_INTERFACE
export async function saveFinal(personaId, finalJson) {
  /** Save a final persona JSON blob (in-memory). */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  const payload = {
    personaId,
    finalJson,
    updatedAt: _nowIso()
  };
  _finalByPersonaId.set(personaId, payload);
  return payload;
}

// PUBLIC_INTERFACE
export async function getFinal(personaId) {
  /** Get the saved final persona JSON blob (in-memory). */
  const persona = _ensurePersonaExists(personaId);
  if (!persona) return null;

  return _finalByPersonaId.get(personaId) || null;
}

const personasMemoryRepo = {
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

export default personasMemoryRepo;
