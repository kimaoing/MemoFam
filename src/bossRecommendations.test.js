import { describe, expect, test } from 'vitest';
import bossRecommendationSettings from './boss-recommendations.json';
import { bossRecommendationForCharacter, recommendationsForCharacter } from './bossRecommendations';

const character = { nickname: '테스트' };
const bossById = new Map(bossRecommendationSettings.bosses.map((boss) => [boss.bossId, boss]));

describe('boss recommendations', () => {
  test('uses solo fallback for unrecorded lower-line bosses and marks upper-line bosses impossible', () => {
    const recommendations = recommendationsForCharacter(character, [], { includeSolo: true });
    const papulatus = recommendations.find(({ familyId }) => familyId === 'papulatus');

    expect(papulatus).toMatchObject({
      bossId: 'chaos_papulatus',
      multiplier: null,
      recommendedPartySize: 1,
      recommendationStatus: 'assumed-solo',
    });
    expect(recommendations.some(({ familyId }) => familyId === 'seren')).toBe(false);
    expect(bossRecommendationForCharacter(character, [], bossById.get('normal_seren')))
      .toMatchObject({ recommendationStatus: 'impossible', recommendedPartySize: null });
  });

  test('prefers the hardest feasible difficulty even when solo recommendations are excluded', () => {
    const multipliers = [
      { nickname: character.nickname, bossId: 'normal_seren', multiplier: 100 },
      { nickname: character.nickname, bossId: 'hard_seren', multiplier: 100 },
    ];
    const soloRecommendations = recommendationsForCharacter(character, multipliers, { includeSolo: true });
    const partyRecommendations = recommendationsForCharacter(character, multipliers);

    expect(soloRecommendations.find(({ familyId }) => familyId === 'seren'))
      .toMatchObject({ bossId: 'hard_seren', recommendedPartySize: 1, multiplier: 100 });
    expect(partyRecommendations.some(({ familyId }) => familyId === 'seren')).toBe(false);
  });

  test('respects each boss family party cap and requires 100% for a solo clear', () => {
    const characterMultipliers = [
      { nickname: character.nickname, bossId: 'chaos_kalos', multiplier: 33 },
      { nickname: character.nickname, bossId: 'hard_bardrix', multiplier: 33 },
      { nickname: character.nickname, bossId: 'normal_bardrix', multiplier: 100 },
    ];
    const hardSoloMultiplier = [
      { nickname: character.nickname, bossId: 'hard_bardrix', multiplier: 100 },
    ];
    const recommendations = recommendationsForCharacter(character, characterMultipliers, { includeSolo: true });

    expect(bossRecommendationForCharacter(character, characterMultipliers, bossById.get('chaos_kalos')))
      .toMatchObject({ recommendationStatus: 'impossible', recommendedPartySize: null });
    expect(bossRecommendationForCharacter(character, [
      { nickname: character.nickname, bossId: 'chaos_kalos', multiplier: 50 },
    ], bossById.get('chaos_kalos')))
      .toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 2 });
    expect(recommendations.find(({ familyId }) => familyId === 'bardrix'))
      .toMatchObject({ bossId: 'hard_bardrix', recommendedPartySize: 3 });
    expect(bossRecommendationForCharacter(character, hardSoloMultiplier, bossById.get('hard_bardrix')))
      .toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 1 });
  });
});
