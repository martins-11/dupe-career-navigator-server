'use strict';

const { z } = require('zod');

/**
 * Zod models for target-role selection.
 */

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

module.exports = {
  PersonaTargetRoleSelectRequest
};
