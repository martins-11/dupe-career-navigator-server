'use strict';

const pgRepo = require('./personasRepo');
const memRepo = require('./memory/personasMemoryRepo');

/**
 * Personas repository adapter:
 * - Uses in-memory persistence by default
 * - Uses Postgres implementation when env vars are configured
 *
 * Keeps API routes stable and avoids requiring DB credentials to run.
 */

function _isDbConfigured() {
  return Boolean(
    (process.env.PG_CONNECTION_STRING && process.env.PG_CONNECTION_STRING.trim()) ||
      (process.env.PGHOST && process.env.PGHOST.trim()) ||
      (process.env.PGDATABASE && process.env.PGDATABASE.trim()) ||
      (process.env.PGUSER && process.env.PGUSER.trim())
  );
}

function _repo() {
  return _isDbConfigured() ? pgRepo : memRepo;
}

// PUBLIC_INTERFACE
function isDbConfigured() {
  /** Returns true if PostgreSQL appears configured. */
  return _isDbConfigured();
}

// PUBLIC_INTERFACE
async function createPersona(input) {
  /** Create a persona using configured persistence (memory by default). */
  return _repo().createPersona(input);
}

// PUBLIC_INTERFACE
async function getPersonaById(personaId) {
  /** Get persona by id using configured persistence (memory by default). */
  return _repo().getPersonaById(personaId);
}

// PUBLIC_INTERFACE
async function updatePersona(personaId, patch) {
  /** Update persona metadata using configured persistence (memory by default). */
  return _repo().updatePersona(personaId, patch);
}

// PUBLIC_INTERFACE
async function createPersonaVersion(personaId, input) {
  /** Create persona version using configured persistence (memory by default). */
  return _repo().createPersonaVersion(personaId, input);
}

// PUBLIC_INTERFACE
async function listPersonaVersions(personaId) {
  /** List persona versions using configured persistence (memory by default). */
  return _repo().listPersonaVersions(personaId);
}

// PUBLIC_INTERFACE
async function getLatestPersonaVersion(personaId) {
  /** Get latest persona version using configured persistence (memory by default). */
  return _repo().getLatestPersonaVersion(personaId);
}

// PUBLIC_INTERFACE
async function saveDraft(personaId, draftJson) {
  /** Save a draft blob (in-memory; DB support can be added later). */
  return (_repo().saveDraft || memRepo.saveDraft)(personaId, draftJson);
}

// PUBLIC_INTERFACE
async function getDraft(personaId) {
  /** Get a draft blob (in-memory; DB support can be added later). */
  return (_repo().getDraft || memRepo.getDraft)(personaId);
}

// PUBLIC_INTERFACE
async function saveFinal(personaId, finalJson) {
  /** Save a final blob (in-memory; DB support can be added later). */
  return (_repo().saveFinal || memRepo.saveFinal)(personaId, finalJson);
}

// PUBLIC_INTERFACE
async function getFinal(personaId) {
  /** Get a final blob (in-memory; DB support can be added later). */
  return (_repo().getFinal || memRepo.getFinal)(personaId);
}

module.exports = {
  isDbConfigured,
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
