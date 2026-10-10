import { describe, expect, test } from 'vitest';
import bossRecommendationSettings from './boss-recommendations.json';
import {
  bossRecommendationForCharacter,
  partyRecommendationsForCharacter,
  recommendationsForCharacter,
} from './bossRecommendations';

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

  test('uses solo fallback for unrecorded lower-line families but never for extreme difficulty', () => {
    expect(bossRecommendationForCharacter(character, [], {
      bossId: 'unlisted_papulatus',
      familyId: 'papulatus',
      name: '파풀라투스',
      difficulty: 'easy',
      changedPrice: 0,
    })).toMatchObject({ recommendationStatus: 'assumed-solo', recommendedPartySize: 1, multiplier: null });
    expect(bossRecommendationForCharacter(character, [], {
      bossId: 'unlisted_darknell',
      name: '듄켈',
      difficulty: 'normal',
      changedPrice: 0,
    })).toMatchObject({ recommendationStatus: 'assumed-solo', recommendedPartySize: 1, multiplier: null });
    expect(bossRecommendationForCharacter(character, [], {
      bossId: 'extreme_lotus',
      familyId: 'lotus',
      name: '스우',
      difficulty: 'extreme',
      changedPrice: 0,
    })).toMatchObject({ recommendationStatus: 'impossible', recommendedPartySize: null, multiplier: null });
  });

  test('uses the exact 33, 50, and 100 percent party thresholds', () => {
    const seren = bossById.get('normal_seren');
    const recommend = (multiplier) => bossRecommendationForCharacter(character, [
      { nickname: character.nickname, bossId: seren.bossId, multiplier },
    ], seren);

    expect(recommend(32)).toMatchObject({ recommendationStatus: 'impossible', recommendedPartySize: null });
    expect(recommend(33)).toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 3 });
    expect(recommend(49.9)).toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 3 });
    expect(recommend(50)).toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 2 });
    expect(recommend(99.9)).toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 2 });
    expect(recommend(100)).toMatchObject({ recommendationStatus: 'recorded', recommendedPartySize: 1 });
  });

  test('keeps party-needed recommendations for each difficulty within a boss family', () => {
    const multipliers = [
      { nickname: character.nickname, bossId: 'chaos_kalos', multiplier: 50 },
      { nickname: character.nickname, bossId: 'extreme_kalos', multiplier: 50 },
    ];
    const recommendations = recommendationsForCharacter(character, multipliers);
    const partyRecommendations = partyRecommendationsForCharacter(character, multipliers);

    expect(recommendations.find(({ familyId }) => familyId === 'kalos').bossId).toBe('extreme_kalos');
    expect(partyRecommendations.map(({ bossId }) => bossId)).toEqual(
      expect.arrayContaining(['chaos_kalos', 'extreme_kalos']),
    );
    expect(partyRecommendations.find(({ bossId }) => bossId === 'chaos_kalos'))
      .toMatchObject({ recommendedPartySize: 2, multiplier: 50 });
  });

  test('uses the schedule family key to apply multi-person boss caps', () => {
    const bellona = bossById.get('easy_bellona');
    const { familyId, ...scheduleOption } = bellona;
    const recommendation = bossRecommendationForCharacter(character, [
      { nickname: character.nickname, bossId: bellona.bossId, multiplier: 73.3 },
    ], { ...scheduleOption, familyKey: familyId });

    expect(recommendation).toMatchObject({
      recommendationStatus: 'recorded',
      maxPartySize: 3,
      recommendedPartySize: 2,
      multiplier: 73.3,
    });
  });
});
