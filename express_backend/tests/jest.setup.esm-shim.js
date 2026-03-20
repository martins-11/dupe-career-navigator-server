'use strict';

/**
 * Jest setup shim (CommonJS)
 *
 * NOTE:
 * - This file previously contained ESM `import` syntax, which can crash Jest when it loads setup
 *   files in a CommonJS context.
 * - Even though jest.config.cjs now points at jest.setup.esm-shim.cjs, this file may still be
 *   referenced by stale configs/caches or other tooling. Keeping it CJS prevents hard failures.
 *
 * Responsibilities:
 * 1) Provide `globalThis.require` for ESM tests that still call `require(...)`.
 * 2) Provide `globalThis.jest` for ESM tests that reference `jest` as a global.
 */

const { createRequire } = require('node:module');

globalThis.require = createRequire(__filename);

try {
  // eslint-disable-next-line global-require
  const { jest } = require('@jest/globals');
  globalThis.jest = jest;
} catch (_) {
  // no-op
}
