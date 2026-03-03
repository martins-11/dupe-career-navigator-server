'use strict';

const mysqlRepo = require('./mysql/rolesRepo.mysql');

// PUBLIC_INTERFACE
async function countRoles() {
  /** Return roles count when MySQL is configured; otherwise return 0. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return 0;
  return mysqlRepo.countRoles();
}

// PUBLIC_INTERFACE
async function listRoles({ limit = 1000 } = {}) {
  /** List roles when MySQL is configured; otherwise return []. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return [];
  return mysqlRepo.listRoles({ limit });
}

// PUBLIC_INTERFACE
async function bulkInsertRoles(roles) {
  /** Bulk insert roles when MySQL is configured; otherwise no-op. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return { inserted: 0 };
  return mysqlRepo.bulkInsertRoles(roles);
}

// PUBLIC_INTERFACE
async function roleExists(roleId) {
  /** Return true if role exists when MySQL is configured; otherwise false. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return false;
  return mysqlRepo._roleExists(roleId);
}

 // PUBLIC_INTERFACE
async function searchRoles({ q = '', industry = null, skills = [], minSalary = null, maxSalary = null, limit = 50 } = {}) {
  /**
   * Search roles via MySQL when DB_ENGINE=mysql.
   *
   * IMPORTANT:
   * Historically this adapter hard-gated on isDbConfigured()/isMysqlConfigured(), which can
   * false-negative in some environments (env var naming differences, partial config, etc.).
   * That caused /api/roles/search to return [] even though DB queries were succeeding.
   *
   * We now:
   * - Attempt the MySQL query whenever engine=mysql.
   * - Return [] only if the query throws (route may fall back to memory catalog).
   */
  const { getDbEngine } = require('../db/connection');
  const engine = getDbEngine();

  if (engine !== 'mysql') return [];

  try {
    return await mysqlRepo.searchRoles({ q, industry, skills, minSalary, maxSalary, limit });
  } catch (_) {
    return [];
  }
}

module.exports = {
  countRoles,
  listRoles,
  bulkInsertRoles,
  roleExists,
  searchRoles
};
