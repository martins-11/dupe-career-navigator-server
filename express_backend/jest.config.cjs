'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,

  /**
   * ESM import path stability:
   * Some suites import from "src/..." (instead of relative ../../src/...).
   * Map that prefix to the real rootDir/src so resolution is consistent in Jest.
   */
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },

  /**
   * This repository is ESM-first (`package.json` has `"type": "module"`).
   *
   * Jest is invoked with `NODE_OPTIONS=--experimental-vm-modules` (see package.json scripts)
   * so that native ESM modules are executed without transpilation.
   *
   * Note: In Jest v30+, `.js` is automatically treated as ESM when the nearest
   * package.json is `type: "module"`. Including `.js` in `extensionsToTreatAsEsm`
   * triggers a config validation error, so we intentionally do NOT set it here.
   */

  // Ensure .env is loaded for tests (Jest doesn't execute src/server.js).
  // Keep this setup file as CJS so Jest can load it without ESM vm-modules flags.
  setupFiles: ['<rootDir>/tests/jest.setup.env.cjs'],

  /**
   * Some tests still use `require(...)` even though Jest runs them as ESM under
   * `type: module`. Provide a small shim so those tests can keep using `require`
   * without failing with "ReferenceError: require is not defined".
   *
   * IMPORTANT:
   * Jest loads setupFilesAfterEnv in a CJS context in some configurations even
   * when the repo is ESM-first. Therefore the shim MUST be CommonJS.
   */
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.esm-shim.cjs'],

  // Reduce accidental hangs in CI by enforcing a hard per-test timeout.
  testTimeout: 60_000,
};
