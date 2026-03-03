'use strict';

const mysqlRepo = require('./mysql/holisticPersonaRepo.mysql');
const { selectRepo } = require('./_repoSelector');

/**
 * Holistic Persona repository adapter.
 *
 * This adapter is DB-optional: if MySQL isn't configured, we store artifacts in memory
 * so the service remains usable in local/dev/CI.
 *
 * We don't provide a Postgres implementation in this iteration because the request is
 * explicitly MySQL (RDS). The adapter keeps the door open for it by using selectRepo.
 */

const _memory = {
  recommendationsRoles: [],
  recommendationsCompare: [],
  pathsMultiverse: [],
  planMilestones: [],
  profileScoring: []
};

function _repo() {
  // pgRepo intentionally null for now; selectRepo will choose mysqlRepo if configured else memRepo.
  return selectRepo({ pgRepo: null, mysqlRepo, memRepo: module.exports._memRepo });
}

/**
 * Minimal in-memory repo implementation (DB-optional mode).
 * Stored as module export so _repo() can reference it.
 */
const _memRepo = {
  // PUBLIC_INTERFACE
  async upsertRecommendationsRoles(payload) {
    /** In-memory insert-only for recommendations roles. */
    const row = { id: String(Date.now()), ...payload, updatedAt: new Date().toISOString() };
    _memory.recommendationsRoles.push(row);
    return row;
  },

  // PUBLIC_INTERFACE
  async getLatestRecommendationsRoles({ userId = null, personaId = null, buildId = null }) {
    /** In-memory latest fetch by buildId/personaId/userId priority. */
    const list = _memory.recommendationsRoles;
    const match = (r) =>
      (buildId && r.buildId === buildId) ||
      (!buildId && personaId && r.personaId === personaId) ||
      (!buildId && !personaId && userId && r.userId === userId) ||
      (!buildId && !personaId && !userId);
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i])) return list[i];
    return null;
  },

  // PUBLIC_INTERFACE
  async createRecommendationsCompare(payload) {
    /** In-memory insert-only for role compare. */
    const row = { id: String(Date.now()), ...payload, createdAt: new Date().toISOString() };
    _memory.recommendationsCompare.push(row);
    return row;
  },

  // PUBLIC_INTERFACE
  async getLatestRecommendationsCompare({ buildId = null, leftRoleId, rightRoleId }) {
    /** In-memory latest fetch by buildId + pair. */
    const list = _memory.recommendationsCompare;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const r = list[i];
      if (
        (!buildId || r.buildId === buildId) &&
        r.leftRoleId === leftRoleId &&
        r.rightRoleId === rightRoleId
      ) {
        return r;
      }
    }
    return null;
  },

  // PUBLIC_INTERFACE
  async upsertPathsMultiverse(payload) {
    /** In-memory insert-only for paths. */
    const row = { id: String(Date.now()), ...payload, updatedAt: new Date().toISOString() };
    _memory.pathsMultiverse.push(row);
    return row;
  },

  // PUBLIC_INTERFACE
  async getLatestPathsMultiverse({ userId = null, personaId = null, buildId = null }) {
    /** In-memory latest fetch by buildId/personaId/userId priority. */
    const list = _memory.pathsMultiverse;
    const match = (r) =>
      (buildId && r.buildId === buildId) ||
      (!buildId && personaId && r.personaId === personaId) ||
      (!buildId && !personaId && userId && r.userId === userId) ||
      (!buildId && !personaId && !userId);
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i])) return list[i];
    return null;
  },

  // PUBLIC_INTERFACE
  async upsertPlanMilestones(payload) {
    /** In-memory insert-only for plan milestones. */
    const row = { id: String(Date.now()), ...payload, updatedAt: new Date().toISOString() };
    _memory.planMilestones.push(row);
    return row;
  },

  // PUBLIC_INTERFACE
  async getLatestPlanMilestones({ userId = null, personaId = null, buildId = null }) {
    /** In-memory latest fetch by buildId/personaId/userId priority. */
    const list = _memory.planMilestones;
    const match = (r) =>
      (buildId && r.buildId === buildId) ||
      (!buildId && personaId && r.personaId === personaId) ||
      (!buildId && !personaId && userId && r.userId === userId) ||
      (!buildId && !personaId && !userId);
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i])) return list[i];
    return null;
  },

  // PUBLIC_INTERFACE
  async upsertProfileScoring(payload) {
    /** In-memory insert-only for profile scoring. */
    const row = { id: String(Date.now()), ...payload, updatedAt: new Date().toISOString() };
    _memory.profileScoring.push(row);
    return row;
  },

  // PUBLIC_INTERFACE
  async getLatestProfileScoring({ userId = null, personaId = null, buildId = null }) {
    /** In-memory latest fetch by buildId/personaId/userId priority. */
    const list = _memory.profileScoring;
    const match = (r) =>
      (buildId && r.buildId === buildId) ||
      (!buildId && personaId && r.personaId === personaId) ||
      (!buildId && !personaId && userId && r.userId === userId) ||
      (!buildId && !personaId && !userId);
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i])) return list[i];
    return null;
  }
};

// Expose for _repo() selection
module.exports._memRepo = _memRepo;

// PUBLIC_INTERFACE
async function upsertRecommendationsRoles(payload) {
  /** Upsert recommendations roles artifacts using configured persistence (MySQL or memory). */
  return _repo().upsertRecommendationsRoles(payload);
}

// PUBLIC_INTERFACE
async function getLatestRecommendationsRoles(keys) {
  /** Get latest recommendations roles artifacts using configured persistence. */
  return _repo().getLatestRecommendationsRoles(keys);
}

// PUBLIC_INTERFACE
async function createRecommendationsCompare(payload) {
  /** Persist a role compare matrix using configured persistence. */
  return _repo().createRecommendationsCompare(payload);
}

// PUBLIC_INTERFACE
async function getLatestRecommendationsCompare(keys) {
  /** Get latest role compare matrix using configured persistence. */
  return _repo().getLatestRecommendationsCompare(keys);
}

// PUBLIC_INTERFACE
async function upsertPathsMultiverse(payload) {
  /** Upsert multiverse paths artifacts using configured persistence. */
  return _repo().upsertPathsMultiverse(payload);
}

// PUBLIC_INTERFACE
async function getLatestPathsMultiverse(keys) {
  /** Get latest multiverse paths artifacts using configured persistence. */
  return _repo().getLatestPathsMultiverse(keys);
}

// PUBLIC_INTERFACE
async function upsertPlanMilestones(payload) {
  /** Upsert milestone plan artifacts using configured persistence. */
  return _repo().upsertPlanMilestones(payload);
}

// PUBLIC_INTERFACE
async function getLatestPlanMilestones(keys) {
  /** Get latest milestone plan artifacts using configured persistence. */
  return _repo().getLatestPlanMilestones(keys);
}

// PUBLIC_INTERFACE
async function upsertProfileScoring(payload) {
  /** Upsert profile scoring artifacts using configured persistence. */
  return _repo().upsertProfileScoring(payload);
}

// PUBLIC_INTERFACE
async function getLatestProfileScoring(keys) {
  /** Get latest profile scoring artifacts using configured persistence. */
  return _repo().getLatestProfileScoring(keys);
}

module.exports = {
  _memRepo,
  upsertRecommendationsRoles,
  getLatestRecommendationsRoles,
  createRecommendationsCompare,
  getLatestRecommendationsCompare,
  upsertPathsMultiverse,
  getLatestPathsMultiverse,
  upsertPlanMilestones,
  getLatestPlanMilestones,
  upsertProfileScoring,
  getLatestProfileScoring
};
