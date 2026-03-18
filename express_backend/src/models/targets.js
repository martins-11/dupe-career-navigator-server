'use strict';

const { getZod } = require('../utils/zod');

/**
 * Zod models for target-role selection.
 */

let _schemasPromise;

async function _initSchemas() {
  const { z } = await getZod();

  /**
   * NOTE ON IDS:
   * - user_id is a UUID.
   * - role_id is a "role identifier" which is NOT guaranteed to be a UUID.
   *   The UI/search layer may provide stable string ids (e.g. catalog codes) and in some
   *   fallback cases may derive an id from the title.
   *
   * Therefore we validate role_id as a non-empty string, not uuid().
   */

  // PUBLIC_INTERFACE
  const PersonaTargetRoleSelectRequest = z
    .object({
      user_id: z.string().uuid().describe('User id (uuid).'),
      role_id: z.string().min(1).describe('Role identifier selected by the user (string id; not necessarily uuid).'),
      time_horizon: z
        .enum(['Near', 'Mid', 'Far'])
        .describe('Time horizon for the target role selection (Near | Mid | Far).')
    })
    .strict();

  return {
    PersonaTargetRoleSelectRequest
  };
}

// PUBLIC_INTERFACE
async function getTargetSchemas() {
  /** Lazily initialize Zod schemas without triggering ESM/CJS crashes at require-time. */
  if (!_schemasPromise) _schemasPromise = _initSchemas();
  return _schemasPromise;
}

module.exports = {
  getTargetSchemas
};
