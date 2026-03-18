'use strict';

const request = require('supertest');

describe('GET /api/recommendations/initial ignores legacy/simple cached roles and uses Bedrock when available', () => {
  test('when cache contains legacy /api/recommendations/roles-shaped entries, endpoint regenerates via Bedrock', async () => {
    jest.resetModules();

    // Make it easy for a legacy cached 5-item set to look "sufficient" unless we ignore it.
    process.env.INITIAL_RECOMMENDATIONS_STORE_COUNT = '5';

    const makeBedrockRole = (i) => ({
      role_id: `bedrock-${i}`,
      role_title: `Bedrock Role ${i}`,
      industry: 'Tech',
      salary_lpa_range: '₹10–₹20 LPA',
      experience_range: '2–4 years',
      description: 'Desc.',
      key_responsibilities: ['A', 'B', 'C'],
      required_skills: ['Skill1', 'Skill2', 'Skill3', 'Skill4', 'Skill5'],
    });

    const mockGetInitial = jest.fn(async (_finalPersona, options) => ({
      modelId: 'test-model',
      prompt: 'test-prompt',
      usedFallback: false,
      roles: new Array(options?.count || 5).fill(null).map((_, idx) => makeBedrockRole(idx + 1)),
    }));

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial,
    }));

    // eslint-disable-next-line global-require
    const app = require('../../src/server');
    // eslint-disable-next-line global-require
    const holisticPersonaRepo = require('../../src/repositories/holisticPersonaRepoAdapter');

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';

    // Seed legacy/simple cached roles (the /api/recommendations/roles contract shape)
    const legacySimple = new Array(5).fill(null).map((_, idx) => ({
      role_id: `simple-${idx + 1}`,
      role_title: `Simple Role ${idx + 1}`,
      industry: 'Technology',
      match_reason: 'Complete your persona to get personalized recommendations.',
      estimated_salary_range: null,
    }));

    await holisticPersonaRepo.upsertRecommendationsRoles({
      userId: null,
      personaId,
      buildId: null,
      inferredTags: [],
      roles: legacySimple,
    });

    const res = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res.status);
    expect(Array.isArray(res.body?.roles)).toBe(true);

    // Must NOT be a cache hit (we ignored legacy/simple cache).
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('cacheHit', false);

    // Bedrock was invoked.
    expect(mockGetInitial).toHaveBeenCalled();

    // Returned roles should look like initial role cards (match_metadata should exist from initial service layer).
    // We check for required_skills presence which legacy/simple cache does not have.
    expect(res.body.roles.every((r) => Array.isArray(r?.required_skills))).toBe(true);

    jest.dontMock('../../src/services/bedrockService');
  });
});
