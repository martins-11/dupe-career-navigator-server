'use strict';

const pgRepo = require('./personasRepo');
const mysqlRepo = require('./mysql/personasRepo.mysql');
const memRepo = require('./memory/personasMemoryRepo');
const { selectRepo } = require('./_repoSelector');

/**
 * Personas repository adapter:
 * - Uses in-memory persistence by default
 * - Uses MySQL implementation when DB_ENGINE=mysql AND MySQL env vars are configured
 * - Can use Postgres implementation when DB_ENGINE=postgres AND Postgres env vars are configured
 *
 * Keeps API routes stable and avoids requiring DB credentials to run.
 */

function _repo() {
  return selectRepo({ pgRepo, mysqlRepo, memRepo });
}

// PUBLIC_INTERFACE
function isDbConfiguredPublic() {
  /** Returns true if configured DB engine appears configured. */
  return isDbConfigured();
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
  const repo = _repo();
  return (repo.saveDraft || memRepo.saveDraft)(personaId, draftJson);
}

// PUBLIC_INTERFACE
async function getDraft(personaId) {
  /** Get a draft blob (in-memory; DB support can be added later). */
  const repo = _repo();
  return (repo.getDraft || memRepo.getDraft)(personaId);
}

// PUBLIC_INTERFACE
async function saveFinal(personaId, finalJson) {
  /** Save a final blob (in-memory; DB support can be added later). */
  const repo = _repo();
  return (repo.saveFinal || memRepo.saveFinal)(personaId, finalJson);
}

// PUBLIC_INTERFACE
async function getFinal(personaId) {
  /** Get a final blob (in-memory; DB support can be added later). */
  const repo = _repo();
  return (repo.getFinal || memRepo.getFinal)(personaId);
}

module.exports = {
  isDbConfigured: isDbConfiguredPublic,
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
