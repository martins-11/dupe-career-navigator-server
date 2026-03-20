'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,

  /**
   * This repository is ESM-first (`package.json` has `"type": "module"`).
   *
   * Important: In Jest v30+, `.js` is automatically treated as ESM when the nearest
   * package.json is `type: "module"`. Including `.js` in `extensionsToTreatAsEsm`
   * triggers a config validation error:
   *   "Option extensionsToTreatAsEsm: ['.js'] includes '.js' which is always inferred..."
   *
   * So we intentionally do NOT set `extensionsToTreatAsEsm` here.
   */

  // Ensure .env is loaded for tests (Jest doesn't execute src/server.js).
  setupFiles: ['<rootDir>/tests/jest.setup.env.js'],
};
