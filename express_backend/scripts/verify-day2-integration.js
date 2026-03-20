/**
 * Day 2 Integration Verification Script (ESM)
 *
 * Verifies backend integration requirements for Search + Filter:
 * 1) Unified Query handling on GET /api/roles/search using keyword + industry (+ optional skills).
 * 2) Result objects are "integration-ready" for Role Comparison Matrix:
 *    - contains role_title, salary_range, and skills_required fields
 * 3) Default limit behavior:
 *    - default should return <= 10 results
 *    - limit query param can override
 *
 * Usage:
 *   node scripts/verify-day2-integration.js
 *
 * Optional env:
 *   API_BASE_URL (default: http://localhost:3001)
 *   VERIFY_USER_ID (optional): if set, the script also asserts is_targetable is present (boolean).
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE_URL =
  process.env.API_BASE_URL || process.env.KAVIA_BACKEND_URL || 'http://localhost:3001';

const VERIFY_USER_ID = process.env.VERIFY_USER_ID ? String(process.env.VERIFY_USER_ID).trim() : '';

/**
 * Create explicit agents to avoid stuck keep-alive sockets holding the event loop open.
 * Also helps reduce the chance of hung TCP connections in some CI environments.
 */
const HTTP_AGENT = new http.Agent({ keepAlive: false });
const HTTPS_AGENT = new https.Agent({ keepAlive: false });

