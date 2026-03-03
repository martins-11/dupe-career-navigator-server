'use strict';

const { z } = require('zod');

/**
 * Zod models for target-role selection.
 */

// PUBLIC_INTERFACE
const PersonaTargetRoleSelectRequest = z
  .object({
    user_id: z.string().uuid().describe('User id (uuid).'),
    role_id: z.string().uuid().describe('Role id selected from roles table (uuid).'),
    time_horizon: z
      .enum(['Near', 'Mid', 'Far'])
      .describe('Time horizon for the target role selection (Near | Mid | Far).')
  })
  .strict();

module.exports = {
  PersonaTargetRoleSelectRequest
};
