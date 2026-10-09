import bossRecommendationSettings from './boss-recommendations.json';

const unrecordedSoloFamilyAliases = {
  '스우': 'lotus',
  '진힐라': 'verushilla',
  '듄켈': 'darknell',
  '윌': 'will',
  '가디언엔젤슬라임': 'slime',
  '더스크': 'gloom',
  '루시드': 'lucid',
  '데미안': 'damien',
  '파풀라투스': 'papulatus',
  '시그너스': 'cygnus',
  '핑크빈': 'pinkbean',
  '힐라': 'hilla',
  '매그너스': 'magnus',
  '아카이럼': 'arkarium',
  '반레온': 'vonleon',
  '반반': 'banban',
  '벨룸': 'vellum',
  '블러디퀸': 'bloodyqueen',
  '자쿰': 'zakum',
  '카웅': 'kawoong',
  '피에르': 'pierre',
  '혼테일': 'horntail',
};

function isAssumedSoloBoss(boss) {
  if (boss.difficulty === 'extreme') return false;
  const normalizedName = String(boss.name || '').replace(/\s+/g, '');
  const familyId = boss.familyId || unrecordedSoloFamilyAliases[normalizedName];
  return bossRecommendationSettings.unrecordedSoloBossIds.includes(boss.bossId)
    || bossRecommendationSettings.unrecordedSoloFamilies.includes(familyId);
}

export function maxPartySizeForBoss(boss) {
  const bossId = String(boss.bossId || '').toLowerCase();
  const familyId = boss.familyId || boss.familyKey;
  return bossRecommendationSettings.maxPartySizeByBoss?.[bossId]
    || bossRecommendationSettings.maxPartySizeByFamily[familyId]
    || bossRecommendationSettings.defaultMaxPartySize;
}

function readCharacterMultipliers(character, multipliers) {
  const multiplierByBoss = new Map();
  for (const entry of multipliers) {
    if (entry.nickname?.toLocaleLowerCase('ko') !== character.nickname.toLocaleLowerCase('ko')
      || typeof entry.bossId !== 'string') continue;
    const multiplier = Number(entry.multiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0) continue;
    const bossId = entry.bossId.toLowerCase();
    multiplierByBoss.set(bossId, Math.max(multiplier, multiplierByBoss.get(bossId) ?? -Infinity));
  }
  return multiplierByBoss;
}

function recommendationForMultiplier(boss, multiplier, includeSolo) {
  const maxPartySize = maxPartySizeForBoss(boss);
  const party = bossRecommendationSettings.partyMultiplierThresholds
    .filter(({ partySize, minimumMultiplier }) => (
      partySize <= maxPartySize && multiplier >= minimumMultiplier
    ))
    .sort((left, right) => left.partySize - right.partySize)[0];
  if (!party || (party.partySize === 1 && !includeSolo)) return null;
  return {
    ...boss,
    multiplier,
    maxPartySize,
    difficultyRank: bossRecommendationSettings.difficultyRanks[boss.difficulty] || 0,
    recommendedPartySize: party.partySize,
    personalPrice: boss.changedPrice / party.partySize,
    recommendationStatus: 'recorded',
  };
}

export function bossRecommendationForCharacter(character, multipliers, boss) {
  const multiplierByBoss = readCharacterMultipliers(character, multipliers);
  const multiplier = multiplierByBoss.get(boss.bossId.toLowerCase());
  if (multiplier !== undefined) {
    return recommendationForMultiplier(boss, multiplier, true) || {
      ...boss,
      multiplier,
      recommendedPartySize: null,
      recommendationStatus: 'impossible',
    };
  }
  const isAssumedSolo = isAssumedSoloBoss(boss);
  return {
    ...boss,
    multiplier: null,
    maxPartySize: maxPartySizeForBoss(boss),
    recommendedPartySize: isAssumedSolo ? 1 : null,
    recommendationStatus: isAssumedSolo ? 'assumed-solo' : 'impossible',
  };
}

export function recommendationsForCharacter(character, multipliers, { includeSolo = false } = {}) {
  const multiplierByBoss = readCharacterMultipliers(character, multipliers);
  const candidatesByFamily = new Map();
  for (const boss of bossRecommendationSettings.bosses) {
    const multiplier = multiplierByBoss.get(boss.bossId.toLowerCase());
    if (multiplier === undefined) continue;
    const candidate = recommendationForMultiplier(boss, multiplier, true);
    if (!candidate) continue;
    const familyCandidates = candidatesByFamily.get(boss.familyId) || [];
    familyCandidates.push(candidate);
    candidatesByFamily.set(boss.familyId, familyCandidates);
  }

  if (includeSolo) {
    const familiesWithRecordedRecommendations = new Set(candidatesByFamily.keys());
    for (const boss of bossRecommendationSettings.bosses) {
      if (familiesWithRecordedRecommendations.has(boss.familyId)
        || !isAssumedSoloBoss(boss)) continue;
      const familyCandidates = candidatesByFamily.get(boss.familyId) || [];
      familyCandidates.push({
        ...boss,
        multiplier: null,
        maxPartySize: maxPartySizeForBoss(boss),
        difficultyRank: bossRecommendationSettings.difficultyRanks[boss.difficulty] || 0,
        recommendedPartySize: 1,
        personalPrice: boss.changedPrice,
        recommendationStatus: 'assumed-solo',
      });
      candidatesByFamily.set(boss.familyId, familyCandidates);
    }
  }

  const bestByFamily = [...candidatesByFamily.values()].map((familyCandidates) => {
    const recordedCandidates = familyCandidates.filter(({ recommendationStatus }) => (
      recommendationStatus === 'recorded'
    ));
    const eligibleCandidates = recordedCandidates.length ? recordedCandidates : familyCandidates;
    const isHighDifficultyFamily = bossRecommendationSettings.highDifficultyOverrides
      .includes(eligibleCandidates[0].familyId);
    return eligibleCandidates.sort((left, right) => (
      (isHighDifficultyFamily ? right.difficultyRank - left.difficultyRank : right.personalPrice - left.personalPrice)
      || right.personalPrice - left.personalPrice
    ))[0];
  }).filter(({ recommendedPartySize }) => includeSolo || recommendedPartySize > 1);

  const sortByPersonalPrice = (left, right) => right.personalPrice - left.personalPrice
    || right.difficultyRank - left.difficultyRank
    || left.name.localeCompare(right.name, 'ko');
  const weekly = bestByFamily.filter(({ cycle }) => cycle === 'weekly').sort(sortByPersonalPrice);
  const monthly = bestByFamily.filter(({ cycle }) => cycle === 'monthly').sort(sortByPersonalPrice);
  return [
    ...weekly.slice(0, bossRecommendationSettings.recommendationLimit),
    ...monthly,
  ];
}
