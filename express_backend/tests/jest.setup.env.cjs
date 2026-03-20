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

/**
 * Deterministic test defaults:
 * - Ensure DB adapters treat DB as not configured unless a test explicitly sets MYSQL_* env vars.
 * - Ensure Bedrock calls do not run unless a test explicitly provides credentials/model ids.
 *
 * This prevents long hangs/timeouts in CI smoke runs.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_ENGINE = process.env.DB_ENGINE || 'mysql';

// Treat DB as "not configured" by default in Jest.
delete process.env.MYSQL_HOST;
delete process.env.MYSQL_PORT;
delete process.env.MYSQL_DATABASE;
delete process.env.MYSQL_USER;
delete process.env.MYSQL_PASSWORD;

// Prevent accidental real Bedrock usage in tests unless explicitly configured.
process.env.BEDROCK_DISABLE = process.env.BEDROCK_DISABLE || 'true';
delete process.env.BEDROCK_MODEL_ID;
delete process.env.BEDROCK_ROLE_MODEL_ID;

// Safe region defaults for test runs (avoids AWS SDK "missing region" crash).
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION;

// Force deterministic behavior: prefer local fallbacks and avoid Bedrock invocations during tests.
process.env.RECOMMENDATIONS_INITIAL_ALLOW_PADDING = 'true';
process.env.EXPLORE_RECOMMENDATIONS_BEDROCK_COOLDOWN_MS = process.env.EXPLORE_RECOMMENDATIONS_BEDROCK_COOLDOWN_MS || '600000';
process.env.BEDROCK_MAX_ATTEMPTS = process.env.BEDROCK_MAX_ATTEMPTS || '1';
process.env.BEDROCK_TIMEOUT_MS = process.env.BEDROCK_TIMEOUT_MS || '250';
process.env.BEDROCK_TIMEOUT_CAP_MS = process.env.BEDROCK_TIMEOUT_CAP_MS || '250';

// Do not provide credentials in test env by default.
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
