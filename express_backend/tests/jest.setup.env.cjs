'use strict';

/**
 * Jest setup: load environment variables from the backend's .env file.
 *
 * Why:
 * - The production/dev server explicitly loads dotenv in src/server.js.
 * - Jest runs tests without going through src/server.js, so .env isn't loaded unless we do it here.
 *
 * Note:
 * - This file is intentionally CommonJS (.cjs) so Jest can load it without ESM vm-modules flags.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load env from express_backend/.env regardless of Jest's working directory.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
