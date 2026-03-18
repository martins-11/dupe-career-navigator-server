'use strict';

import { getZod } from '../utils/zod.js';

/**
 * Persona API models (scaffold).
 *
 * These validate payloads for persona CRUD and version history operations.
 *
 * IMPORTANT:
 * - This backend runs as ESM (`"type": "module"`). Therefore this file must use ESM exports.
 * - Routes expect to synchronously call `.safeParse(...)` on the exported schemas.
 * - Zod is loaded lazily to avoid require-time module-shape issues.
 */

let _schemasPromise;

/**
 * Internal: initialize and return the concrete Zod schemas.
 * @returns {Promise<{PersonaCreateRequest:any, PersonaUpdateRequest:any, PersonaVersionCreateRequest:any}>}
 */
async function _initSchemas() {
  const { z } = await getZod();

  const uuid = z.string().uuid();

  const PersonaCreateRequest = z.object({
    userId: uuid.nullable().optional(),
    title: z.string().min(1).nullable().optional(),
    /** Arbitrary persona JSON payload (draft). */
    personaJson: z.record(z.any()).optional()
  });

  const PersonaUpdateRequest = z.object({
    /**
     * Title is optional + nullable.
     *
     * UI inputs often emit an empty string when a user clears the field.
     * Treat "" as null so we don't reject otherwise-valid updates with a 400.
     */
    title: z.preprocess(
      (v) => (typeof v === 'string' && v.trim().length === 0 ? null : v),
      z.string().min(1).nullable().optional()
    ),
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

  return {
    PersonaCreateRequest,
    PersonaUpdateRequest,
    PersonaVersionCreateRequest
  };
}

// PUBLIC_INTERFACE
export async function getPersonaSchemas() {
  /** Lazily initialize Zod schemas without triggering module-shape crashes at import-time. */
  if (!_schemasPromise) _schemasPromise = _initSchemas();
  return _schemasPromise;
}

/**
 * Create an ESM-exported proxy that looks like a Zod schema and supports:
 * - safeParse(...)
 * - parse(...)
 *
 * while deferring actual schema construction until first use.
 *
 * This matches how routes are currently written:
 *   const parsed = PersonaCreateRequest.safeParse(req.body)
 *
 * @param {keyof Awaited<ReturnType<typeof getPersonaSchemas>>} schemaKey
 * @returns {Proxy}
 */
function lazySchema(schemaKey) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Allow awaiting the schema if someone chooses to.
        if (prop === 'then') return undefined;

        // Common Zod usage.
        if (prop === 'safeParse' || prop === 'parse') {
          return (...args) =>
            getPersonaSchemas().then((schemas) => {
              const schema = schemas[schemaKey];
              const fn = schema[prop].bind(schema);
              return fn(...args);
            });
        }

        // For anything else, return an async accessor.
        return (...args) =>
          getPersonaSchemas().then((schemas) => {
            const schema = schemas[schemaKey];
            const v = schema[prop];
            if (typeof v === 'function') return v.apply(schema, args);
            if (args.length === 0) return v;
            throw new Error(`Unsupported access: ${String(prop)}(${args.length} args) on ${schemaKey}`);
          });
      }
    }
  );
}

// PUBLIC_INTERFACE
export const PersonaCreateRequest = lazySchema('PersonaCreateRequest');

// PUBLIC_INTERFACE
export const PersonaUpdateRequest = lazySchema('PersonaUpdateRequest');

// PUBLIC_INTERFACE
export const PersonaVersionCreateRequest = lazySchema('PersonaVersionCreateRequest');

export default {
  getPersonaSchemas,
  PersonaCreateRequest,
  PersonaUpdateRequest,
  PersonaVersionCreateRequest
};
