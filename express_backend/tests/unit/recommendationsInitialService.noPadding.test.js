'use strict';

describe('recommendationsInitialService (Bedrock-only, no deterministic padding)', () => {
  test('returns only Bedrock roles when Bedrock returns 3 (no padding, no fallback-filled roles)', async () => {
    jest.resetModules();

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: jest.fn(async () => ({
        modelId: 'test-model',
        roles: [
          {
            role_id: 'bedrock-1',
            role_title: 'Role One',
            industry: 'Tech',
            salary_lpa_range: '₹10–₹20 LPA',
            experience_range: '2–4 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['SQL', 'Excel', 'Communication', 'Stats', 'Dashboards']
          },
          {
            role_id: 'bedrock-2',
            role_title: 'Role Two',
            industry: 'Tech',
            salary_lpa_range: '₹12–₹22 LPA',
            experience_range: '2–4 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['Node.js', 'Express', 'SQL', 'API Design', 'Observability']
          },
          {
            role_id: 'bedrock-3',
            role_title: 'Role Three',
            industry: 'Tech',
            salary_lpa_range: '₹15–₹28 LPA',
            experience_range: '3–5 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['JavaScript', 'React', 'Node.js', 'REST APIs', 'Git']
          }
        ]
      }))
    }));

    // eslint-disable-next-line global-require
    const { generateInitialRecommendationsPersonaDrivenBedrockOnly } = require('../../src/services/recommendationsInitialService');

    const finalPersona = {
      skills_with_proficiency: [
        { name: 'SQL', proficiency: 90 },
        { name: 'Node.js', proficiency: 85 },
        { name: 'React', proficiency: 50 },
        { name: 'Communication', proficiency: 55 },
        { name: 'Git', proficiency: 88 }
      ]
    };

    const result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
      finalPersona,
      personaId: 'p1'
    });

    expect(result).toBeTruthy();
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(3);

    // No deterministic padding: all should be non-fallback.
    for (const r of result.roles) {
      expect(r?.match_metadata?.isFallbackFilled).toBe(false);
    }

    // Deterministic: Bedrock roles preserved ordering
    expect(result.roles[0].role_title).toBe('Role One');
    expect(result.roles[1].role_title).toBe('Role Two');
    expect(result.roles[2].role_title).toBe('Role Three');

    // Scoring should run when numeric proficiencies exist.
    for (const r of result.roles) {
      expect(typeof r.compatibilityScore === 'number').toBe(true);
      expect(r.threeTwoReport).toBeTruthy();
      expect(r.match_metadata?.scoring?.hadUserProficiencies).toBe(true);
      expect(r.match_metadata?.scoring?.scoringSkipped).toBe(false);
    }

    expect(result.meta).toBeTruthy();
    expect(result.meta.count).toBe(3);
    expect(result.meta.paddedCount).toBe(0);
    expect(result.meta.endpointPaddingUsed).toBe(false);
    expect(result.meta.endpointFallbackUsed).toBe(false);

    jest.dontMock('../../src/services/bedrockService');
  });

  test('when persona has no numeric proficiencies, backend emits deterministic fallback compatibility and mastery/growth tags', async () => {
    jest.resetModules();

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: jest.fn(async () => ({
        modelId: 'test-model',
        roles: [
          {
            role_id: 'bedrock-1',
            role_title: 'Role One',
            industry: 'Tech',
            salary_lpa_range: '₹10–₹20 LPA',
            experience_range: '2–4 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['SQL', 'Excel', 'Communication', 'Stats', 'Dashboards']
          }
        ]
      }))
    }));

    // eslint-disable-next-line global-require
    const { generateInitialRecommendationsPersonaDrivenBedrockOnly } = require('../../src/services/recommendationsInitialService');

    const finalPersona = {
      // only strings -> no numeric proficiencies
      skills: ['SQL', 'Excel', 'Communication']
    };

    const result = await generateInitialRecommendationsPersonaDrivenBedrockOnly({
      finalPersona,
      personaId: 'p2'
    });

    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(1);

    for (const r of result.roles) {
      expect(r?.match_metadata?.isFallbackFilled).toBe(false);

      // Now required by UI: non-null scores for ring rendering
      expect(typeof r.compatibilityScore).toBe('number');
      expect(typeof r.finalCompatibilityScore).toBe('number');
      expect(r.compatibilityScore).toBeGreaterThanOrEqual(0);
      expect(r.compatibilityScore).toBeLessThanOrEqual(100);

      // Fallback 3/2 tags are provided, but validation remains not_validated
      expect(r.threeTwoReport).toBeTruthy();
      expect(r.threeTwoReport.status).toBe('not_validated');

      expect(Array.isArray(r.masteryAreas)).toBe(true);
      expect(Array.isArray(r.growthAreas)).toBe(true);
      expect(r.masteryAreas.length).toBeLessThanOrEqual(3);
      expect(r.growthAreas.length).toBeLessThanOrEqual(2);

      // Metadata indicates fallback mode was used
      expect(r.match_metadata?.scoring?.hadUserProficiencies).toBe(false);
      expect(r.match_metadata?.scoring?.scoringSkipped).toBe(false);
      expect(r.match_metadata?.scoring?.fallbackMode).toBe('overlap_without_proficiency');
    }

    expect(result.meta).toBeTruthy();
    expect(result.meta.count).toBe(1);
    expect(result.meta.endpointPaddingUsed).toBe(false);
    expect(result.meta.paddedCount).toBe(0);

    jest.dontMock('../../src/services/bedrockService');
  });
});
