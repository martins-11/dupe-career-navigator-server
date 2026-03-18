'use strict';

describe('recommendationsInitialService - fallback only (no Bedrock)', () => {
  test('returns exactly 5 roles and does not call bedrockService.getInitialRecommendations', async () => {
    jest.resetModules();

    const mockGetInitial = jest.fn(async () => {
      throw new Error('Bedrock should not be called in fallback-only mode');
    });

    jest.doMock('../../src/services/bedrockService', () => ({
      getInitialRecommendations: mockGetInitial,
    }));

    // eslint-disable-next-line global-require
    const { generateInitialRecommendationsFallbackOnly } = require('../../src/services/recommendationsInitialService');

    const result = await generateInitialRecommendationsFallbackOnly({
      finalPersona: {
        // keep minimal persona; scoring should still be deterministic
        skills: ['SQL', 'Communication'],
      },
      personaId: 'p_fallback',
      options: { minCount: 5 },
    });

    expect(result).toBeTruthy();
    expect(Array.isArray(result.roles)).toBe(true);
    expect(result.roles).toHaveLength(5);

    // Fallback-only should never invoke Bedrock.
    expect(mockGetInitial).not.toHaveBeenCalled();

    // Ensure UI-required fields exist.
    for (const r of result.roles) {
      expect(r).toHaveProperty('role_title');
      expect(r).toHaveProperty('industry');
      expect(r).toHaveProperty('required_skills');
      expect(r).toHaveProperty('compatibilityScore');
      expect(r).toHaveProperty('threeTwoReport');
      expect(r?.match_metadata?.isFallbackFilled).toBe(true);
    }

    expect(result.meta).toBeTruthy();
    expect(result.meta.endpointFallbackUsed).toBe(true);

    jest.dontMock('../../src/services/bedrockService');
  });
});
