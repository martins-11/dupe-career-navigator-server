'use strict';

const request = require('supertest');

describe('GET /api/recommendations/pool prefers Bedrock pool and is cacheable for reuse', () => {
  test('generates via Bedrock then serves cached Bedrock roles on subsequent call (no guest_* fallback)', async () => {
    jest.resetModules();

    // Ensure the pool desires >5 roles.
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

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';

    // 1) First call should generate and NOT be a cache hit.
    const res1 = await request(app).get('/api/recommendations/pool').query({ personaId });

    expect([200]).toContain(res1.status);
    expect(Array.isArray(res1.body?.roles)).toBe(true);
    expect(res1.body.roles.length).toBeGreaterThan(5);

    // Should not resemble /api/recommendations/roles fallback.
    expect(res1.body.roles.some((r) => String(r?.role_id || '').startsWith('guest_'))).toBe(false);

    expect(res1.body).toHaveProperty('meta');
    expect(res1.body.meta).toHaveProperty('cacheHit', false);

    // 2) Second call should be a cache hit and still not guest_*.
    const res2 = await request(app).get('/api/recommendations/pool').query({ personaId });

    expect([200]).toContain(res2.status);
    expect(Array.isArray(res2.body?.roles)).toBe(true);
    expect(res2.body.roles.length).toBeGreaterThan(5);
    expect(res2.body.roles.some((r) => String(r?.role_id || '').startsWith('guest_'))).toBe(false);

    expect(res2.body).toHaveProperty('meta');
    expect(res2.body.meta).toHaveProperty('cacheHit', true);

    // Bedrock was invoked at least once.
    expect(mockGetInitial).toHaveBeenCalled();

    jest.dontMock('../../src/services/bedrockService');
  });

  test('when Bedrock returns fewer roles than storeCount, service persists them and subsequent call is a cacheHit (no second Bedrock call)', async () => {
    jest.resetModules();

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

    // Simulate Bedrock returning fewer roles than requested (e.g., 7 instead of 12).
    const mockGetInitial = jest.fn(async (_finalPersona, options) => {
      const requested = Number(options?.count || 12);
      const returned = Math.min(7, requested);
      return {
        modelId: 'test-model',
        prompt: 'test-prompt',
        usedFallback: false,
        roles: new Array(returned).fill(null).map((_, idx) => makeRole(idx + 1)),
      };
    });

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial,
    }));

    // eslint-disable-next-line global-require
    const app = require('../../src/server');

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';

    const res1 = await request(app).get('/api/recommendations/pool').query({ personaId });

    expect([200]).toContain(res1.status);
    expect(Array.isArray(res1.body?.roles)).toBe(true);
    expect(res1.body.roles.length).toBe(7);
    expect(res1.body).toHaveProperty('meta');
    expect(res1.body.meta).toHaveProperty('cacheHit', false);

    const res2 = await request(app).get('/api/recommendations/pool').query({ personaId });

    expect([200]).toContain(res2.status);
    expect(Array.isArray(res2.body?.roles)).toBe(true);
    expect(res2.body.roles.length).toBe(7);
    expect(res2.body).toHaveProperty('meta');
    expect(res2.body.meta).toHaveProperty('cacheHit', true);
    expect(res2.body.meta).toHaveProperty('cacheUndersized', true);

    // Critical assertion: only one upstream call across both requests.
    expect(mockGetInitial).toHaveBeenCalledTimes(1);

    jest.dontMock('../../src/services/bedrockService');
  });
});
