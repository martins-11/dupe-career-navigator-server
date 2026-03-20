import request from 'supertest';

describe('GET /api/recommendations/initial uses a sufficient Bedrock time budget', () => {
  test('passes a >20s Bedrock timeBudgetMs even when INITIAL_RECOMMENDATIONS_MAX_MS is set low', async () => {
    jest.resetModules();

    // Simulate a too-low legacy/misconfiguration that previously caused ~14s aborts.
    process.env.INITIAL_RECOMMENDATIONS_MAX_MS = '15000';
    // Use default safety floor (25000ms) by ensuring min env var is not set.
    delete process.env.INITIAL_RECOMMENDATIONS_MIN_MS;

    // Ensure requestTimeout middleware selects the larger timeout for this endpoint.
    process.env.REQUEST_TIMEOUT_INITIAL_RECOMMENDATIONS_MS = '45000';

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

    const { default: app } = await import('../../src/server.js');

    const personaId = 'aef4a4b9-707e-4946-88de-5cc0dc31c099';
    const res = await request(app).get('/api/recommendations/initial').query({ personaId });

    expect([200]).toContain(res.status);
    expect(Array.isArray(res.body?.roles)).toBe(true);

    // Endpoint should return a stored pool >5 (UI may choose to display 5 initially).
    expect(res.body.roles.length).toBeGreaterThan(5);

    expect(mockGetInitial).toHaveBeenCalled();

    // Bedrock options are the 2nd arg: getInitialRecommendations(finalPersona, options)
    const calledOptions = mockGetInitial.mock.calls[0][1] || {};
    expect(typeof calledOptions.timeBudgetMs).toBe('number');

    // Previously this was ~14150ms; ensure it is now comfortably above 20s.
    expect(calledOptions.timeBudgetMs).toBeGreaterThanOrEqual(20000);

    jest.dontMock('../../src/services/bedrockService');
  });
});
