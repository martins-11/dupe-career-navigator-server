'use strict';

const request = require('supertest');

describe('GET /api/recommendations/initial regenerates when cached count is insufficient', () => {
  test('cached 5-role pool is bypassed/regenerated when storeCount desires >5, then subsequent request is cacheHit with >5', async () => {
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
      match_metadata: { isFallbackFilled: false },
    });

    // Return as many roles as requested by options.count so we can fill the stored pool.
    const mockGetInitial = jest.fn(async (_finalPersona, options) => ({
      modelId: 'test-model',
      prompt: 'test-prompt',
      usedFallback: false,
      roles: new Array(options?.count || 12).fill(null).map((_, idx) => makeRole(idx + 1)),
    }));

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial,
    }));

    // eslint-disable-next-line global-require
    const app = require('../../src/server');
    // eslint-disable-next-line global-require
    const holisticPersonaRepo = require('../../src/repositories/holisticPersonaRepoAdapter');

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';

    // Seed a non-fallback cached entry of ONLY 5 roles (simulates older storage behavior).
    const cachedFive = new Array(5).fill(null).map((_, idx) => ({
      role_id: `cached-${idx + 1}`,
      role_title: `Cached Role ${idx + 1}`,
      industry: 'Tech',
      salary_lpa_range: '₹10–₹20 LPA',
      experience_range: '2–4 years',
      description: 'Cached.',
      key_responsibilities: ['A', 'B', 'C'],
      required_skills: ['Skill1', 'Skill2', 'Skill3', 'Skill4', 'Skill5'],
      match_metadata: { isFallbackFilled: false, endpointFallbackUsed: false },
    }));

    await holisticPersonaRepo.upsertRecommendationsRoles({
      userId: null,
      personaId,
      buildId: null,
      inferredTags: [],
      roles: cachedFive,
    });

    // First call should see cached count insufficient and regenerate (cacheHit=false).
    const res1 = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res1.status);
    expect(Array.isArray(res1.body?.roles)).toBe(true);
    expect(res1.body.roles.length).toBeGreaterThan(5);
    expect(res1.body).toHaveProperty('meta');
    expect(res1.body.meta).toHaveProperty('cacheHit', false);

    // Second call should now be a cacheHit=true with the larger pool.
    const res2 = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res2.status);
    expect(Array.isArray(res2.body?.roles)).toBe(true);
    expect(res2.body.roles.length).toBeGreaterThan(5);
    expect(res2.body).toHaveProperty('meta');
    expect(res2.body.meta).toHaveProperty('cacheHit', true);

    expect(mockGetInitial).toHaveBeenCalled();

    jest.dontMock('../../src/services/bedrockService');
  });
});
