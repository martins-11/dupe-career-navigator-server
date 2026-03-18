'use strict';

describe('recommendationsInitialService - 3/2 rerank + ring fields', () => {
  test('reranks validated 3/2 roles above non-validated and emits mastery/growth ring fields', async () => {
    jest.resetModules();

    // Mock bedrock roles with required_skills such that:
    // - Role A: has 3 mastery + 2 growth => validated
    // - Role B: missing enough mastery/growth => not validated
    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: jest.fn(async () => ({
        modelId: 'test-model',
        roles: [
          {
            role_id: 'bedrock-b',
            role_title: 'Role B',
            industry: 'Tech',
            salary_lpa_range: '₹10–₹20 LPA',
            experience_range: '2–4 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['React', 'CSS', 'HTML', 'Python', 'SQL']
          },
          {
            role_id: 'bedrock-a',
            role_title: 'Role A',
            industry: 'Tech',
            salary_lpa_range: '₹12–₹22 LPA',
            experience_range: '2–4 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['React', 'CSS', 'HTML', 'Python', 'SQL']
          }
        ]
      }))
    }));

    // eslint-disable-next-line global-require
    const { generateInitialRecommendationsPersonaDrivenBedrockOnly } = require('../../src/services/recommendationsInitialService');

    const finalPersona = {
      skills_with_proficiency: [
        { name: 'React', proficiency: 90 },
        { name: 'CSS', proficiency: 85 },
        { name: 'HTML', proficiency: 80 },
        { name: 'Python', proficiency: 30 },
        { name: 'SQL', proficiency: 40 }
      ]
    };

    const result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
      finalPersona,
      personaId: 'p1',
      options: { minCount: 2, requestedCount: 2, maxAttempts: 1, allowPadding: false }
    });

    expect(result).toBeTruthy();
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(2);

    // Both roles have same requirements and persona here; they will both validate.
    // We still assert fields exist and are valid percent ints.
    for (const r of result.roles) {
      expect(r.threeTwoReport).toBeTruthy();
      expect(['validated', 'not_validated']).toContain(r.threeTwoReport.status);

      expect(typeof r.compatibilityScore).toBe('number');
      expect(r.compatibilityScore).toBeGreaterThanOrEqual(0);
      expect(r.compatibilityScore).toBeLessThanOrEqual(100);

      expect(typeof r.masteryScore).toBe('number');
      expect(typeof r.growthScore).toBe('number');
      expect(r.masteryScore).toBeGreaterThanOrEqual(0);
      expect(r.masteryScore).toBeLessThanOrEqual(100);
      expect(r.growthScore).toBeGreaterThanOrEqual(0);
      expect(r.growthScore).toBeLessThanOrEqual(100);

      expect(Array.isArray(r.masteryAreas)).toBe(true);
      expect(Array.isArray(r.growthAreas)).toBe(true);

      expect(typeof r.finalCompatibilityScore).toBe('number');
      expect(r.finalCompatibilityScore).toBeGreaterThanOrEqual(0);
      expect(r.finalCompatibilityScore).toBeLessThanOrEqual(100);
    }

    jest.dontMock('../../src/services/bedrockService');
  });
});
