'use strict';

/**
 * Seed the roles catalog table if it's empty.
 *
 * Usage:
 *   node scripts/seed-roles.js
 *
 * Notes:
 * - Uses existing env-driven DB configuration (express_backend/.env loaded by src/server.js;
 *   this script loads it explicitly as well).
 * - Safe to run multiple times: will only seed when roles table is empty.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const rolesRepo = require('../src/repositories/rolesRepoAdapter');

async function main() {
  const cnt = await rolesRepo.countRoles();
  if (cnt > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed-roles] roles table already has ${cnt} rows; no action taken.`);
    return;
  }

  // Keep this seed list aligned with recommendationsService._ensureSeededIfEmpty()
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

  const res = await rolesRepo.bulkInsertRoles(seed);
  const after = await rolesRepo.countRoles();

  // eslint-disable-next-line no-console
  console.log(`[seed-roles] inserted=${res.inserted} roles. total=${after}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed-roles] failed:', e);
  process.exitCode = 1;
});