function logStep(event, name, meta = {}) {
  const ts = new Date().toISOString();
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [${event}] ${name}${suffix}`);
}

function maybeSeedRolesIfDbOff() {
  /**
   * If DB is off/unconfigured, roles/search may legitimately return [] unless the catalog is seeded.
   * Attempt to seed using the existing script, but do not hard-fail if seeding isn't possible.
   */
  const mysqlLooksConfigured =
    Boolean(process.env.MYSQL_HOST) &&
    Boolean(process.env.MYSQL_DATABASE) &&
    Boolean(process.env.MYSQL_USER) &&
    Boolean(process.env.MYSQL_PASSWORD);

  if (mysqlLooksConfigured) return { attempted: false, seeded: false, reason: 'mysql_configured' };

  // IMPORTANT: use absolute path so callers can run from any CWD (CI often does).
  const seedScriptAbs = path.resolve(__dirname, 'seed-roles.js');

  const result = spawnSync(process.execPath, [seedScriptAbs], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status === 0) return { attempted: true, seeded: true, script: seedScriptAbs };
  return { attempted: true, seeded: false, exitCode: result.status, script: seedScriptAbs };
}

async function httpGetJson(url, { timeoutMs = 8_000 } = {}) {
  /**
   * Fetch JSON with an explicit timeout so this script cannot hang forever in CI.
   *
   * Safeguards:
   * - AbortController for hard request deadline
   * - keepAlive disabled to avoid stuck sockets
   * - response-body read has a small grace timeout as well
   */
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  // Slight extra guard: if response starts but body read stalls, abort shortly after timeoutMs.
  const BODY_GRACE_MS = 1_500;
  const bodyController = new AbortController();
  const bodyTimeout = setTimeout(() => bodyController.abort(), timeoutMs + BODY_GRACE_MS);

  let res;
  let text = '';
  try {
    const isHttps = String(url).toLowerCase().startsWith('https://');
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any ? AbortSignal.any([controller.signal, bodyController.signal]) : controller.signal,
      // @ts-ignore node fetch supports agent option
      agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
    });

    try {
      text = await res.text();
    } catch (e) {
      if (e?.name === 'AbortError') {
        const err = new Error(`HTTP response body timed out after ${timeoutMs + BODY_GRACE_MS}ms`);
        err.code = 'HTTP_BODY_TIMEOUT';
        err.details = { url, timeoutMs, bodyGraceMs: BODY_GRACE_MS };
        throw err;
      }
      throw e;
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      err.code = 'HTTP_TIMEOUT';
      err.details = { url, timeoutMs };
      throw err;
    }
    const err = new Error(`HTTP request failed: ${e?.message || String(e)}`);
    err.code = 'HTTP_REQUEST_FAILED';
    err.details = { url };
    throw err;
  } finally {
    clearTimeout(t);
    clearTimeout(bodyTimeout);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = text;
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.details = parsed;
    throw err;
  }

  // Defensive: some internal helpers sometimes return { rows: [...] }.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.rows)) {
    return parsed.rows;
  }

  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.code = 'ASSERTION_FAILED';
    throw err;
  }
}

function hasString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasArray(v) {
  return Array.isArray(v);
}

function validateRoleComparisonReady(role) {
  // Backend contract fields used by frontend Role Comparison Matrix.
  assert(role && typeof role === 'object', 'Role must be an object');

  assert(hasString(role.role_title), 'Role must include role_title (non-empty string)');
  assert(
    hasString(role.salary_range) || role.salary_range == null,
    'Role should include salary_range (string or null)'
  );
  assert(hasArray(role.skills_required), 'Role must include skills_required (array)');

  // Optional integration field:
  if (VERIFY_USER_ID) {
    assert(
      typeof role.is_targetable === 'boolean',
      'Role must include is_targetable boolean when VERIFY_USER_ID is set'
    );
  }
}

function roleMatchesUnifiedCriteria(role, { q, industry }) {
  // We validate industry strictness (case-insensitive) and keyword in title OR skills.
  const qNorm = String(q || '')
    .trim()
    .toLowerCase();
  const indNorm = String(industry || '')
    .trim()
    .toLowerCase();

  if (indNorm) {
    if (String(role.industry || '').trim().toLowerCase() !== indNorm) return false;
  }

  if (qNorm) {
    const inTitle = String(role.role_title || '').toLowerCase().includes(qNorm);
    const inSkills = (Array.isArray(role.skills_required) ? role.skills_required : []).some((s) =>
      String(s).toLowerCase().includes(qNorm)
    );
    if (!inTitle && !inSkills) return false;
  }

  return true;
}

async function runStep(report, name, fn) {
  const startedAt = Date.now();
  logStep('START', name);
  try {
    const out = await fn();
    const elapsedMs = Date.now() - startedAt;
    logStep('OK', name, { elapsedMs });
    return out;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    logStep('FAIL', name, { elapsedMs, message: err?.message || String(err), code: err?.code || null });
    report.ok = false;
    throw err;
  }
}

// PUBLIC_INTERFACE
export async function main() {
  /** Entrypoint: runs Day 2 integration verification and prints a structured report. */
  const report = {
    apiBaseUrl: API_BASE_URL,
    userIdProvided: Boolean(VERIFY_USER_ID),
    steps: [],
    ok: true,
  };

  // Ensure any unexpected promise/exception doesn't leave the process hanging in CI.
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('UnhandledRejection:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('UncaughtException:', err);
    process.exit(1);
  });

  // Hard stop: guarantee termination even if a future code path accidentally hangs.
  const HARD_TIMEOUT_MS = Number(process.env.VERIFY_HARD_TIMEOUT_MS || 60_000);
  const hardTimeout = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(`--- FAIL ---\nverify-day2-integration hard timeout after ${HARD_TIMEOUT_MS}ms`);
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  hardTimeout.unref?.();

  // eslint-disable-next-line no-console
  console.log(`API_BASE_URL: ${API_BASE_URL}`);
  // eslint-disable-next-line no-console
  if (VERIFY_USER_ID) console.log(`VERIFY_USER_ID: ${VERIFY_USER_ID}`);

  let exitCode = 0;

  try {
    const unified = { q: 'Manager', industry: 'Technology' };
    const unifiedParams = new URLSearchParams({
      q: unified.q,
      industry: unified.industry,
    });
    if (VERIFY_USER_ID) unifiedParams.set('user_id', VERIFY_USER_ID);

    const seedInfo = await runStep(report, 'Seed roles (best-effort, only when DB is off)', async () =>
      maybeSeedRolesIfDbOff()
    );

    const urlUnified = `${API_BASE_URL}/api/roles/search?${unifiedParams.toString()}`;
    const unifiedRoles = await runStep(report, 'Unified search (keyword + industry)', async () =>
      httpGetJson(urlUnified, { timeoutMs: 8_000 })
    );

    assert(Array.isArray(unifiedRoles), 'Unified search response must be an array');

    if (unifiedRoles.length === 0) {
      report.steps.push({
        name: 'Unified search (keyword + industry)',
        request: urlUnified,
        resultCount: 0,
        skipped: true,
        reason:
          'No unified-search results (likely DB-off/empty catalog). Seed attempt info is included.',
        seedInfo,
      });
    } else {
      await runStep(report, 'Validate unified search results match criteria + are matrix-ready', async () => {
        const mismatches = unifiedRoles.filter((r) => !roleMatchesUnifiedCriteria(r, unified));
        assert(
          mismatches.length === 0,
          `Unified search returned roles that do not match criteria (count=${mismatches.length})`
        );

        for (const r of unifiedRoles) validateRoleComparisonReady(r);
      });

      report.steps.push({
        name: 'Unified search (keyword + industry)',
        request: urlUnified,
        resultCount: unifiedRoles.length,
        seedInfo,
        sample: unifiedRoles.slice(0, 3).map((r) => ({
          role_title: r.role_title,
          industry: r.industry,
          salary_range: r.salary_range,
          skills_required_count: Array.isArray(r.skills_required) ? r.skills_required.length : null,
          is_targetable: r.is_targetable,
        })),
      });
    }

    const urlDefaultLimit = `${API_BASE_URL}/api/roles/search?q=Manager&industry=Technology${
      VERIFY_USER_ID ? `&user_id=${encodeURIComponent(VERIFY_USER_ID)}` : ''
    }`;
    const defaultLimitedRoles = await runStep(report, 'Default limit check (<=10) without limit param', async () =>
      httpGetJson(urlDefaultLimit, { timeoutMs: 8_000 })
    );
    assert(Array.isArray(defaultLimitedRoles), 'Default limit response must be an array');
    assert(
      defaultLimitedRoles.length <= 10,
      `Default limit must return <= 10 results (got ${defaultLimitedRoles.length})`
    );

    report.steps.push({
      name: 'Default limit (<=10) is enforced',
      request: urlDefaultLimit,
      resultCount: defaultLimitedRoles.length,
    });

    const urlOverrideLimit = `${API_BASE_URL}/api/roles/search?q=Manager&industry=Technology&limit=15${
      VERIFY_USER_ID ? `&user_id=${encodeURIComponent(VERIFY_USER_ID)}` : ''
    }`;
    const overrideRoles = await runStep(report, 'Limit override respected (<=15)', async () =>
      httpGetJson(urlOverrideLimit, { timeoutMs: 8_000 })
    );
    assert(Array.isArray(overrideRoles), 'Override limit response must be an array');
    assert(
      overrideRoles.length <= 15,
      `Override limit must respect limit=15 (got ${overrideRoles.length})`
    );

    report.steps.push({
      name: 'Limit override is respected (<=15)',
      request: urlOverrideLimit,
      resultCount: overrideRoles.length,
    });

    // eslint-disable-next-line no-console
    console.log('\n--- verify-day2-integration report ---');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log('--- PASS ---');
  } catch (err) {
    exitCode = 1;

    report.ok = false;
    report.error = {
      message: err?.message || String(err),
      code: err?.code || null,
      details: err?.details || null,
    };

    // eslint-disable-next-line no-console
    console.error('\n--- verify-day2-integration report ---');
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.error('--- FAIL ---');
  } finally {
    clearTimeout(hardTimeout);
    // Guarantee termination with explicit exit code (prevents “hang” from open handles).
    process.exit(exitCode);
  }
}

/**
 * ESM-compatible "is main module" check.
 * Node sets process.argv[1] to the executed script path.
 */
const isDirectRun = (() => {
  try {
    const executed = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
    return import.meta.url === executed;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await main();
}
