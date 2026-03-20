import { jest } from '@jest/globals';

describe('recommendationsInitialService (Bedrock-first; padding only when explicitly enabled)', () => {
  test('when Bedrock returns fewer than 5 valid roles and padding is disabled, the service throws bedrock_insufficient_roles', async () => {
    jest.resetModules();

    const mockGetInitial = jest.fn(async () => ({
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
    }));

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial
    }));

    const { generateInitialRecommendationsPersonaDrivenBedrockOnly } = await import(
      '../../src/services/recommendationsInitialService.js'
    );

    const finalPersona = {
      skills_with_proficiency: [
        { name: 'SQL', proficiency: 90 },
        { name: 'Node.js', proficiency: 85 },
        { name: 'React', proficiency: 50 },
        { name: 'Communication', proficiency: 55 },
        { name: 'Git', proficiency: 88 }
      ]
    };

    await expect(
      generateInitialRecommendationsPersonaDrivenBedrockOnly({
        finalPersona,
        personaId: 'p1',
        options: { allowPadding: false, maxAttempts: 2, requestedCount: 7, minCount: 5 }
      })
    ).rejects.toMatchObject({ code: 'bedrock_insufficient_roles' });

    // Should have attempted Bedrock more than once before giving up.
    expect(mockGetInitial).toHaveBeenCalled();
    expect(mockGetInitial.mock.calls.length).toBeGreaterThanOrEqual(1);

    jest.dontMock('../../src/services/bedrockService');
  });

  test('when Bedrock returns fewer than 5 valid roles and padding is explicitly enabled, the service pads to 5 with fallback-filled roles', async () => {
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
      personaId: 'p1',
      options: { allowPadding: true, maxAttempts: 1, requestedCount: 7, minCount: 5 }
    });

    expect(result).toBeTruthy();
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    const fallbackFilled = result.roles.filter((r) => r?.match_metadata?.isFallbackFilled === true);
    expect(fallbackFilled.length).toBeGreaterThanOrEqual(1);

    expect(result.meta).toBeTruthy();
    expect(result.meta.count).toBe(5);
    expect(result.meta.endpointPaddingUsed).toBe(true);
    expect(result.meta.paddedCount).toBeGreaterThanOrEqual(1);

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
          },
          {
            role_id: 'bedrock-4',
            role_title: 'Role Four',
            industry: 'Tech',
            salary_lpa_range: '₹15–₹28 LPA',
            experience_range: '3–5 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['Python', 'SQL', 'ETL', 'Data Modeling', 'Communication']
          },
          {
            role_id: 'bedrock-5',
            role_title: 'Role Five',
            industry: 'Tech',
            salary_lpa_range: '₹15–₹28 LPA',
            experience_range: '3–5 years',
            description: 'Desc.',
            key_responsibilities: ['A', 'B', 'C'],
            required_skills: ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring']
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
      personaId: 'p2',
      options: { allowPadding: false, maxAttempts: 1, requestedCount: 7, minCount: 5 }
    });

    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    for (const r of result.roles) {
      expect(r?.match_metadata?.isFallbackFilled).toBe(false);

      // required by UI: non-null scores for ring rendering
      expect(typeof r.compatibilityScore).toBe('number');
      expect(typeof r.finalCompatibilityScore).toBe('number');

      // fallback 3/2 tags are provided, but validation remains not_validated
      expect(r.threeTwoReport).toBeTruthy();
      expect(r.threeTwoReport.status).toBe('not_validated');

      expect(Array.isArray(r.masteryAreas)).toBe(true);
      expect(Array.isArray(r.growthAreas)).toBe(true);

      // metadata indicates fallback scoring mode was used
      expect(r.match_metadata?.scoring?.hadUserProficiencies).toBe(false);
      expect(r.match_metadata?.scoring?.fallbackMode).toBe('overlap_without_proficiency');
    }

    expect(result.meta).toBeTruthy();
    expect(result.meta.count).toBe(5);

    jest.dontMock('../../src/services/bedrockService');
  });
});
