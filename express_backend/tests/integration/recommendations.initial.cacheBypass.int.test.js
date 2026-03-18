'use strict';

const request = require('supertest');

describe('GET /api/recommendations/initial bypasses fallback-only cache and uses Bedrock when available', () => {
  test('when cache contains fallback-only roles, endpoint regenerates via Bedrock and then serves cached Bedrock roles (stored pool >5)', async () => {
    jest.resetModules();

    // Ensure the endpoint desires >5 roles.
    process.env.INITIAL_RECOMMENDATIONS_STORE_COUNT = '12';

    const makeRole = (i) => ({
      role_id: `bedrock-${i}`,
      role_title: `Bedrock Role ${i}`,
      industry: 'Tech',
      salary_lpa_range: '₹10–₹20 LPA',
      experience_range: '2–4 years',
      description: 'Desc.',
      key_responsibilities: ['A', 'B', 'C'],
      required_skills: ['Skill1', 'Skill2', 'Skill3', 'Skill4', 'Skill5'],
    });

    // Return as many roles as requested by options.count so we can fill the stored pool.
    const mockGetInitial = jest.fn(async (_finalPersona, options) => ({
      modelId: 'test-model',
      prompt: 'test-prompt',
      usedFallback: false,
      roles: new Array(options?.count || 12).fill(null).map((_, idx) => makeRole(idx + 1)),
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

    // Stored/returned pool should be >5.
    expect(res1.body.roles.length).toBeGreaterThan(5);

    // Must not be served from cache since cached entry was fallback-only.
    expect(res1.body).toHaveProperty('meta');
    expect(res1.body.meta).toHaveProperty('cacheHit', false);

    // Bedrock roles should be present (i.e., not fallback-filled).
    expect(res1.body.roles.every((r) => r?.match_metadata?.isFallbackFilled === false)).toBe(true);

    // Second call should now hit cache and still be Bedrock roles (pool >5).
    const res2 = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res2.status);
    expect(res2.body).toHaveProperty('meta');
    expect(res2.body.meta).toHaveProperty('cacheHit', true);
    expect(res2.body.roles.length).toBeGreaterThan(5);
    expect(res2.body.roles.every((r) => r?.match_metadata?.isFallbackFilled === false)).toBe(true);

    // Bedrock was invoked at least once (for the bypassed cache call).
    expect(mockGetInitial).toHaveBeenCalled();

    jest.dontMock('../../src/services/bedrockService');
  });
});
