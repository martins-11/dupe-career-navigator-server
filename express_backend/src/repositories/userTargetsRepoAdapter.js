'use strict';

const mysqlRepo = require('./mysql/userTargetsRepo.mysql');

// PUBLIC_INTERFACE
async function upsertUserTargetRole({ userId, roleId, timeHorizon }) {
  /** Persist a user's target role when MySQL is configured; otherwise no-op and return null. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return null;

  return mysqlRepo.upsertUserTargetRole({ userId, roleId, timeHorizon });
}

// PUBLIC_INTERFACE
async function getLatestUserTargetRole({ userId }) {
  /** Fetch latest user's target role when MySQL is configured; otherwise return null. */
  const { getDbEngine, isDbConfigured, isMysqlConfigured } = require('../db/connection');
  const engine = getDbEngine();
  if (!(engine === 'mysql' && isDbConfigured() && isMysqlConfigured())) return null;

  return mysqlRepo.getLatestUserTargetRole({ userId });
}

module.exports = {
  upsertUserTargetRole,
  getLatestUserTargetRole
};
