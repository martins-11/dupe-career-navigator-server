'use strict';

/**
 * Verification script: keyword search against GET /api/roles/search?q=Manager
 *
 * What it does:
 * - Loads express_backend/.env
 * - Ensures roles are seeded (runs the same seeding script used elsewhere)
 * - Calls the running backend instance over HTTP
 * - Asserts at least one result contains "Manager" in role_title
 *
 * Usage:
 *   node scripts/test-search-keyword.js
 *
 * Optional env overrides:
 *   BACKEND_URL (defaults to http://localhost:3001)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { dbClose } = require('../src/db/connection');

async function httpGetJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}: ${text}`);
  }

  return await res.json();
}

async function seedIfNeeded() {
  // Reuse the existing seed script logic by requiring and executing it would be messy;
  // instead, call repository methods directly similarly to seed-roles.js.
  const rolesRepo = require('../src/repositories/rolesRepoAdapter');
  const cnt = await rolesRepo.countRoles();
  if (cnt > 0) return { seeded: false, count: cnt };

  // Keep this list aligned with scripts/seed-roles.js
  const seed = [
    {
      roleTitle: 'Software Engineer',
      industry: 'Technology',
      coreSkills: ['JavaScript', 'APIs', 'Problem Solving', 'Git', 'Debugging'],
      seniorityLevels: ['Junior', 'Mid'],
      estimatedSalaryRange: '$90k-$140k'
    },
    {
      roleTitle: 'Senior Software Engineer',
      industry: 'Technology',
      coreSkills: ['System Design', 'Leadership', 'JavaScript', 'Backend', 'Mentoring'],
      seniorityLevels: ['Senior', 'Lead'],
      estimatedSalaryRange: '$140k-$200k'
    },
    {
      roleTitle: 'Backend Engineer (Node.js)',
      industry: 'Technology',
      coreSkills: ['Node.js', 'Express', 'APIs', 'SQL', 'Performance'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$120k-$185k'
    },
    {
      roleTitle: 'Data Analyst',
      industry: 'Technology',
      coreSkills: ['SQL', 'Excel', 'Data Visualization', 'Statistics', 'Dashboards'],
      seniorityLevels: ['Junior', 'Mid'],
      estimatedSalaryRange: '$70k-$115k'
    },
    {
      roleTitle: 'Data Scientist',
      industry: 'Technology',
      coreSkills: ['Python', 'Machine Learning', 'Statistics', 'Experimentation', 'Modeling'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$130k-$210k'
    },
    {
      roleTitle: 'Machine Learning Engineer',
      industry: 'Technology',
      coreSkills: ['Python', 'MLOps', 'Model Deployment', 'AWS', 'APIs'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$150k-$230k'
    },
    {
      roleTitle: 'DevOps Engineer',
      industry: 'Technology',
      coreSkills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$130k-$205k'
    },
    {
      roleTitle: 'Cloud Solutions Architect',
      industry: 'Technology',
      coreSkills: ['AWS', 'Architecture', 'Security', 'Networking', 'Stakeholder Management'],
      seniorityLevels: ['Senior', 'Principal'],
      estimatedSalaryRange: '$170k-$260k'
    },
    {
      roleTitle: 'Product Manager',
      industry: 'Technology',
      coreSkills: ['Roadmapping', 'Stakeholder Management', 'Analytics', 'Prioritization', 'Communication'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$130k-$210k'
    },
    {
      roleTitle: 'Technical Program Manager',
      industry: 'Technology',
      coreSkills: ['Delivery Management', 'Coordination', 'Risk Management', 'Communication', 'Systems Thinking'],
      seniorityLevels: ['Senior', 'Lead'],
      estimatedSalaryRange: '$140k-$220k'
    },
    {
      roleTitle: 'UX Designer',
      industry: 'Technology',
      coreSkills: ['User Research', 'Wireframing', 'Prototyping', 'Interaction Design', 'Communication'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$110k-$180k'
    },
    {
      roleTitle: 'Cybersecurity Analyst',
      industry: 'Technology',
      coreSkills: ['Security Monitoring', 'Incident Response', 'Networking', 'Risk Assessment', 'SIEM'],
      seniorityLevels: ['Junior', 'Mid'],
      estimatedSalaryRange: '$90k-$145k'
    },
    {
      roleTitle: 'Finance Analyst',
      industry: 'Finance',
      coreSkills: ['Financial Modeling', 'Excel', 'Forecasting', 'Communication', 'Reporting'],
      seniorityLevels: ['Junior', 'Mid'],
      estimatedSalaryRange: '$70k-$120k'
    },
    {
      roleTitle: 'Risk Manager',
      industry: 'Finance',
      coreSkills: ['Risk Assessment', 'Compliance', 'Stakeholder Management', 'Analysis', 'Reporting'],
      seniorityLevels: ['Senior', 'Manager'],
      estimatedSalaryRange: '$130k-$200k'
    },
    {
      roleTitle: 'Operations Manager',
      industry: 'Retail',
      coreSkills: ['Process Improvement', 'Leadership', 'Operations', 'KPIs', 'Communication'],
      seniorityLevels: ['Senior', 'Manager'],
      estimatedSalaryRange: '$90k-$150k'
    },
    {
      roleTitle: 'Healthcare Data Analyst',
      industry: 'Healthcare',
      coreSkills: ['SQL', 'Data Privacy', 'Reporting', 'Dashboards', 'Stakeholder Management'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$85k-$135k'
    },
    {
      roleTitle: 'IT Support Specialist',
      industry: 'Technology',
      coreSkills: ['Troubleshooting', 'Customer Service', 'Windows', 'Networking', 'Documentation'],
      seniorityLevels: ['Entry', 'Junior'],
      estimatedSalaryRange: '$45k-$75k'
    },
    {
      roleTitle: 'Business Analyst',
      industry: 'Technology',
      coreSkills: ['Requirements', 'Process Mapping', 'Stakeholder Management', 'Documentation', 'Analytics'],
      seniorityLevels: ['Mid', 'Senior'],
      estimatedSalaryRange: '$90k-$150k'
    }
  ];

  await rolesRepo.bulkInsertRoles(seed);
  const after = await rolesRepo.countRoles();
  return { seeded: true, count: after };
}

async function main() {
  const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const q = 'Manager';

  const seedRes = await seedIfNeeded();

  const url = `${backendUrl}/api/roles/search?q=${encodeURIComponent(q)}&limit=50`;
  const results = await httpGetJson(url);

  if (!Array.isArray(results)) {
    throw new Error(`Expected array response from ${url}, got: ${typeof results}`);
  }

  const matchingTitles = results
    .map((r) => r && r.role_title)
    .filter((t) => typeof t === 'string' && t.toLowerCase().includes('manager'));

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        backendUrl,
        seeded: seedRes.seeded,
        rolesCountAfterSeedCheck: seedRes.count,
        q,
        resultCount: results.length,
        matchingTitleCount: matchingTitles.length,
        matchingTitles
      },
      null,
      2
    )
  );

  if (matchingTitles.length < 1) {
    throw new Error(`Search for q='${q}' returned no roles with 'Manager' in role_title.`);
  }

  await dbClose();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('[test-search-keyword] failed:', e);
  try {
    await dbClose();
  } catch (_) {
    // ignore close errors
  }
  process.exitCode = 1;
});
