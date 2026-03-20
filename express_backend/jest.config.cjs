'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,

  /**
   * This repository is ESM-first (`package.json` has `"type": "module"`).
   * Jest defaults to CommonJS, so we explicitly enable ESM semantics so tests can:
   * - import the Express app from src/server.js
   * - import ESM services directly for isolated assertions when needed
   */
  extensionsToTreatAsEsm: ['.js'],

  // Ensure .env is loaded for tests (Jest doesn't execute src/server.js).
  setupFiles: ['<rootDir>/tests/jest.setup.env.js'],
};
