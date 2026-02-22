'use strict';

/**
 * Validation script:
 * - Attempts to generate a persona with nonsense input ('asdfghjkl')
 * - Verifies API rejects it with INVALID_INPUT_LENGTH
 * - Verifies no record is persisted into persona_drafts
 *
 * Usage:
 *   node scripts/validate-nonsense-input.js
 *
 * Required env:
 * - BASE_URL (optional; default http://localhost:3001)
 * - PERSONA_GENERATE_PATH (optional; default /ai/personas/generate)
 *
 * For DB verification (MySQL):
 * - DB_ENGINE=mysql (default)
 * - DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD (or use MYSQL_* equivalents if you adapt below)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mysql = require('mysql2/promise');

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function requireEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// PUBLIC_INTERFACE
function buildBaseUrl() {
  /** Resolve API base URL for scripts. */
  return env('BASE_URL') || env('API_BASE_URL') || 'http://localhost:3001';
}

// PUBLIC_INTERFACE
function buildPersonaGeneratePath() {
  /** Resolve persona generate endpoint path for scripts. */
  return env('PERSONA_GENERATE_PATH') || '/ai/personas/generate';
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const raw = await resp.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (_) {
    // ignore
  }

  return { status: resp.status, ok: resp.ok, json, raw };
}

async function mysqlPoolFromEnv() {
  const engine = (env('DB_ENGINE') || 'mysql').toLowerCase();
  if (engine !== 'mysql') {
    throw new Error(`This script expects DB_ENGINE=mysql for verification, got ${engine}`);
  }

  return mysql.createPool({
    host: requireEnv('DB_HOST'),
    port: Number(requireEnv('DB_PORT')),
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USERNAME'),
    password: requireEnv('DB_PASSWORD'),
    waitForConnections: true,
    connectionLimit: 5,
    ssl: String(env('DB_SSL') || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined
  });
}

async function main() {
  const baseUrl = buildBaseUrl();
  const personaGeneratePath = buildPersonaGeneratePath();
  const apiUrl = `${baseUrl}${personaGeneratePath}`;

  // Count rows before.
  const pool = await mysqlPoolFromEnv();
  let beforeCount = 0;
  let afterCount = 0;

  try {
    const [beforeRows] = await pool.query('SELECT COUNT(*) AS c FROM persona_drafts');
    beforeCount = Number(beforeRows?.[0]?.c ?? 0);

    const apiResp = await postJson(apiUrl, {
      sourceText: 'asdfghjkl',
      context: { targetRole: 'Engineer', seniority: 'Junior', industry: 'Software' }
    });

    if (apiResp.ok) {
      throw new Error(
        `Expected request to fail, but got ok=true status=${apiResp.status} body=${apiResp.raw}`
      );
    }

    const errCode = apiResp.json?.error;
    if (errCode !== 'INVALID_INPUT_LENGTH') {
      throw new Error(
        `Expected error=INVALID_INPUT_LENGTH, got ${String(errCode)} status=${apiResp.status} body=${apiResp.raw}`
      );
    }

    const [afterRows] = await pool.query('SELECT COUNT(*) AS c FROM persona_drafts');
    afterCount = Number(afterRows?.[0]?.c ?? 0);

    if (afterCount !== beforeCount) {
      throw new Error(
        `Expected persona_drafts rowcount unchanged. Before=${beforeCount} After=${afterCount}`
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiUrl,
          expectedError: 'INVALID_INPUT_LENGTH',
          beforeCount,
          afterCount
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[validate-nonsense-input] FAILED:', err);
  process.exitCode = 1;
});
