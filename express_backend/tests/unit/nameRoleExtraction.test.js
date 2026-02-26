'use strict';

const { extractNameAndCurrentRole, extractBestNameAndRoleFromDocuments } = require('../../src/utils/nameRoleExtraction');

describe('nameRoleExtraction (unit)', () => {
  test('single-doc performance review: extracts employee name and does not return generic label', () => {
    const perfReviewText = [
      'Performance Review',
      'Employee Name: Jane Q. Doe',
      'Reviewer: John Manager',
      '',
      'Summary:',
      'Jane consistently delivered high quality work and improved team velocity.'
    ].join('\n');

    const out = extractNameAndCurrentRole(perfReviewText);
    expect(out).toBeTruthy();
    expect(out.name).toBe('Jane Q. Doe');
    expect(String(out.name).toLowerCase()).not.toContain('performance review');
  });

  test('single-doc job description: extracts role from Position Title label', () => {
    const jdText = [
      'Job Description',
      'Company: ExampleCo',
      'Position Title: Senior Backend Engineer',
      '',
      'Responsibilities:',
      '- Build APIs'
    ].join('\n');

    const out = extractNameAndCurrentRole(jdText);
    expect(out).toBeTruthy();
    expect(out.role).toBe('Senior Backend Engineer');
  });

  test('multi-doc JD+PR (no resume): extracts role from JD and name from PR when present', () => {
    const docs = [
      {
        category: 'job_description',
        textContent: ['Job Description', 'Position Title: Data Analyst', '...'].join('\n')
      },
      {
        category: 'performance_review',
        textContent: ['Performance Review', 'Employee Name: Taylor Chen', '...'].join('\n')
      }
    ];

    const out = extractBestNameAndRoleFromDocuments(docs);
    expect(out).toBeTruthy();
    expect(out.name).toBe('Taylor Chen');
    expect(out.role).toBe('Data Analyst');
  });

  test('multi-doc resume+JD: name from resume wins, role can fall back to JD when resume lacks clear role', () => {
    const docs = [
      {
        category: 'resume',
        textContent: ['Alex Rivera', 'alex@example.com', '', 'SUMMARY', '...'].join('\n')
      },
      {
        category: 'job_description',
        textContent: ['Job Description', 'Job Title: Staff Software Engineer', '...'].join('\n')
      }
    ];

    const out = extractBestNameAndRoleFromDocuments(docs);
    expect(out).toBeTruthy();
    expect(out.name).toBe('Alex Rivera');
    expect(out.role).toBe('Staff Software Engineer');
  });
});
