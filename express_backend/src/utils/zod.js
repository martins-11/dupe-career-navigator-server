'use strict';

/**
 * Zod import compatibility wrapper.
 *
 * Some Zod package configurations (or Node resolution behaviors) can cause
 * `require('zod')` from a CommonJS project to load an ESM entrypoint, which then
 * crashes with:
 *   "SyntaxError: Cannot use import statement outside a module"
 *
 * This backend is intentionally CommonJS (Node 18). To make Zod usage robust in
 * both environments, we:
 *  - Prefer `require('zod')` (fast path when CJS-compatible entrypoint exists)
 *  - Fall back to dynamic `import('zod')` (supported from CJS in Node 18)
 *
 * Callers should `await getZod()` and then use `{ z }`.
 */

let _zodPromise;

/**
 * PUBLIC_INTERFACE
 * @returns {Promise<{ z: import('zod').z }>} resolves to an object containing Zod's `z`.
 */
async function getZod() {
  if (_zodPromise) return _zodPromise;

  _zodPromise = (async () => {
    try {
      // Preferred: CommonJS require (works if a CJS entrypoint is available).
      // eslint-disable-next-line global-require
      const mod = require('zod');
      return { z: mod.z ?? mod.default?.z ?? mod.default ?? mod };
    } catch (err) {
      // Fallback: if require failed due to ESM/CJS mismatch, use dynamic import.
      // This path is particularly important on Node 18 when an ESM entrypoint
      // is resolved but we're executing in CJS mode.
      const msg = String(err && (err.message || err));
      const isEsmInteropError =
        msg.includes('Cannot use import statement outside a module') ||
        msg.includes('ERR_REQUIRE_ESM') ||
        msg.includes('Unexpected token export');

      if (!isEsmInteropError) throw err;

      const mod = await import('zod');
      return { z: mod.z ?? mod.default?.z ?? mod.default ?? mod };
    }
  })();

  return _zodPromise;
}

module.exports = {
  getZod
};
