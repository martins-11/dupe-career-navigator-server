'use strict';

const { z } = require('zod');

const uuid = z.string().uuid();

/**
 * Persona API models (scaffold).
 *
 * These validate payloads for persona CRUD and version history operations.
 * The backing repository is designed to be a safe stub until DB env vars exist.
 */

const PersonaCreateRequest = z.object({
  userId: uuid.nullable().optional(),
  title: z.string().min(1).nullable().optional(),
  /** Arbitrary persona JSON payload (draft). */
  personaJson: z.record(z.any()).optional()
});

const PersonaUpdateRequest = z.object({
  title: z.string().min(1).nullable().optional(),
  /**
   * Arbitrary persona JSON payload (draft/final).
   *
   * NOTE:
   * Frontends may send `null` when a field is cleared or when only metadata (title)
   * is being updated. We accept null and interpret it as "no personaJson update".
   */
  personaJson: z.record(z.any()).nullable().optional()
});

const PersonaVersionCreateRequest = z.object({
  /**
   * When omitted, repository may auto-increment from latest version.
   * This is optional in the scaffold (final behavior TBD).
   */
  version: z.number().int().positive().optional(),
  personaJson: z.record(z.any())
});

module.exports = {
  PersonaCreateRequest,
  PersonaUpdateRequest,
  PersonaVersionCreateRequest
};
