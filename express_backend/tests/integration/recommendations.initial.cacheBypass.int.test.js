'use strict';

const request = require('supertest');

describe('GET /api/recommendations/initial bypasses fallback-only cache and uses Bedrock when available', () => {
  test('when cache contains fallback-only roles, endpoint regenerates via Bedrock and then serves cached Bedrock roles', async () => {
    jest.resetModules();

    const mockGetInitial = jest.fn(async () => ({
      modelId: 'test-model',
      roles: [
        {
          role_id: 'bedrock-1',
          role_title: 'Bedrock Role One',
          industry: 'Tech',
          salary_lpa_range: '₹10–₹20 LPA',
          experience_range: '2–4 years',
          description: 'Desc.',
          key_responsibilities: ['A', 'B', 'C'],
          required_skills: ['SQL', 'Excel', 'Communication', 'Stats', 'Dashboards'],
        },
        {
          role_id: 'bedrock-2',
          role_title: 'Bedrock Role Two',
          industry: 'Tech',
          salary_lpa_range: '₹12–₹22 LPA',
          experience_range: '2–4 years',
          description: 'Desc.',
          key_responsibilities: ['A', 'B', 'C'],
          required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Observability'],
        },
        {
          role_id: 'bedrock-3',
          role_title: 'Bedrock Role Three',
          industry: 'Tech',
          salary_lpa_range: '₹15–₹28 LPA',
          experience_range: '3–5 years',
          description: 'Desc.',
          key_responsibilities: ['A', 'B', 'C'],
          required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'Git'],
        },
        {
          role_id: 'bedrock-4',
          role_title: 'Bedrock Role Four',
          industry: 'Tech',
          salary_lpa_range: '₹16–₹30 LPA',
          experience_range: '3–6 years',
          description: 'Desc.',
          key_responsibilities: ['A', 'B', 'C'],
          required_skills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring'],
        },
        {
          role_id: 'bedrock-5',
          role_title: 'Bedrock Role Five',
          industry: 'Tech',
          salary_lpa_range: '₹18–₹32 LPA',
          experience_range: '4–7 years',
          description: 'Desc.',
          key_responsibilities: ['A', 'B', 'C'],
          required_skills: ['Roadmapping', 'Prioritization', 'Analytics', 'Communication', 'Stakeholder Management'],
        },
      ],
    }));

    // Mock Bedrock service BEFORE importing the server (server import pulls in routes/services).
    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial,
    }));

    // eslint-disable-next-line global-require
    const app = require('../../src/server');
    // eslint-disable-next-line global-require
    const holisticPersonaRepo = require('../../src/repositories/holisticPersonaRepoAdapter');

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';

    // Seed a fallback-only cache entry (simulates prior Bedrock failure being persisted).
    const fallbackOnlyRoles = new Array(5).fill(null).map((_, idx) => ({
      role_id: `fb-${idx + 1}`,
      role_title: `Fallback Role ${idx + 1}`,
      industry: 'Technology',
      description: 'Fallback.',
      key_responsibilities: [],
      required_skills: ['SQL', 'Communication'],
      match_metadata: {
        isFallbackFilled: true,
        fallbackReason: 'bedrock_returned_fewer_than_five',
        bedrockModelId: null,
        endpointFallbackUsed: true,
      },
    }));

    await holisticPersonaRepo.upsertRecommendationsRoles({
      userId: null,
      personaId,
      buildId: null,
      inferredTags: [],
      roles: fallbackOnlyRoles,
    });

    // First call should BYPASS cache and use Bedrock.
    const res1 = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res1.status);
    expect(res1.body).toHaveProperty('roles');
    expect(Array.isArray(res1.body.roles)).toBe(true);
    expect(res1.body.roles).toHaveLength(5);

    // Must not be served from cache since cached entry was fallback-only.
    expect(res1.body).toHaveProperty('meta');
    expect(res1.body.meta).toHaveProperty('cacheHit', false);

    // Bedrock roles should be present (i.e., not fallback-filled).
    expect(res1.body.roles.every((r) => r?.match_metadata?.isFallbackFilled === false)).toBe(true);

    // Second call should now hit cache and still be Bedrock roles.
    const res2 = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res2.status);
    expect(res2.body).toHaveProperty('meta');
    expect(res2.body.meta).toHaveProperty('cacheHit', true);
    expect(res2.body.roles).toHaveLength(5);
    expect(res2.body.roles.every((r) => r?.match_metadata?.isFallbackFilled === false)).toBe(true);

    // Bedrock was invoked at least once (for the bypassed cache call).
    expect(mockGetInitial).toHaveBeenCalled();

    jest.dontMock('../../src/services/bedrockService');
  });
});
