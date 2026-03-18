/**
 * Zod models for target-role selection (ESM).
 *
 * IMPORTANT:
 * - This backend runs with `"type": "module"` on Node 18.
 * - Any lingering CommonJS `require/module.exports` usage inside `src/` will cause
 *   hard-to-debug ESM interop failures (including missing named exports).
 */

import { getZod } from '../utils/zod.js';

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
      role_id: z
        .string()
        .min(1)
        .describe('Role identifier selected by the user (string id; not necessarily uuid).'),
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
export async function getTargetSchemas() {
  /** Lazily initialize Zod schemas without triggering ESM/CJS crashes at import-time. */
  if (!_schemasPromise) _schemasPromise = _initSchemas();
  return _schemasPromise;
}

/**
 * Proxy helper to avoid making every callsite `await getTargetSchemas()` just to validate.
 * This mirrors the pattern used by other models in this repo.
 */
function createSchemaProxy(schemaName) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined; // prevent thenable confusion
        return async (...args) => {
          const schemas = await getTargetSchemas();
          const schema = schemas?.[schemaName];
          if (!schema) {
            throw new Error(`[models/targets] Schema not initialized or missing: ${schemaName}`);
          }
          const fn = schema[prop];
          if (typeof fn !== 'function') return fn;
          return fn.apply(schema, args);
        };
      }
    }
  );
}

/**
 * PUBLIC_INTERFACE
 * Named export used by routes/personas.js.
 */
export const PersonaTargetRoleSelectRequest = createSchemaProxy('PersonaTargetRoleSelectRequest');
