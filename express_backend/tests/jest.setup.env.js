/**
 * Jest setup: load environment variables from the backend's .env file.
 *
 * Why:
 * - The production/dev server explicitly loads dotenv in src/server.js.
 * - Jest runs tests without going through src/server.js, so .env isn't loaded unless we do it here.
 *
 * This keeps env loading consistent between runtime and tests.
 */

import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from express_backend/.env regardless of Jest's working directory.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
