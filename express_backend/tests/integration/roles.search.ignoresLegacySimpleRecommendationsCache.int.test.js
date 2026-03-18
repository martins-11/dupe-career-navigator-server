'use strict';

const request = require('supertest');

describe('GET /api/roles/search ignores legacy/simple cached recommendations roles and uses Bedrock', () => {
  test('when cached pool is legacy /api/recommendations/roles-shaped, /api/roles/search calls Bedrock and returns those roles', async () => {
    jest.resetModules();

    const mockGenerateTargetedRolesSafe = jest.fn(async () => ({
      usedFallback: false,
      modelId: 'test-model',
      prompt: 'test-prompt',
      roles: [
        {
          role_id: 'bedrock-1',
          role_title: 'AI Suggested Role 1',
          industry: 'Tech',
          salary_range: '₹18–₹30 LPA',
          required_skills: ['Skill1', 'Skill2', 'Skill3', 'Skill4', 'Skill5'],
          key_responsibilities: ['A', 'B', 'C'],
          match_metadata: { source: 'bedrock' },
          is_targetable: true,
        },
      ],
      bedrockJsonRoles: null,
    }));

    jest.doMock('../../src/services/bedrockService', () => ({
      generateTargetedRolesSafe: mockGenerateTargetedRolesSafe,
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

    const res = await request(app)
      .get('/api/roles/search')
      .query({ q: 'engineer', personaId, limit: 10 });

    expect([200]).toContain(res.status);
    expect(Array.isArray(res.body)).toBe(true);

    // Should come from mocked Bedrock, not from legacy cache
    expect(mockGenerateTargetedRolesSafe).toHaveBeenCalled();
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('role_title', 'AI Suggested Role 1');

    jest.dontMock('../../src/services/bedrockService');
  });
});
