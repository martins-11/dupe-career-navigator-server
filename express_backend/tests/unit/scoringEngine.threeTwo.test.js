import { validateThreeTwoBalance, buildThreeTwoReport } from '../../src/services/scoringEngine.js';

describe('Day 3 scoringEngine - 3/2 validation', () => {
  test('Mock verification: Full Stack role validates exactly 3 mastery + 2 growth areas', () => {
    // Mock user per requirements
    const userSkills = [
      { name: 'React', proficiency: 90 },
      { name: 'CSS', proficiency: 85 },
      { name: 'HTML', proficiency: 80 },
      { name: 'Python', proficiency: 30 },
      { name: 'SQL', proficiency: 40 },
    ];

    // "Full Stack" role requirements; include all 5 for unambiguous matching
    const fullStackRoleRequirements = ['React', 'CSS', 'HTML', 'Python', 'SQL'];

    const result = validateThreeTwoBalance(userSkills, fullStackRoleRequirements);

    expect(result.isValidThreeTwo).toBe(true);

    // Must identify exactly these 5 areas (order is deterministic by proficiency desc)
    expect(result.masteryAreas).toEqual(['React', 'CSS', 'HTML']);
    expect(result.growthAreas).toEqual(['SQL', 'Python']); // growth sorted by proficiency desc: 40 then 30

    const report = buildThreeTwoReport(userSkills, fullStackRoleRequirements);
    expect(report).toEqual({
      status: 'validated',
      masteryAreas: ['React', 'CSS', 'HTML'],
      growthAreas: ['SQL', 'Python'],
      score: 100,
    });
  });
});
