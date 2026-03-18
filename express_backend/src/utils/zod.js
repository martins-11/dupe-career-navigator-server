/**
 * Zod wrapper for this backend (ESM).
 *
 * With the backend converted to native ESM ("type":"module"), Zod can be imported
 * directly without the recurring CJS/ESM interop crash.
 */

import { z } from 'zod';

/**
 * PUBLIC_INTERFACE
 * @returns {{ z: import('zod').z }}
 */
export function getZodSync() {
  /** Synchronous access to Zod in ESM mode. */
  return { z };
}

/**
 * PUBLIC_INTERFACE
 * @returns {Promise<{ z: import('zod').z }>}
 */
export async function getZod() {
  /** Async-compatible shim to preserve existing callsites that `await getZod()`. */
  return { z };
}
