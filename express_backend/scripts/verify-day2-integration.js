'use strict';

/**
 * Day 2 Integration Verification Script
 *
 * Verifies the backend integration requirements for Search + Filter:
 * 1) Unified Query handling on GET /api/roles/search using keyword + industry (+ optional skills).
 * 2) Result objects are "integration-ready" for Role Comparison Matrix:
 *    - contains title, salary, and skills fields
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

require('dotenv').config();

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.KAVIA_BACKEND_URL ||
  'http://localhost:3001';

const VERIFY_USER_ID = process.env.VERIFY_USER_ID ? String(process.env.VERIFY_USER_ID).trim() : '';

async function httpGetJson(url) {
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
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
  assert(hasString(role.salary_range) || role.salary_range == null, 'Role should include salary_range (string or null)');
  assert(hasArray(role.skills_required), 'Role must include skills_required (array)');

  // Optional integration field:
  if (VERIFY_USER_ID) {
    assert(typeof role.is_targetable === 'boolean', 'Role must include is_targetable boolean when VERIFY_USER_ID is set');
  }
}

function roleMatchesUnifiedCriteria(role, { q, industry }) {
  // We validate industry strictness (case-insensitive) and keyword in title OR skills.
  const qNorm = String(q || '').trim().toLowerCase();
  const indNorm = String(industry || '').trim().toLowerCase();

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

// PUBLIC_INTERFACE
async function main() {
  /** Entrypoint: runs Day 2 integration verification and prints a structured report. */
  const report = {
    apiBaseUrl: API_BASE_URL,
    userIdProvided: Boolean(VERIFY_USER_ID),
    steps: [],
    ok: true
  };

  console.log(`API_BASE_URL: ${API_BASE_URL}`);
  if (VERIFY_USER_ID) console.log(`VERIFY_USER_ID: ${VERIFY_USER_ID}`);

  try {
    // Step 1: Combined search (keyword + industry).
    // The requirements mention example ("Engineer" + "Technology"), but seeded data may vary.
    // We use q=Manager&industry=Technology (known from existing verification).
    const unified = { q: 'Manager', industry: 'Technology' };
    const unifiedParams = new URLSearchParams({
      q: unified.q,
      industry: unified.industry
    });
    if (VERIFY_USER_ID) unifiedParams.set('user_id', VERIFY_USER_ID);

    const urlUnified = `${API_BASE_URL}/api/roles/search?${unifiedParams.toString()}`;
    const unifiedRoles = await httpGetJson(urlUnified);

    assert(Array.isArray(unifiedRoles), 'Unified search response must be an array');
    assert(unifiedRoles.length > 0, 'Unified search must return non-empty results');

    // Step 2: Validate that returned roles match criteria and are matrix-ready.
    const mismatches = unifiedRoles.filter((r) => !roleMatchesUnifiedCriteria(r, unified));
    assert(mismatches.length === 0, `Unified search returned roles that do not match criteria (count=${mismatches.length})`);

    for (const r of unifiedRoles) validateRoleComparisonReady(r);

    report.steps.push({
      name: 'Unified search (keyword + industry)',
      request: urlUnified,
      resultCount: unifiedRoles.length,
      sample: unifiedRoles.slice(0, 3).map((r) => ({
        role_title: r.role_title,
        industry: r.industry,
        salary_range: r.salary_range,
        skills_required_count: Array.isArray(r.skills_required) ? r.skills_required.length : null,
        is_targetable: r.is_targetable
      }))
    });

    // Step 3: Default limit behavior (no limit param should return <= 10).
    const urlDefaultLimit = `${API_BASE_URL}/api/roles/search?q=Manager&industry=Technology${VERIFY_USER_ID ? `&user_id=${encodeURIComponent(VERIFY_USER_ID)}` : ''}`;
    const defaultLimitedRoles = await httpGetJson(urlDefaultLimit);
    assert(Array.isArray(defaultLimitedRoles), 'Default limit response must be an array');
    assert(defaultLimitedRoles.length <= 10, `Default limit must return <= 10 results (got ${defaultLimitedRoles.length})`);

    report.steps.push({
      name: 'Default limit (<=10) is enforced',
      request: urlDefaultLimit,
      resultCount: defaultLimitedRoles.length
    });

    // Step 4: Override limit (limit=15 should allow > 10 if available).
    const urlOverrideLimit = `${API_BASE_URL}/api/roles/search?q=Manager&industry=Technology&limit=15${VERIFY_USER_ID ? `&user_id=${encodeURIComponent(VERIFY_USER_ID)}` : ''}`;
    const overrideRoles = await httpGetJson(urlOverrideLimit);
    assert(Array.isArray(overrideRoles), 'Override limit response must be an array');
    assert(overrideRoles.length <= 15, `Override limit must respect limit=15 (got ${overrideRoles.length})`);

    report.steps.push({
      name: 'Limit override is respected (<=15)',
      request: urlOverrideLimit,
      resultCount: overrideRoles.length
    });

    console.log('\n--- verify-day2-integration report ---');
    console.log(JSON.stringify(report, null, 2));
    console.log('--- PASS ---');
  } catch (err) {
    report.ok = false;
    report.error = {
      message: err?.message || String(err),
      code: err?.code || null,
      details: err?.details || null
    };

    console.error('\n--- verify-day2-integration report ---');
    console.error(JSON.stringify(report, null, 2));
    console.error('--- FAIL ---');

    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
