/**
 * Zod wrapper for this backend (ESM).
 *
 * Problem:
 * - In some installations, `zod` resolves as a CommonJS module even when this app is ESM.
 * - Doing `import { z } from 'zod'` then crashes at startup with:
 *   "Named export 'z' not found. The requested module 'zod' is a CommonJS module..."
 *
 * Fix:
 * - Import Zod in an interop-safe way that works whether Zod is published/resolved as ESM or CJS.
 * - Expose a stable `{ z }` shape to the rest of the codebase.
 */

import * as zodNamespace from 'zod';

/**
 * Normalize the various possible Zod module shapes into the canonical `z` export.
 *
 * Zod can appear as:
 * - ESM:        { z, ... }
 * - CJS default: { default: { z, ... } }
 */
const z =
  /** ESM named export case */
  zodNamespace?.z ??
  /** CJS default export case */
  zodNamespace?.default?.z;

/**
 * PUBLIC_INTERFACE
 * @returns {{ z: import('zod').z }}
 */
export function getZodSync() {
  /** Synchronous access to Zod in ESM/CJS compatible mode. */
  if (!z) {
    // Fail fast with a clear error if module shape is unexpected.
    throw new Error(
      "Failed to load Zod: expected `zod` to expose `z` either as a named export or under `default.z`."
    );
  }
  return { z };
}

/**
 * PUBLIC_INTERFACE
 * @returns {Promise<{ z: import('zod').z }>}
 */
export async function getZod() {
  /** Async-compatible shim to preserve existing callsites that `await getZod()`. */
  return getZodSync();
}
