'use strict';

/**
 * Jest setup shim (CommonJS)
 *
 * Why this exists:
 * - This repo is ESM-first ("type":"module"), but Jest can still load setup hooks in a CJS context.
 * - Some legacy tests call `require(...)`.
 * - Some ESM tests refer to `jest` as a global (which is not automatically present in ESM mode).
 *
 * This shim:
 * 1) Provides `globalThis.require` for ESM tests that still call `require`.
 * 2) Ensures `jest` is available as a global by importing it from '@jest/globals'.
 */

const { createRequire } = require('node:module');

// Provide a CommonJS-like `require` for tests that still call it.
globalThis.require = createRequire(__filename);

// Provide Jest globals in ESM mode for tests that reference `jest` directly.
try {
  // eslint-disable-next-line global-require
  const { jest } = require('@jest/globals');
  globalThis.jest = jest;
} catch (_) {
  // If '@jest/globals' isn't available for some reason, do not hard-crash here.
}
