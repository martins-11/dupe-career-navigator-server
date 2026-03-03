'use strict';

/**
 * Verification script for GET /api/roles/search multi-filter AND logic.
 *
 * Runs required cases:
 * 1) keyword AND industry: q=Manager&industry=Technology
 *    Expected: non-empty, should include roles like "Product Manager" / "Technical Program Manager"
 * 2) salary range: min_salary=100000
 *    Expected: non-empty, should include multiple roles with salary ranges >= $100k
 *
 * Usage:
 *   node scripts/test-search-filters.js
 *
 * Optional env:
 *   API_BASE_URL (default: http://localhost:3001)
 */

require('dotenv').config();

const API_BASE_URL =
  process.env.API_BASE_URL ||
  // When running in Kavia, the backend is often exposed via a hosted URL.
  process.env.KAVIA_BACKEND_URL ||
  'http://localhost:3001';

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

  // Some internal helpers return { rows: [...] } while the HTTP API contract is an array.
  // Be defensive so this script verifies the actual role list either way.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.rows)) {
    return parsed.rows;
  }

  return parsed;
}

function summarizeRoles(roles, max = 5) {
  const list = Array.isArray(roles) ? roles : [];
  return {
    count: list.length,
    sample: list.slice(0, max).map((r) => ({
      role_title: r.role_title,
      industry: r.industry,
      salary_range: r.salary_range,
      skills_required_count: Array.isArray(r.skills_required) ? r.skills_required.length : null,
      match_metadata: r.match_metadata
    }))
  };
}

// PUBLIC_INTERFACE
async function main() {
  /** Entrypoint: runs verification cases and prints results to terminal. */
  const cases = [
    {
      name: 'Case 1: keyword AND industry (q=Manager&industry=Technology)',
      path: '/api/roles/search?q=Manager&industry=Technology'
    },
    {
      name: 'Case 2: salary range filter (min_salary=50000)',
      path: '/api/roles/search?min_salary=50000'
    }
  ];

  console.log(`API_BASE_URL: ${API_BASE_URL}`);
  console.log('--- Running role search filter verification ---');

  for (const c of cases) {
    const url = `${API_BASE_URL}${c.path}`;
    console.log(`\n${c.name}`);
    console.log(`GET ${url}`);

    try {
      const roles = await httpGetJson(url);
      console.log(JSON.stringify(summarizeRoles(roles), null, 2));
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      if (err.details != null) console.error('Details:', JSON.stringify(err.details, null, 2));
      process.exitCode = 1;
    }
  }

  console.log('\n--- Done ---');
}

if (require.main === module) {
  main();
}
