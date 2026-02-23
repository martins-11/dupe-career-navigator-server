'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,

  // Ensure .env is loaded for tests (Jest doesn't execute src/server.js).
  setupFiles: ['<rootDir>/tests/jest.setup.env.js'],
};
