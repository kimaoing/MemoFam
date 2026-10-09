import { useEffect, useRef, useState } from 'react';
import './App.css';
import { workerRequest } from './workerApi';
import bossRecommendationSettings from './boss-recommendations.json';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const workerApiUrl = import.meta.env.VITE_WORKER_API_URL;
const mapleScouterOrigin = 'https://maplescouter.com';
const mapleScouterMessageType = 'maple-scout/maplescouter-import';
const extensionCheckType = 'maple-scout/extension-check';
const extensionStatusType = 'maple-scout/extension-status';
const rememberLoginKey = 'maple-scout-remember-login';
const themeKey = 'maple-scout-theme';
const schedulePreferencesKeyPrefix = 'maple-scout-schedule-preferences:';
const activeCharactersKeyPrefix = 'maple-scout-active-characters:';
const nexonApiKeyCookie = 'maple-scout-nexon-api-key';
const nexonApiKeyCookieMaxAge = 60 * 60 * 24 * 30;
const bossImages = import.meta.glob('./bossImage/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
});

function getGoogleAccessToken(prompt = 'select_account') {
  return new Promise((resolve, reject) => {
    const google = window.google;
    if (!google?.accounts?.oauth2 || !clientId) {
      reject(new Error('Google OAuth Client ID 설정을 확인해 주세요.'));
      return;
    }

    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: (response) => {
        if (response.error) reject(new Error(response.error_description || response.error));
        else resolve(response.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

async function getGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('Google 계정 정보를 가져오지 못했습니다.');
  return response.json();
}

function checkMapleScouterExtension() {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timeoutId;
    const finish = (installed) => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('message', receiveStatus);
      resolve(installed);
    };
    const receiveStatus = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== extensionStatusType || event.data.requestId !== requestId) return;
      finish(event.data.installed === true);
    };

    window.addEventListener('message', receiveStatus);
    timeoutId = window.setTimeout(() => finish(false), 600);
    window.postMessage({ type: extensionCheckType, requestId }, window.location.origin);
  });
}

function isIncomplete(item, boss = false) {
  if (boss) return item.complete_flag !== 'true' && item.complete_flag !== true;
  if (item.type === 'quest' && item.quest_state !== null && item.quest_state !== undefined) {
    return String(item.quest_state) !== '2';
  }
  const maximum = Number(item.max_count || 0);
  if (maximum > 0) return Number(item.now_count || 0) < maximum;
  return item.registration_flag === 'true' || item.registration_flag === true;
}

function isRegistered(item) {
  return item.registration_flag === 'true' || item.registration_flag === true;
}

function scheduleItemKey(item) {
  return String(item.content_name || '').trim().toLocaleLowerCase('ko');
}

function readPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readNexonApiKeyCookie() {
  const cookiePrefix = `${nexonApiKeyCookie}=`;
  const cookie = document.cookie.split('; ').find((item) => item.startsWith(cookiePrefix));
  return cookie ? decodeURIComponent(cookie.slice(cookiePrefix.length)) : '';
}

function saveNexonApiKeyCookie(apiKey) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${nexonApiKeyCookie}=${encodeURIComponent(apiKey)}; Max-Age=${nexonApiKeyCookieMaxAge}; Path=/; SameSite=Strict${secure}`;
  if (readNexonApiKeyCookie() !== apiKey) {
    throw new Error('브라우저가 API 키 쿠키를 저장하지 못했습니다.');
  }
}

function clearNexonApiKeyCookie() {
  document.cookie = `${nexonApiKeyCookie}=; Max-Age=0; Path=/; SameSite=Strict`;
}

function activeCharactersStorageKey(email) {
  return `${activeCharactersKeyPrefix}${email.trim().toLowerCase()}`;
}

function readActiveCharacterIds(email, characters) {
  try {
    const savedIds = JSON.parse(window.localStorage.getItem(activeCharactersStorageKey(email)) || '[]');
    if (!Array.isArray(savedIds)) return [];
    const availableIds = new Set(characters.map(({ ocid }) => ocid));
    return [...new Set(savedIds.filter((ocid) => typeof ocid === 'string' && availableIds.has(ocid)))];
  } catch {
    return [];
  }
}

function validActiveCharacterIds(ids, characters) {
  if (!Array.isArray(ids)) return [];
  const availableIds = new Set(characters.map(({ ocid }) => ocid));
  return [...new Set(ids.filter((ocid) => typeof ocid === 'string' && availableIds.has(ocid)))];
}

function recommendationsForCharacter(character, multipliers) {
  const multiplierByBoss = new Map();
  for (const entry of multipliers) {
    if (entry.nickname?.toLocaleLowerCase('ko') !== character.nickname.toLocaleLowerCase('ko')) continue;
    const value = Number(entry.multiplier);
    const key = entry.bossId.toLowerCase();
    multiplierByBoss.set(key, Math.max(value, multiplierByBoss.get(key) || 0));
  }
  const candidatesByFamily = new Map();
  for (const boss of bossRecommendationSettings.bosses) {
    const multiplier = multiplierByBoss.get(boss.bossId.toLowerCase());
    if (!Number.isFinite(multiplier)) continue;
    const maxPartySize = bossRecommendationSettings.maxPartySizeByFamily[boss.familyId]
      || bossRecommendationSettings.defaultMaxPartySize;
    const party = bossRecommendationSettings.partyMultiplierThresholds
      .filter(({ partySize, minimumMultiplier }) => (
        partySize <= maxPartySize && multiplier >= minimumMultiplier
      ))
      .sort((left, right) => left.partySize - right.partySize)[0];
    if (!party) continue;
    const candidate = {
      ...boss,
      multiplier,
      maxPartySize,
      difficultyRank: bossRecommendationSettings.difficultyRanks[boss.difficulty] || 0,
      recommendedPartySize: party.partySize,
      personalPrice: boss.changedPrice / party.partySize,
    };
    const familyCandidates = candidatesByFamily.get(boss.familyId) || [];
    familyCandidates.push(candidate);
    candidatesByFamily.set(boss.familyId, familyCandidates);
  }
  const bestByFamily = [...candidatesByFamily.values()].map((familyCandidates) => {
    const override = bossRecommendationSettings.highDifficultyOverrides.includes(familyCandidates[0].familyId);
    if (override) {
      return familyCandidates.sort((left, right) => right.difficultyRank - left.difficultyRank
        || right.personalPrice - left.personalPrice)[0];
    }
    return familyCandidates.sort((left, right) => right.personalPrice - left.personalPrice
      || right.difficultyRank - left.difficultyRank)[0];
  });
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

function bossDetails(bossId) {
  const boss = bossRecommendationSettings.bosses.find((entry) => entry.bossId.toLowerCase() === bossId.toLowerCase());
  return boss ? {
    ...boss,
    maxPartySize: bossRecommendationSettings.maxPartySizeByFamily[boss.familyId]
      || bossRecommendationSettings.defaultMaxPartySize,
  } : { bossId, name: bossId, difficultyLabel: '', maxPartySize: 1, cycle: 'weekly' };
}

const scheduleDifficultyLabels = {
  easy: '이지',
  normal: '노말',
  hard: '하드',
  extreme: '익스트림',
  chaos: '카오스',
};

function scheduleBossOption(item) {
  const rawName = String(item.content_name || '').trim();
  const compactName = rawName.toLocaleLowerCase('ko').replace(/\s+/g, ' ');
  const name = ['칼로스', '감시자 칼로스', 'guardian kalos', 'kalos'].includes(compactName)
    ? '감시자 칼로스'
    : ['검은마법사', '검은 마법사', 'black mage'].includes(compactName)
      ? '검은 마법사'
      : rawName;
  const difficulty = String(item.difficulty || item.difficulty_name || '').trim().toLowerCase();
  const config = bossRecommendationSettings.bosses.find((boss) => (
    boss.name.toLocaleLowerCase('ko') === name.toLocaleLowerCase('ko')
      && boss.difficulty === difficulty
  ));
  const familyKey = config?.familyId || name.toLocaleLowerCase('ko');
  return {
    name,
    familyKey,
    difficulty,
    difficultyLabel: scheduleDifficultyLabels[difficulty] || difficulty,
    cycle: config?.cycle || (item.cycle === 'bossMonthly' ? 'monthly' : 'weekly'),
    key: `${familyKey}::${difficulty}`,
  };
}

function registeredScheduleKeys(items) {
  return [...new Set(items.filter(isRegistered).map(scheduleItemKey))];
}

function registeredBossKeys(items) {
  const selected = [];
  const families = new Set();
  let weeklyCount = 0;
  for (const item of items) {
    if (!isRegistered(item)) continue;
    const option = scheduleBossOption(item);
    if (families.has(option.familyKey)) continue;
    if (option.cycle === 'weekly' && weeklyCount >= bossRecommendationSettings.maxBossesPerCharacter) continue;
    selected.push(option.key);
    families.add(option.familyKey);
    if (option.cycle === 'weekly') weeklyCount += 1;
  }
  return selected;
}

function weeklyBossSelectionCount(keys) {
  return keys.filter((key) => {
    const familyId = key.slice(0, key.lastIndexOf('::'));
    return !bossRecommendationSettings.bosses.some((boss) => (
      boss.familyId === familyId && boss.cycle === 'monthly'
    ));
  }).length;
}

function limitBossKeysToWeeklyCap(keys) {
  const families = new Set();
  let weeklyCount = 0;
  return keys.filter((key) => {
    const familyId = key.slice(0, key.lastIndexOf('::'));
    if (families.has(familyId)) return false;
    families.add(familyId);
    const isMonthly = bossRecommendationSettings.bosses.some((boss) => (
      boss.familyId === familyId && boss.cycle === 'monthly'
    ));
    if (isMonthly) return true;
    if (weeklyCount >= bossRecommendationSettings.maxBossesPerCharacter) return false;
    weeklyCount += 1;
    return true;
  });
}

function summarizeBossParty(party) {
  const boss = bossDetails(party.bossId);
  const members = party.members || [];
  const totalMultiplier = members.reduce((total, member) => total + (Number(member.multiplier) || 0), 0);
  const matchingSchedules = members.flatMap((member) => (member.scheduler?.boss_contents || [])
    .filter((item) => {
      const option = scheduleBossOption(item);
      return option.familyKey === boss.familyId && option.difficulty === boss.difficulty;
    }));
  const cleared = matchingSchedules.some((item) => item.complete_flag === true || item.complete_flag === 'true');
  return {
    totalMultiplier,
    ready: totalMultiplier >= 100,
    cleared,
    statusLabel: cleared ? '클리어 확인' : matchingSchedules.length ? '미클리어' : '일정 확인 불가',
  };
}

function readSchedulePreferences(email) {
  try {
    return JSON.parse(window.localStorage.getItem(`${schedulePreferencesKeyPrefix}${email.toLowerCase()}`) || '{}');
  } catch {
    return {};
  }
}

function groupCharactersByWorld(characters) {
  const getScore = (character) => {
    const score = character.boss380HexaScore;
    return score !== null && score !== undefined && Number.isFinite(Number(score))
      ? Number(score)
      : null;
  };
  const compareScore = (left, right) => {
    const leftScore = getScore(left);
    const rightScore = getScore(right);
    if (leftScore === null) return rightScore === null ? 0 : 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore;
  };
  const worldGroups = new Map();
  for (const character of characters) {
    const worldName = character.worldName || '월드 정보 없음';
    const worldCharacters = worldGroups.get(worldName) || [];
    worldCharacters.push(character);
    worldGroups.set(worldName, worldCharacters);
  }

  return [...worldGroups.entries()]
    .map(([worldName, worldCharacters]) => ({
      worldName,
      characters: worldCharacters.sort((left, right) => (
        compareScore(left, right)
        || (Number(right.level) || 0) - (Number(left.level) || 0)
        || left.nickname.localeCompare(right.nickname, 'ko')
      )),
    }))
    .sort((left, right) => (
      compareScore(left.characters[0], right.characters[0])
      || (Number(right.characters[0]?.level) || 0) - (Number(left.characters[0]?.level) || 0)
      || left.worldName.localeCompare(right.worldName, 'ko')
    ));
}

function App() {
  const [accessToken, setAccessToken] = useState('');
  const [account, setAccount] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [activeCharacterIds, setActiveCharacterIds] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characterSearch, setCharacterSearch] = useState('');
  const [characterWorldFilter, setCharacterWorldFilter] = useState('');
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [multipliers, setMultipliers] = useState([]);
  const [groupCharacters, setGroupCharacters] = useState([]);
  const [groupParties, setGroupParties] = useState([]);
  const [allGroupCharacters, setAllGroupCharacters] = useState([]);
  const [allGroupMultipliers, setAllGroupMultipliers] = useState([]);
  const [allGroupParties, setAllGroupParties] = useState([]);
  const [focusedPartyId, setFocusedPartyId] = useState('');
  const [draggedPartyCharacter, setDraggedPartyCharacter] = useState(null);
  const [dragOverPartyId, setDragOverPartyId] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [schedulePreferences, setSchedulePreferences] = useState({});
  const [nexonKey, setNexonKey] = useState(readNexonApiKeyCookie);
  const [newGroupName, setNewGroupName] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [mapleScouterProgress, setMapleScouterProgress] = useState(null);
  const [showExtensionInstallHelp, setShowExtensionInstallHelp] = useState(false);
  const [view, setView] = useState('characters');
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(() => readPreference(rememberLoginKey, 'false') === 'true');
  const [rememberApiKey, setRememberApiKey] = useState(() => Boolean(readNexonApiKeyCookie()));
  const [theme, setTheme] = useState(() => readPreference(themeKey, 'dark'));
  const restoreLoginOnMount = useRef(rememberLogin);
  const loginRestoreAttempted = useRef(false);
  const mapleScouterPopup = useRef(null);
  const mapleScouterRequest = useRef(null);
  const mapleScouterTimeout = useRef(null);
  const characterSelectionSaveQueue = useRef(Promise.resolve());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#171922' : '#f4f5f8',
    );
    try {
      window.localStorage.setItem(themeKey, theme);
    } catch {
      // Keep the selected theme for this page even if browser storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    function receiveMapleScouterResult(event) {
      if (event.origin !== mapleScouterOrigin || event.source !== mapleScouterPopup.current) return;
      const request = mapleScouterRequest.current;
      const payload = event.data?.type === mapleScouterMessageType ? event.data.payload : null;
      if (!request || !payload) return;

      if (mapleScouterTimeout.current) window.clearTimeout(mapleScouterTimeout.current);
      mapleScouterTimeout.current = null;
      mapleScouterRequest.current = null;
      request.resolve(payload);
    }

    window.addEventListener('message', receiveMapleScouterResult);
    return () => {
      window.removeEventListener('message', receiveMapleScouterResult);
    };
  }, []);

  const reportError = (error) => {
    setNotice({ type: 'error', text: error.message || '요청에 실패했습니다.' });
  };

  async function loadGroupData(token, groupId) {
    if (!groupId) {
      setMultipliers([]);
      setGroupCharacters([]);
      setGroupParties([]);
      setInviteLink('');
      return;
    }
    const [multiplierResult, characterResult, partyResult] = await Promise.all([
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/multipliers`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/characters`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/parties`),
    ]);
    setMultipliers(multiplierResult.multipliers);
    setGroupCharacters(characterResult.characters || []);
    setGroupParties(partyResult.parties || []);
  }

  async function loadAllGroupPartyData(token, groupsToLoad = groups) {
    const results = await Promise.all(groupsToLoad.map(async (group) => {
      const [characterResult, multiplierResult, partyResult] = await Promise.all([
        workerRequest(token, `/api/groups/${encodeURIComponent(group.id)}/characters`),
        workerRequest(token, `/api/groups/${encodeURIComponent(group.id)}/multipliers`),
        workerRequest(token, `/api/groups/${encodeURIComponent(group.id)}/parties`),
      ]);
      return {
        groupId: group.id,
        groupName: group.name,
        characters: characterResult.characters || [],
        multipliers: (multiplierResult.multipliers || []).map((entry) => ({ ...entry, groupId: group.id })),
        parties: partyResult.parties || [],
      };
    }));
    setAllGroupCharacters(results.flatMap(({ groupId, characters: groupRoster }) => (
      groupRoster.map((character) => ({ ...character, groupId }))
    )));
    setAllGroupMultipliers(results.flatMap(({ multipliers: groupRows }) => groupRows));
    setAllGroupParties(results.flatMap(({ groupId, groupName, parties }) => (
      parties.map((party) => ({ ...party, groupId, groupName }))
    )));
  }

  async function createGroupInvite() {
    if (!selectedGroupId) return;
    setBusy('invite');
    try {
      const result = await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/invites`, { method: 'POST' });
      const inviteUrl = new URL(window.location.pathname, window.location.origin);
      inviteUrl.searchParams.set('invite', result.token);
      setInviteLink(inviteUrl.toString());
      setNotice({ type: 'success', text: `초대 링크를 만들었습니다. ${new Date(result.expiresAt).toLocaleString('ko-KR')}까지 유효합니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }
  async function createEmptyBossParty(boss) {
    if (!selectedGroupId) return;
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/parties`, {
        method: 'POST',
        body: JSON.stringify({ bossId: boss.bossId }),
      });
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
      setNotice({ type: 'success', text: `${boss.difficultyLabel} ${boss.name} 새 파티를 만들었습니다.` });
    } catch (error) {
      reportError(error);
    }
  }

  async function assignBossToCharacter(character, boss, partyId = null) {
    setBusy(`party:${character.ocid}:${boss.bossId}`);
    try {
      const result = await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/party-characters/${encodeURIComponent(character.ocid)}`, {
        method: 'POST',
        body: JSON.stringify({ bossId: boss.bossId, ...(partyId ? { partyId } : {}) }),
      });
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
      setNotice({
        type: 'success',
        text: result.replacedBossId && result.replacedBossId !== boss.bossId
          ? `${boss.difficultyLabel} ${boss.name}으로 난이도를 변경했습니다.`
          : result.moved
            ? `${boss.difficultyLabel} ${boss.name} 파티로 옮겼습니다.`
            : `${boss.difficultyLabel} ${boss.name} 파티에 배정했습니다.`,
      });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function unassignBossFromCharacter(character, bossId, partyId = null) {
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/party-characters/${encodeURIComponent(character.ocid)}`, {
        method: 'DELETE',
        body: JSON.stringify({ bossId, ...(partyId ? { partyId } : {}) }),
      });
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
    } catch (error) {
      reportError(error);
    }
  }

  function getCharacterBossMultiplier(character, bossId) {
    return Math.max(0, ...multipliers
      .filter((entry) => entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
        && entry.bossId?.toLowerCase() === bossId.toLowerCase())
      .map((entry) => Number(entry.multiplier) || 0));
  }

  function startPartyMemberDrag(event, character) {
    if (character.ownerSub !== account?.sub && selectedGroup?.role !== 'admin') {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', character.ocid);
    setDraggedPartyCharacter(character);
  }

  function dragOverParty(event, party) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverPartyId(party.partyId);
  }

  async function dropCharacterOnParty(event, party) {
    event.preventDefault();
    setDragOverPartyId('');
    const ocid = event.dataTransfer.getData('text/plain');
    const character = groupCharacters.find((entry) => entry.ocid === ocid);
    if (!character) return;
    await assignBossToCharacter(character, bossDetails(party.bossId), party.partyId);
    setDraggedPartyCharacter(null);
  }

  function finishPartyMemberDrag() {
    setDraggedPartyCharacter(null);
    setDragOverPartyId('');
  }

  function updateSchedulePreferences(ocid, updates) {
    const next = {
      ...schedulePreferences,
      [ocid]: { ...schedulePreferences[ocid], ...updates },
    };
    setSchedulePreferences(next);
    if (account?.email) {
      try {
        window.localStorage.setItem(`${schedulePreferencesKeyPrefix}${account.email.toLowerCase()}`, JSON.stringify(next));
      } catch {
        setNotice({ type: 'error', text: '미완료 일정 선택을 저장하지 못했습니다.' });
      }
    }
  }

  function updateScheduleTaskSelection(ocid, category, taskKey, enabled, displayedKeys) {
    const saved = schedulePreferences[ocid]?.[category];
    const selected = Array.isArray(saved) ? saved : displayedKeys;
    const next = enabled
      ? [...new Set([...selected, taskKey])]
      : selected.filter((key) => key !== taskKey);
    updateSchedulePreferences(ocid, { [category]: next });
  }

  function updateScheduleBossSelection(ocid, boss, enabled, displayedKeys) {
    const saved = schedulePreferences[ocid]?.bosses;
    const selected = Array.isArray(saved) ? saved : displayedKeys;
    const familySelection = selected.find((key) => key.slice(0, key.lastIndexOf('::')) === boss.familyKey);
    if (enabled && familySelection && familySelection !== boss.key) {
      setNotice({ type: 'error', text: '같은 보스는 한 난이도만 선택할 수 있습니다.' });
      return;
    }
    if (enabled && boss.cycle === 'weekly' && !familySelection
      && weeklyBossSelectionCount(selected) >= bossRecommendationSettings.maxBossesPerCharacter) {
      setNotice({ type: 'error', text: `캐릭터당 최대 ${bossRecommendationSettings.maxBossesPerCharacter}개 보스까지 선택할 수 있습니다.` });
      return;
    }
    const next = enabled ? [...selected, boss.key] : selected.filter((key) => key !== boss.key);
    updateSchedulePreferences(ocid, { bosses: next });
  }

  async function copyGroupInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setNotice({ type: 'success', text: '그룹 초대 링크를 복사했습니다.' });
    } catch {
      setNotice({ type: 'error', text: '링크 복사에 실패했습니다. 링크를 선택해 직접 복사해 주세요.' });
    }
  }

  async function addCharacterToGroup(ocid) {
    if (!selectedGroupId) return;
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/characters`, {
        method: 'POST',
        body: JSON.stringify({ ocid }),
      });
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
      setNotice({ type: 'success', text: '캐릭터를 그룹 로스터에 추가했습니다.' });
    } catch (error) {
      reportError(error);
    }
  }

  async function removeCharacterFromGroup(ocid) {
    if (!selectedGroupId) return;
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/characters`, {
        method: 'DELETE',
        body: JSON.stringify({ ocid }),
      });
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
    } catch (error) {
      reportError(error);
    }
  }

  async function signIn(silent = false) {
    setBusy('signin');
    setNotice(null);
    try {
      if (!workerApiUrl) throw new Error('VITE_WORKER_API_URL 설정을 확인해 주세요.');
      if (silent && !window.google?.accounts?.oauth2) {
        await new Promise((resolve, reject) => {
          let attempts = 0;
          const timer = window.setInterval(() => {
            attempts += 1;
            if (window.google?.accounts?.oauth2) {
              window.clearInterval(timer);
              resolve();
            } else if (attempts >= 25) {
              window.clearInterval(timer);
              reject(new Error('Google 로그인을 복원할 수 없습니다.'));
            }
          }, 200);
        });
      }
      const token = await getGoogleAccessToken(silent ? '' : 'select_account');
      const profile = await getGoogleProfile(token);
      const [groupResult, characterResult, selectionResult] = await Promise.all([
        workerRequest(token, '/api/groups'),
        workerRequest(token, '/api/characters'),
        workerRequest(token, '/api/characters/selection').catch(() => null),
      ]);
      const savedCharacters = characterResult.characters || [];
      let savedGroups = groupResult.groups || [];
      const savedActiveCharacterIds = selectionResult
        ? validActiveCharacterIds(selectionResult.ocids, savedCharacters)
        : readActiveCharacterIds(profile.email, savedCharacters);
      if (selectionResult) {
        try {
          window.localStorage.setItem(activeCharactersStorageKey(profile.email), JSON.stringify(savedActiveCharacterIds));
        } catch {
          // The Worker remains the source of truth when browser storage is unavailable.
        }
      }
      setAccessToken(token);
      setAccount({ email: profile.email, name: profile.name, sub: profile.sub });
      setCharacters(savedCharacters);
      setActiveCharacterIds(savedActiveCharacterIds);
      setSelectedCharacterId(savedActiveCharacterIds[0] || '');
      setSchedulePreferences(readSchedulePreferences(profile.email));
      const inviteToken = new URLSearchParams(window.location.search).get('invite');
      let inviteGroupId = '';
      if (inviteToken) {
        const joined = await workerRequest(token, '/api/group-invites/accept', {
          method: 'POST',
          body: JSON.stringify({ token: inviteToken }),
        });
        inviteGroupId = joined.groupId;
        const refreshedGroups = await workerRequest(token, '/api/groups');
        savedGroups = refreshedGroups.groups || [];
        setGroups(savedGroups);
        setNotice({ type: 'success', text: `${joined.groupName} 그룹에 참가했습니다.` });
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('invite');
        window.history.replaceState({}, '', cleanUrl.toString());
      }
      setGroups(savedGroups);
      const initialGroupId = inviteGroupId || savedGroups[0]?.id || '';
      setSelectedGroupId(initialGroupId);
      if (inviteGroupId) setView('group');
      await Promise.all([
        loadGroupData(token, initialGroupId),
        loadAllGroupPartyData(token, savedGroups),
      ]);
      if (!silent && !inviteGroupId) setNotice({ type: 'success', text: `${profile.email} 계정으로 연결했습니다.` });
    } catch (error) {
      if (!silent) reportError(error);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    if (restoreLoginOnMount.current && !loginRestoreAttempted.current) {
      loginRestoreAttempted.current = true;
      signIn(true);
    }
  }, []);

  function changeRememberLogin(event) {
    const checked = event.target.checked;
    setRememberLogin(checked);
    try {
      window.localStorage.setItem(rememberLoginKey, String(checked));
    } catch {
      if (checked) {
        setNotice({ type: 'error', text: '브라우저가 로그인 유지 설정을 저장하지 못했습니다.' });
      }
    }
  }

  function logOut() {
    setRememberLogin(false);
    try {
      window.localStorage.removeItem(rememberLoginKey);
    } catch {
      // Reloading still ends the current in-memory session.
    }
    window.location.reload();
  }

  function changeRememberApiKey(event) {
    const checked = event.target.checked;
    try {
      if (checked && nexonKey) saveNexonApiKeyCookie(nexonKey);
      else if (!checked) clearNexonApiKeyCookie();
      setRememberApiKey(checked);
    } catch (error) {
      setRememberApiKey(false);
      reportError(error);
    }
  }

  function changeNexonKey(event) {
    const value = event.target.value;
    setNexonKey(value);
    if (rememberApiKey && value) {
      try {
        saveNexonApiKeyCookie(value);
      } catch (error) {
        setRememberApiKey(false);
        clearNexonApiKeyCookie();
        reportError(error);
      }
    }
  }

  function saveActiveCharacterIds(nextIds) {
    const uniqueIds = [...new Set(nextIds)];
    setActiveCharacterIds(uniqueIds);
    setSelectedCharacterId((current) => (
      uniqueIds.includes(current) ? current : uniqueIds[0] || ''
    ));
    if (!account?.email) return;
    try {
      window.localStorage.setItem(activeCharactersStorageKey(account.email), JSON.stringify(uniqueIds));
    } catch {
      setNotice({ type: 'error', text: '선택한 캐릭터를 이 브라우저에 저장하지 못했습니다.' });
    }
    if (accessToken) {
      characterSelectionSaveQueue.current = characterSelectionSaveQueue.current
        .catch(() => {})
        .then(() => workerRequest(accessToken, '/api/characters/selection', {
          method: 'PUT',
          body: JSON.stringify({ ocids: uniqueIds }),
        }))
        .catch((error) => reportError(error));
    }
  }

  function toggleActiveCharacter(ocid) {
    const nextIds = activeCharacterIds.includes(ocid)
      ? activeCharacterIds.filter((activeOcid) => activeOcid !== ocid)
      : [...activeCharacterIds, ocid];
    saveActiveCharacterIds(nextIds);
  }

  function selectAllCharacters() {
    saveActiveCharacterIds(characters.map(({ ocid }) => ocid));
  }

  async function syncCharacters(event) {
    event.preventDefault();
    if (!nexonKey.trim()) return;
    setBusy('sync');
    setNotice(null);
    try {
      const result = await workerRequest(accessToken, '/api/characters/verify', {
        method: 'POST',
        body: JSON.stringify({ apiKey: nexonKey.trim() }),
      });
      const syncedCharacters = result.characters || [];
      if (!syncedCharacters.length) throw new Error('Nexon API에서 캐릭터 목록을 찾을 수 없습니다.');
      setCharacters(syncedCharacters);
      const retainedActiveIds = activeCharacterIds.filter((ocid) => (
        syncedCharacters.some((character) => character.ocid === ocid)
      ));
      saveActiveCharacterIds(retainedActiveIds);
      if (!rememberApiKey) setNexonKey('');
      const skippedCharacters = result.skippedCharacters || [];
      const schedulerUnavailable = result.schedulerUnavailable || [];
      setNotice({
        type: 'success',
        text: [
          `${syncedCharacters.length}개 캐릭터 정보를 동기화했습니다.`,
          skippedCharacters.length ? `${skippedCharacters.length}개 캐릭터는 정보를 가져오지 못해 건너뛰었습니다.` : '',
          schedulerUnavailable.length ? `${schedulerUnavailable.length}개 캐릭터의 스케줄러 정보는 가져오지 못했습니다.` : '',
        ].filter(Boolean).join(' '),
      });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function selectGroup(groupId) {
    setSelectedGroupId(groupId);
    setInviteLink('');
    setView('group');
    setShowGroupForm(false);
    setBusy('group-load');
    try {
      await loadGroupData(accessToken, groupId);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function createGroup(event) {
    event.preventDefault();
    if (!newGroupName.trim()) return;
    setBusy('group-create');
    try {
      const result = await workerRequest(accessToken, '/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      setGroups((previous) => [{ ...result, role: 'admin' }, ...previous]);
      setNewGroupName('');
      setShowGroupForm(false);
      setSelectedGroupId(result.id);
      setView('group');
      await loadGroupData(accessToken, result.id);
      setNotice({ type: 'success', text: `${result.name} 그룹을 만들었습니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  function waitForMapleScouterResult(popup, character, groupId) {
    return new Promise((resolve, reject) => {
      const request = { nickname: character.nickname, ocid: character.ocid, groupId, resolve };
      mapleScouterRequest.current = request;
      mapleScouterTimeout.current = window.setTimeout(() => {
        if (mapleScouterRequest.current !== request) return;
        mapleScouterRequest.current = null;
        mapleScouterTimeout.current = null;
        reject(new Error('MapleScouter 결과 응답 시간이 초과됐습니다.'));
      }, 65_000);

      const resultUrl = new URL('/ko/result', mapleScouterOrigin);
      resultUrl.searchParams.set('name', character.nickname);
      popup.location.href = resultUrl.toString();
    });
  }

  async function refreshMapleScouterData() {
    const refreshCharacters = activeCharacters.slice();
    if (!refreshCharacters.length) {
      setNotice({ type: 'error', text: '계정 설정에서 먼저 실사용 캐릭터를 선택해 주세요.' });
      return;
    }
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setNotice({ type: 'error', text: 'MapleScouter 팝업이 차단됐습니다. 팝업을 허용해 주세요.' });
      return;
    }

    setBusy('maplescouter-check');
    setNotice(null);
    setShowExtensionInstallHelp(false);
    const extensionInstalled = await checkMapleScouterExtension();
    if (!extensionInstalled) {
      popup.close();
      setBusy('');
      setShowExtensionInstallHelp(true);
      setNotice({ type: 'error', text: 'MemoFam Reader 확장이 없거나 현재 앱 도메인에서 활성화되지 않았습니다.' });
      return;
    }
    if (popup.closed) {
      setBusy('');
      return;
    }

    const groupId = view === 'group' ? selectedGroupId : null;
    mapleScouterPopup.current = popup;
    setBusy('maplescouter-refresh');
    const failures = [];
    let successfulCharacters = 0;
    let updatedMultipliers = 0;
    let ignoredMultipliers = 0;
    try {
      for (const [index, character] of refreshCharacters.entries()) {
        setMapleScouterProgress({ current: index + 1, total: refreshCharacters.length, nickname: character.nickname });
        try {
          const payload = await waitForMapleScouterResult(popup, character, groupId);
          if (payload.error) throw new Error(payload.error);
          if (typeof payload.nickname !== 'string'
            || payload.nickname.toLocaleLowerCase('ko') !== character.nickname.toLocaleLowerCase('ko')
            || !Number.isSafeInteger(payload.boss380HexaScore)
            || !Array.isArray(payload.multipliers)) {
            throw new Error('확장에서 받은 결과를 확인할 수 없습니다.');
          }
          if (groupId && !payload.multipliers.length) {
            throw new Error('보스 배율을 찾지 못했습니다.');
          }

          const result = await workerRequest(accessToken, '/api/characters/maplescouter-import', {
            method: 'POST',
            body: JSON.stringify({
              nickname: character.nickname,
              boss380HexaScore: payload.boss380HexaScore,
              multipliers: groupId ? payload.multipliers : [],
              groupId,
            }),
          });
          setCharacters((current) => current.map((savedCharacter) => (
            savedCharacter.ocid === character.ocid
              ? { ...savedCharacter, boss380HexaScore: result.boss380HexaScore }
              : savedCharacter
          )));
          successfulCharacters += 1;
          updatedMultipliers += result.updatedMultipliers || 0;
          ignoredMultipliers += result.ignoredMultipliers || 0;
        } catch (error) {
          failures.push(`${character.nickname}: ${error.message || '갱신 실패'}`);
        }
      }

      if (groupId) {
        try {
          await loadGroupData(accessToken, groupId);
          await loadAllGroupPartyData(accessToken);
        } catch (error) {
          failures.push(`그룹 배율 새로고침: ${error.message || '실패'}`);
        }
      }
    } finally {
      if (mapleScouterTimeout.current) window.clearTimeout(mapleScouterTimeout.current);
      mapleScouterTimeout.current = null;
      mapleScouterRequest.current = null;
      mapleScouterPopup.current = null;
      if (!popup.closed) popup.close();
      setMapleScouterProgress(null);
      setBusy('');
    }

    const summary = `실사용 캐릭터 ${successfulCharacters}/${refreshCharacters.length}명 동기화 완료${groupId ? `, ${updatedMultipliers}개 배율 저장` : ''}.${ignoredMultipliers ? ` 그룹에 없는 ${ignoredMultipliers}개 보스는 제외했습니다.` : ''}`;
    setNotice({
      type: failures.length ? 'error' : 'success',
      text: `${summary}${failures.length ? ` 실패: ${failures.join(' · ')}` : ''}`,
    });
  }

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const activeCharacters = characters.filter(({ ocid }) => activeCharacterIds.includes(ocid));
  const activeOcids = new Set(activeCharacters.map(({ ocid }) => ocid));
  const personalParties = allGroupParties.filter((party) => (
    (party.members || []).some((member) => member.ownerSub === account?.sub && activeOcids.has(member.ocid))
  ));
  const normalizedSearch = characterSearch.trim().toLocaleLowerCase('ko');
  const filteredActiveCharacters = activeCharacters.filter((character) => {
    const matchesSearch = !normalizedSearch || [character.nickname, character.characterClass, character.worldName]
      .some((value) => value?.toLocaleLowerCase('ko').includes(normalizedSearch));
    const matchesWorld = !characterWorldFilter || (character.worldName || '월드 정보 없음') === characterWorldFilter;
    return matchesSearch && matchesWorld;
  });
  const activeCharacterWorldGroups = groupCharactersByWorld(filteredActiveCharacters);
  const activeCharacterWorlds = [...new Set(activeCharacters.map(({ worldName }) => worldName || '월드 정보 없음'))]
    .sort((left, right) => left.localeCompare(right, 'ko'));
  const characterWorldGroups = groupCharactersByWorld(characters);
  const selectedCharacter = activeCharacters.find(({ ocid }) => ocid === selectedCharacterId);
  const unassignedRecommendations = new Map();
  for (const character of activeCharacters) {
    const characterMultipliers = allGroupMultipliers.filter((entry) => (
      entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
    ));
    const assignedBossIds = new Set(allGroupCharacters
      .filter((entry) => entry.ocid === character.ocid)
      .flatMap((entry) => (entry.bosses || []).map(({ bossId }) => bossId)));
    const missing = recommendationsForCharacter(character, characterMultipliers)
      .filter(({ bossId }) => !assignedBossIds.has(bossId));
    if (missing.length) unassignedRecommendations.set(character.ocid, missing);
  }
  const groupedPartyRows = new Map();
  for (const character of groupCharacters) {
    for (const assignment of character.bosses || []) {
      const participants = groupedPartyRows.get(assignment.bossId) || [];
      participants.push(character);
      groupedPartyRows.set(assignment.bossId, participants);
    }
  }
  const viewTitle = view === 'characters'
    ? '내 캐릭터'
    : view === 'settings'
      ? '계정 설정'
    : view === 'bosses'
      ? '보스 설정'
      : selectedGroup?.name || '그룹';
  const mapleScouterButtonLabel = busy === 'maplescouter-check'
    ? '확장 확인 중...'
    : busy === 'maplescouter-refresh'
      ? `갱신 중 ${mapleScouterProgress?.current || 0}/${mapleScouterProgress?.total || activeCharacters.length} · ${mapleScouterProgress?.nickname || ''}`
      : `실사용 ${activeCharacters.length}명 전체 갱신`;
  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="server-rail" aria-label="내 정보와 그룹">
        <button
          className={`rail-button my-info-button ${view === 'characters' ? 'active' : ''}`}
          type="button"
          title="내 정보"
          onClick={() => setView('characters')}
        >
          <span className="rail-avatar">{selectedCharacter?.image
            ? <img src={selectedCharacter.image} alt="" />
            : '내'}
          </span>
          <span className="rail-tooltip">내 정보</span>
        </button>
        <div className="rail-divider" aria-hidden="true" />
        <div className="rail-group-list" aria-label="참여 그룹">
          {groups.map((group) => (
            <button
              className={`rail-button ${view === 'group' && selectedGroupId === group.id ? 'active' : ''}`}
              type="button"
              title={group.name}
              key={group.id}
              onClick={() => selectGroup(group.id)}
            >
              <span className="rail-avatar group-avatar">{group.name.slice(0, 1)}</span>
              <span className="rail-tooltip">{group.name}</span>
            </button>
          ))}
        </div>
        {account && (
          <button
            className="rail-button add-group-button"
            type="button"
            title="그룹 만들기"
            onClick={() => {
              setSelectedGroupId('');
              setMultipliers([]);
              setShowGroupForm(true);
              setView('group');
            }}
          >
            <span className="rail-avatar">+</span>
            <span className="rail-tooltip">그룹 만들기</span>
          </button>
        )}
        <div className="rail-spacer" />
        {account ? (
          <button
            className={`rail-button account-settings-button ${view === 'settings' ? 'active' : ''}`}
            type="button"
            title="계정 설정"
            aria-label="계정 설정"
            onClick={() => setView('settings')}
          >
            <span className="rail-avatar">⚙</span>
            <span className="rail-tooltip">계정 설정</span>
          </button>
        ) : (
          <span className="rail-brand" aria-label="Maple Scout">M</span>
        )}
      </aside>

      <div className="app-main">
        <header className="topbar">
          <a className="brand" href="#home" onClick={() => setView('characters')}>
            <span className="brand-mark">M</span>
            <span>MAPLE<span className="brand-light"> / SCOUT</span></span>
          </a>
          <div className="account-area">
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            {account ? (
              <span className="account-email">{account.email}</span>
            ) : (
              <button className="google-button" type="button" onClick={() => signIn()} disabled={busy === 'signin'}>
                <span className="google-g">G</span>{busy === 'signin' ? '연결 중...' : 'Google 로그인'}
              </button>
            )}
          </div>
        </header>

        <main className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">MAPLE / SCOUT WORKSPACE</p>
              <h1>{viewTitle}</h1>
            </div>
            {account && view === 'group' && selectedGroup && (
              <button className="primary-button" type="button" onClick={refreshMapleScouterData} disabled={!activeCharacters.length || busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}>
                {mapleScouterButtonLabel}
              </button>
            )}
          </div>

          {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
          {showExtensionInstallHelp && (
            <section className="extension-install-help" role="alert" aria-labelledby="extension-install-title">
              <div className="extension-install-heading">
                <h2 id="extension-install-title">MemoFam Reader 설치</h2>
                <button className="quiet-button" type="button" aria-label="설치 안내 닫기" onClick={() => setShowExtensionInstallHelp(false)}>×</button>
              </div>
              <p>Chrome Web Store 등록 없이 ZIP 파일로 설치할 수 있습니다.</p>
              <a className="outline-button extension-download" href="/memofam-maplescouter-reader.zip" download>
                MemoFam Reader 다운로드
              </a>
              <ol>
                <li>ZIP을 다운로드해 압축을 풉니다.</li>
                <li>Chrome에서 <code>chrome://extensions</code>, Edge에서 <code>edge://extensions</code>를 엽니다.</li>
                <li>개발자 모드를 켜고 <strong>압축해제된 확장 프로그램을 로드</strong>를 눌러 압축을 푼 폴더를 선택합니다.</li>
                <li>이 앱 페이지를 새로고침합니다. 사용자 지정 도메인이라면 확장 manifest에 도메인을 추가해야 합니다.</li>
              </ol>
            </section>
          )}

          {!account ? (
            <section className="login-panel">
              <span className="login-symbol">M</span>
              <p className="eyebrow">MAPLE / SCOUT</p>
              <h2>보스 파티와 캐릭터 일정을<br />한 곳에서 관리하세요.</h2>
              <p>Google 계정으로 로그인한 뒤 Nexon API 키를 연결해 캐릭터와 스케줄 정보를 불러오세요.</p>
              <button className="google-button login-google" type="button" onClick={() => signIn()} disabled={busy === 'signin'}>
                <span className="google-g">G</span>{busy === 'signin' ? '연결 중...' : 'Google 계정으로 계속'}
              </button>
              <label className="remember-login">
                <input type="checkbox" checked={rememberLogin} onChange={changeRememberLogin} />
                <span>로그인 유지</span>
              </label>
              {(!clientId || !workerApiUrl) && (
                <small className="setup-hint">VITE_GOOGLE_CLIENT_ID와 VITE_WORKER_API_URL 설정이 필요합니다.</small>
              )}
            </section>
          ) : (
            <>
              {view === 'settings' && (
                <>
                  <section className="sync-card">
                    <div className="sync-copy">
                      <span className="sync-mark">N</span>
                      <div>
                        <p className="eyebrow">NEXON OPEN API</p>
                        <h2>Nexon 계정 연결</h2>
                        <p>API 키를 입력해 260레벨 이상 캐릭터와 스케줄 정보를 불러옵니다.</p>
                      </div>
                    </div>
                    <form className="sync-form" onSubmit={syncCharacters}>
                      <label className="sr-only" htmlFor="nexon-api-key">Nexon Open API 키</label>
                      <div className="api-key-field">
                        <input
                          id="nexon-api-key"
                          type="password"
                          value={nexonKey}
                          onChange={changeNexonKey}
                          placeholder="Nexon Open API 키 붙여넣기"
                          autoComplete="off"
                          required
                        />
                        <label className="remember-api-key">
                          <input type="checkbox" checked={rememberApiKey} onChange={changeRememberApiKey} />
                          <span>API 키 유지</span>
                        </label>
                      </div>
                      <button className="primary-button" type="submit" disabled={busy === 'sync'}>
                        {busy === 'sync' ? '캐릭터 불러오는 중...' : '캐릭터 불러오기'}
                      </button>
                    </form>
                    <div className="sync-footer">
                      <span>API 키는 브라우저 쿠키에 30일간 저장할 수 있습니다. 공용 기기에서는 유지 옵션을 사용하지 마세요.</span>
                      <a href="https://openapi.nexon.com/ko/game/maplestory/?id=14" target="_blank" rel="noreferrer">API 키 및 캐릭터 API 안내</a>
                      <a href="https://openapi.nexon.com/ko/game/maplestory/?id=57" target="_blank" rel="noreferrer">스케줄러 API 안내</a>
                    </div>
                  </section>

                  <section className="character-settings-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">ACTIVE CHARACTERS</p>
                        <h2>사용 캐릭터 <span className="character-count">{activeCharacters.length}</span><span className="character-total">/ {characters.length}</span></h2>
                      </div>
                      <div className="character-tools">
                        <span className="updated-count">선택한 캐릭터만 메인에 표시하고 갱신합니다</span>
                        <button className="quiet-button" type="button" onClick={selectAllCharacters} disabled={!characters.length}>전체 선택</button>
                        <button className="quiet-button" type="button" onClick={() => saveActiveCharacterIds([])} disabled={!activeCharacters.length}>전체 해제</button>
                      </div>
                    </div>
                    {characterWorldGroups.length ? (
                      characterWorldGroups.map(({ worldName, characters: worldCharacters }) => (
                        <section className="world-character-group" key={worldName} aria-label={`${worldName} 캐릭터 선택`}>
                          <h3 className="world-character-heading">{worldName}</h3>
                          <div className="active-character-list">
                            {worldCharacters.map((character) => (
                              <label className="active-character-option" key={character.ocid}>
                                <input
                                  type="checkbox"
                                  aria-label={`실사용 캐릭터 ${character.nickname} Lv. ${character.level}`}
                                  checked={activeCharacterIds.includes(character.ocid)}
                                  onChange={() => toggleActiveCharacter(character.ocid)}
                                />
                                <span className="active-character-avatar">
                                  {character.image
                                    ? <img src={character.image} alt="" loading="lazy" />
                                    : <span>{character.nickname.slice(0, 1)}</span>}
                                </span>
                                <span className="active-character-details">
                                  <strong>{character.nickname}</strong>
                                  <small>{character.characterClass || '직업 정보 없음'} · Lv. {character.level || '-'}</small>
                                </span>
                                <span className="active-character-score">
                                  {character.boss380HexaScore === null || character.boss380HexaScore === undefined
                                    ? '헥사 조회 전'
                                    : `헥사 ${Number(character.boss380HexaScore).toLocaleString('ko-KR')}`}
                                </span>
                              </label>
                            ))}
                          </div>
                        </section>
                      ))
                    ) : (
                      <div className="empty-state">
                        <span className="empty-icon">N</span>
                        <strong>불러온 캐릭터가 없습니다</strong>
                        <p>Nexon API 키를 입력하고 캐릭터 불러오기를 눌러주세요.</p>
                      </div>
                    )}
                  </section>
                  <section className="account-danger-zone" aria-labelledby="account-logout-title">
                    <div>
                      <p className="eyebrow">ACCOUNT</p>
                      <h2 id="account-logout-title">로그아웃</h2>
                      <p>이 브라우저에서 MemoFam 계정 연결을 종료합니다.</p>
                    </div>
                    <button className="logout-danger-button" type="button" onClick={logOut}>로그아웃</button>
                  </section>
                </>
              )}

              {view === 'characters' && (
                <>
                  <section className="character-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">MY ACTIVE CHARACTERS</p>
                        <h2>실사용 캐릭터 <span className="character-count">{activeCharacters.length}</span></h2>
                      </div>
                      <div className="character-tools">
                        <span className="updated-count">보스380 헥사환산 기준으로 정렬</span>
                        <button
                          className="outline-button character-score-refresh"
                          type="button"
                          onClick={refreshMapleScouterData}
                          disabled={!activeCharacters.length || busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}
                        >
                          {mapleScouterButtonLabel}
                        </button>
                      </div>
                    </div>
                    {activeCharacters.length > 0 && (
                      <div className="character-filter-bar">
                        <label>
                          <span>캐릭터 검색</span>
                          <input
                            aria-label="캐릭터 검색"
                            type="search"
                            value={characterSearch}
                            onChange={(event) => setCharacterSearch(event.target.value)}
                            placeholder="닉네임 또는 직업"
                          />
                        </label>
                        <label>
                          <span>월드</span>
                          <select aria-label="월드 필터" value={characterWorldFilter} onChange={(event) => setCharacterWorldFilter(event.target.value)}>
                            <option value="">전체 월드</option>
                            {activeCharacterWorlds.map((worldName) => <option key={worldName} value={worldName}>{worldName}</option>)}
                          </select>
                        </label>
                        {(characterSearch || characterWorldFilter) && (
                          <button className="quiet-button" type="button" onClick={() => { setCharacterSearch(''); setCharacterWorldFilter(''); }}>
                            필터 초기화
                          </button>
                        )}
                      </div>
                    )}
                    {activeCharacters.length ? (
                      filteredActiveCharacters.length ? activeCharacterWorldGroups.map(({ worldName, characters: worldCharacters }) => (
                        <section className="world-character-group" key={worldName} aria-label={`${worldName} 캐릭터`}>
                          <h3 className="world-character-heading">{worldName}</h3>
                          <div className="character-grid">
                            {worldCharacters.map((character) => {
                              return (
                                <button
                                  className={`character-card ${selectedCharacterId === character.ocid ? 'selected' : ''}`}
                                  type="button"
                                  key={character.ocid}
                                  onClick={() => setSelectedCharacterId(character.ocid)}
                                >
                                  <span className="character-art">
                                    {character.image
                                      ? <img src={character.image} alt={`${character.nickname} 캐릭터`} loading="lazy" />
                                      : <span className="character-fallback">{character.nickname.slice(0, 1)}</span>}
                                  </span>
                                  <span className="character-info">
                                    <strong>{character.nickname}</strong>
                                    <span className="character-class">{character.characterClass || '직업 정보 없음'}</span>
                                    <span className="character-level">Lv. {character.level || '-'}</span>
                                    <span className="character-hexa-score">
                                      <span>보스380 헥사</span>
                                      <strong>{character.boss380HexaScore === null || character.boss380HexaScore === undefined
                                        ? '조회 전'
                                        : Number(character.boss380HexaScore).toLocaleString('ko-KR')}</strong>
                                    </span>
                                  </span>
                                  {unassignedRecommendations.has(character.ocid) && (
                                    <span
                                      className="unassigned-party-indicator"
                                      title={`그룹 파티 미편성 추천: ${unassignedRecommendations.get(character.ocid).map(({ difficultyLabel, name }) => `${difficultyLabel} ${name}`).join(', ')}`}
                                      aria-label={`${character.nickname} 추천 보스가 그룹 파티에 편성되지 않음`}
                                    >!</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      )) : (
                        <div className="empty-state compact"><strong>검색 결과가 없습니다</strong><p>검색어나 월드 필터를 바꿔 보세요.</p></div>
                      )
                    ) : (
                      <div className="empty-state">
                        <span className="empty-icon">＋</span>
                        <strong>{characters.length ? '사용 캐릭터가 선택되지 않았습니다' : '아직 불러온 캐릭터가 없습니다'}</strong>
                        <p>{characters.length ? '계정 설정에서 메인에 표시할 캐릭터를 선택하세요.' : '계정 설정에서 Nexon API 키로 260레벨 이상 캐릭터를 불러오세요.'}</p>
                        <button className="outline-button" type="button" onClick={() => setView('settings')}>계정 설정 열기</button>
                      </div>
                    )}
                  </section>
                  <section className="panel-section schedule-section my-schedule-section">
                    <div className="section-heading">
                      <div><p className="eyebrow">MY SCHEDULE</p><h2>내 캐릭터 미완료 일정</h2></div>
                      <span className="updated-count">그룹과 무관한 내 일정</span>
                    </div>
                    {!activeCharacters.length ? (
                      <div className="empty-state compact"><strong>실사용 캐릭터가 선택되지 않았습니다</strong><p>계정 설정에서 일정 관리할 캐릭터를 선택하세요.</p></div>
                    ) : (
                      <div className="my-schedule-list">
                        {activeCharacters.map((character) => {
                          const scheduler = character.scheduler || {};
                          const preferences = schedulePreferences[character.ocid] || {};
                          const availableDaily = scheduler.daily_contents || [];
                          const availableWeekly = scheduler.weekly_contents || [];
                          const selectedDailyKeys = Array.isArray(preferences.daily)
                            ? preferences.daily
                            : registeredScheduleKeys(availableDaily);
                          const selectedWeeklyKeys = Array.isArray(preferences.weekly)
                            ? preferences.weekly
                            : registeredScheduleKeys(availableWeekly);
                          const availableBosses = [...new Map((scheduler.boss_contents || [])
                            .map((item) => {
                              const option = scheduleBossOption(item);
                              return [option.key, { item, option }];
                            })).values()];
                          const selectedBossKeys = Array.isArray(preferences.bosses)
                            ? limitBossKeysToWeeklyCap(preferences.bosses)
                            : registeredBossKeys(scheduler.boss_contents || []);
                          const weeklyBosses = availableBosses
                            .filter(({ item, option }) => option.cycle === 'weekly' && selectedBossKeys.includes(option.key) && isIncomplete(item, true))
                            .map(({ item }) => item);
                          const monthlyBosses = availableBosses
                            .filter(({ item, option }) => option.cycle === 'monthly' && selectedBossKeys.includes(option.key) && isIncomplete(item, true))
                            .map(({ item }) => item);
                          const daily = availableDaily.filter((item) => (
                            selectedDailyKeys.includes(scheduleItemKey(item)) && isIncomplete(item)
                          ));
                          const weekly = availableWeekly.filter((item) => (
                            selectedWeeklyKeys.includes(scheduleItemKey(item)) && isIncomplete(item)
                          ));
                          const categories = [
                            { id: 'daily', icon: '◷', label: '일일', items: daily, visible: selectedDailyKeys.length > 0 },
                            { id: 'weekly', icon: '▦', label: '주간', items: weekly, visible: selectedWeeklyKeys.length > 0 },
                            { id: 'bosses', icon: '⚔', label: '주간 보스', items: weeklyBosses, visible: weeklyBossSelectionCount(selectedBossKeys) > 0 },
                            { id: 'monthly-bosses', icon: '⚔', label: '월간 보스', items: monthlyBosses, visible: selectedBossKeys.length > weeklyBossSelectionCount(selectedBossKeys) },
                          ].filter((category) => category.visible);
                          const incompleteCount = daily.length + weekly.length + weeklyBosses.length + monthlyBosses.length;
                          return (
                            <article className="my-schedule-character" key={character.ocid}>
                              <header className="my-schedule-character-heading">
                                {character.image ? <img src={character.image} alt="" loading="lazy" /> : <span className="character-fallback small">{character.nickname.slice(0, 1)}</span>}
                                <div><strong>{character.nickname}</strong><small>Lv. {character.level || '-'} · 미완료 {incompleteCount}</small></div>
                                <span className={`schedule-total ${incompleteCount ? 'has-pending' : ''}`}>{scheduler.date || '기록 없음'}</span>
                              </header>
                              <div className="schedule-preferences" aria-label={`${character.nickname} 표시할 일정 선택`}>
                                <span className="schedule-preferences-label">표시할 일정</span>
                                {[
                                  { id: 'daily', label: '일일', icon: '◷', items: availableDaily, keys: selectedDailyKeys },
                                  { id: 'weekly', label: '주간', icon: '▦', items: availableWeekly, keys: selectedWeeklyKeys },
                                ].map((category) => (
                                  <details className="schedule-boss-picker schedule-task-picker" key={category.id}>
                                    <summary>{`${category.label} 선택 ${category.keys.length}/${category.items.length}`}</summary>
                                    {category.items.length ? (
                                      <div className="schedule-boss-options">
                                        {category.items.map((item) => {
                                          const taskKey = scheduleItemKey(item);
                                          const selected = category.keys.includes(taskKey);
                                          return (
                                            <label className="schedule-boss-option" key={taskKey}>
                                              <input
                                                type="checkbox"
                                                aria-label={`${character.nickname} ${category.label} 일정 ${item.content_name} 표시`}
                                                checked={selected}
                                                onChange={(event) => updateScheduleTaskSelection(
                                                  character.ocid,
                                                  category.id,
                                                  taskKey,
                                                  event.target.checked,
                                                  category.keys,
                                                )}
                                              />
                                              <span>{item.content_name}</span>
                                              <small>{isIncomplete(item) ? '미완료' : '완료'}</small>
                                            </label>
                                          );
                                        })}
                                      </div>
                                    ) : <p className="schedule-boss-empty">넥슨 API에서 가져온 일정이 없습니다.</p>}
                                  </details>
                                ))}
                                <details className="schedule-boss-picker">
                                  <summary>{`주간 보스 ${weeklyBossSelectionCount(selectedBossKeys)}/${bossRecommendationSettings.maxBossesPerCharacter} · 월간 ${selectedBossKeys.length - weeklyBossSelectionCount(selectedBossKeys)}종`}</summary>
                                  {availableBosses.length ? (
                                    <div className="schedule-boss-options">
                                      {availableBosses.map(({ item, option }) => {
                                        const selected = selectedBossKeys.includes(option.key);
                                        const familySelection = selectedBossKeys.find((key) => key.slice(0, key.lastIndexOf('::')) === option.familyKey);
                                        const familyConflict = Boolean(familySelection && familySelection !== option.key);
                                        const atLimit = option.cycle === 'weekly' && !selected && !familySelection
                                          && weeklyBossSelectionCount(selectedBossKeys) >= bossRecommendationSettings.maxBossesPerCharacter;
                                        const label = `${option.difficultyLabel ? `${option.difficultyLabel} ` : ''}${option.name || item.content_name}`;
                                        return (
                                          <label className="schedule-boss-option" key={option.key}>
                                            <input
                                              type="checkbox"
                                              aria-label={`${character.nickname} 보스 일정 ${label} 표시`}
                                              checked={selected}
                                              disabled={familyConflict || atLimit}
                                              onChange={(event) => updateScheduleBossSelection(character.ocid, option, event.target.checked, selectedBossKeys)}
                                            />
                                            <span>{label}</span>
                                            <small>{isIncomplete(item, true) ? '미완료' : '완료'}</small>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  ) : <p className="schedule-boss-empty">선택할 미완료 보스가 없습니다.</p>}
                                </details>
                              </div>
                              {categories.length ? <div className="schedule-task-groups">
                                {categories.map((category) => (
                                  <section className="schedule-task-group" key={category.id} aria-label={`${character.nickname} ${category.label} 일정`}>
                                    <h3><span aria-hidden="true">{category.icon}</span>{category.label}<span>{category.items.length}</span></h3>
                                    <div className="schedule-tasks">
                                      {category.items.length ? category.items.map((item, index) => (
                                        <span className={`task-chip pending task-${category.id}`} key={`${item.content_name}-${item.difficulty || ''}-${index}`}>
                                          <span className="task-chip-icon" aria-hidden="true">{category.icon}</span>
                                          {category.id.includes('bosses')
                                            ? `${scheduleBossOption(item).difficultyLabel ? `${scheduleBossOption(item).difficultyLabel} ` : ''}${scheduleBossOption(item).name || item.content_name}`
                                            : `${item.content_name}${item.max_count > 1 ? ` (${item.now_count || 0}/${item.max_count})` : ''}`}
                                        </span>
                                      )) : <span className="task-chip completed">완료</span>}
                                    </div>
                                  </section>
                                ))}
                              </div> : <p className="schedule-selection-empty">표시할 일정이나 보스를 선택하세요.</p>}
                            </article>
                          );
                        })}
                      </div>
                    )}
                    <p className="privacy-note">표시할 일정 종류와 보스 선택은 캐릭터별로 저장됩니다. 보스는 캐릭터당 최대 12개, 같은 보스는 한 난이도만 선택할 수 있습니다.</p>
                  </section>
                </>
              )}

              {view === 'group' && (
                <section className="group-view">
                  {showGroupForm && (
                    <form className="create-group-card" onSubmit={createGroup}>
                      <div>
                        <p className="eyebrow">NEW PARTY</p>
                        <h2>새 그룹 만들기</h2>
                      </div>
                      <label className="sr-only" htmlFor="new-group-name">그룹 이름</label>
                      <input
                        id="new-group-name"
                        value={newGroupName}
                        onChange={(event) => setNewGroupName(event.target.value)}
                        placeholder="예: 주간 보스 파티"
                        maxLength={80}
                        required
                      />
                      <button className="primary-button" type="submit" disabled={busy === 'group-create'}>
                        {busy === 'group-create' ? '만드는 중...' : '그룹 생성'}
                      </button>
                    </form>
                  )}
                  {!selectedGroup && !showGroupForm && (
                    <div className="empty-state">
                      <span className="empty-icon">♧</span>
                      <strong>참여 중인 그룹이 없습니다</strong>
                      <p>왼쪽 + 버튼으로 보스 파티 그룹을 만들어 보세요.</p>
                    </div>
                  )}
                  {selectedGroup && (
                    <>
                      <section className="party-header">
                        <div>
                          <p className="eyebrow">GROUP BOSS PARTIES</p>
                          <h2>{selectedGroup.name}</h2>
                          <p>{selectedGroup.role === 'admin' ? '관리자' : '그룹 멤버'} · 참가 캐릭터 {groupCharacters.length}명</p>
                        </div>
                        <button className="outline-button" type="button" onClick={() => setView('bosses')}>그룹 및 파티 관리</button>
                      </section>

                      <section className="panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">ASSIGNED PARTIES</p><h2>보스별 참가 캐릭터</h2></div>
                          <span className="updated-count">{groupedPartyRows.size} 파티</span>
                        </div>
                        {groupedPartyRows.size ? (
                          <div className="group-party-grid">
                            {[...groupedPartyRows.entries()].map(([bossId, participants]) => {
                              const config = bossDetails(bossId);
                              const icon = bossImages[`./bossImage/${bossId}.png`];
                              return (
                                <article className="group-party-item" key={bossId}>
                                  <div className="group-party-heading">
                                    {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder">◇</span>}
                                    <div><p className="eyebrow">{config.difficultyLabel}</p><h3>{config.name}</h3></div>
                                    <span className="party-size-count">{participants.length}/{config.maxPartySize}인</span>
                                  </div>
                                  <div className="group-party-members">
                                    {participants.map((character) => (
                                      <span className="group-party-member" key={`${character.ownerSub}:${character.ocid}`} title={character.ownerEmail}>
                                        {character.image ? <img src={character.image} alt="" /> : <span>{character.nickname.slice(0, 1)}</span>}
                                        {character.nickname}
                                      </span>
                                    ))}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="empty-state compact">
                            <strong>아직 편성된 보스 파티가 없습니다</strong>
                            <p>그룹 및 파티 관리에서 캐릭터를 추가하고 추천 보스를 배정하세요.</p>
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </section>
              )}

              {view === 'bosses' && (
                <section className="group-management-view">
                  {!selectedGroup ? (
                    <div className="empty-state">
                      <strong>관리할 그룹을 먼저 선택하세요</strong>
                      <p>왼쪽 그룹 아이콘에서 파티를 선택하세요.</p>
                    </div>
                  ) : (
                    <>
                      <section className="group-invite-section">
                        <div>
                          <p className="eyebrow">INVITE MEMBERS</p>
                          <h2>{selectedGroup.name} 초대 링크</h2>
                          <p>링크는 생성 시점부터 7일간 유효하며 로그인 후 그룹에 참여합니다.</p>
                        </div>
                        {selectedGroup.role === 'admin' ? (
                          <button className="primary-button" type="button" onClick={createGroupInvite} disabled={busy === 'invite'}>
                            {busy === 'invite' ? '링크 생성 중...' : '초대 링크 만들기'}
                          </button>
                        ) : <span className="updated-count">그룹 관리자만 초대 링크를 만들 수 있습니다</span>}
                        {inviteLink && (
                          <div className="invite-link-field">
                            <input aria-label="그룹 초대 링크" readOnly value={inviteLink} onFocus={(event) => event.target.select()} />
                            <button className="outline-button" type="button" onClick={copyGroupInvite}>링크 복사</button>
                          </div>
                        )}
                      </section>

                      <section className="group-character-picker panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">ADD YOUR CHARACTERS</p><h2>그룹에 참여시킬 캐릭터</h2></div>
                          <span className="updated-count">실사용 캐릭터 {activeCharacters.length}명</span>
                        </div>
                        {activeCharacters.length ? (
                          <div className="group-add-character-grid">
                            {activeCharacters.map((character) => {
                              const alreadyAdded = groupCharacters.some((entry) => entry.ocid === character.ocid);
                              return (
                                <article className="group-add-character" key={character.ocid}>
                                  {character.image ? <img src={character.image} alt="" /> : <span className="boss-placeholder">◇</span>}
                                  <span><strong>{character.nickname}</strong><small>Lv. {character.level}</small></span>
                                  <button className="outline-button" type="button" disabled={alreadyAdded} onClick={() => addCharacterToGroup(character.ocid)}>
                                    {alreadyAdded ? '참여 중' : '그룹에 추가'}
                                  </button>
                                </article>
                              );
                            })}
                          </div>
                        ) : <div className="empty-state compact"><strong>실사용 캐릭터가 없습니다</strong><p>계정 설정에서 먼저 사용할 캐릭터를 선택하세요.</p></div>}
                      </section>

                      <section className="group-roster-section panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">GROUP ROSTER</p><h2>캐릭터별 보스 파티 편성</h2></div>
                          <span className="updated-count">주간 {bossRecommendationSettings.maxBossesPerCharacter}종 · 월간 별도 · 보스별 가족 1난이도</span>
                        </div>
                        {groupCharacters.length ? (
                          <div className="group-roster-list">
                            {groupCharacters.map((character) => {
                              const recommendations = recommendationsForCharacter(character, multipliers);
                              const assignedBosses = character.bosses || [];
                              return (
                                <article className="group-roster-character" key={`${character.ownerSub}:${character.ocid}`}>
                                  <header className="group-roster-character-heading">
                                    {character.image ? <img src={character.image} alt="" /> : <span className="boss-placeholder">◇</span>}
                                    <div>
                                      <h3>{character.nickname}</h3>
                                      <p>
                                        {character.ownerEmail} · Lv. {character.level} · 주간 {assignedBosses.filter(({ bossId }) => bossDetails(bossId).cycle !== 'monthly').length}/{bossRecommendationSettings.maxBossesPerCharacter}
                                        {assignedBosses.some(({ bossId }) => bossDetails(bossId).cycle === 'monthly') ? ' + 월간' : ''} 보스
                                      </p>
                                    </div>
                                    {(character.ownerSub === account?.sub || selectedGroup.role === 'admin') && (
                                      <button className="quiet-button remove-roster-character" type="button" onClick={() => removeCharacterFromGroup(character)} aria-label={`${character.nickname} 그룹에서 제거`}>그룹에서 제거</button>
                                    )}
                                  </header>
                                  <div className="assigned-boss-list">
                                    {assignedBosses.length ? assignedBosses.map((assignment) => {
                                      const config = bossDetails(assignment.bossId);
                                      return (
                                        <button className="assigned-boss-chip" type="button" key={assignment.bossId} onClick={() => unassignBossFromCharacter(character, assignment.bossId)} title="파티에서 제외">
                                          <span>{config.difficultyLabel} {config.name}</span><span aria-hidden="true">×</span>
                                        </button>
                                      );
                                    }) : <span className="updated-count">아직 참가 중인 보스가 없습니다</span>}
                                  </div>
                                  <div className="recommendation-list">
                                    <div className="recommendation-heading"><strong>추천 보스</strong><span>개인 메소 수익 · 상위 난이도 우선 가족 반영</span></div>
                                    {recommendations.length ? recommendations.map((boss) => {
                                      const existing = assignedBosses.find((assignment) => assignment.familyId === boss.familyId);
                                      const full = boss.cycle === 'weekly'
                                        && assignedBosses.filter(({ bossId }) => bossDetails(bossId).cycle !== 'monthly').length >= bossRecommendationSettings.maxBossesPerCharacter
                                        && !existing;
                                      const alreadyAssigned = existing?.bossId === boss.bossId;
                                      const busyKey = `party:${character.ocid}:${boss.bossId}`;
                                      const icon = bossImages[`./bossImage/${boss.bossId}.png`];
                                      return (
                                        <article className="recommendation-row" key={boss.bossId}>
                                          {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder small-placeholder">◇</span>}
                                          <div className="recommendation-boss-title">
                                            <strong>{boss.difficultyLabel} {boss.name}</strong>
                                            <small>
                                              총 {boss.changedPrice.toLocaleString('ko-KR')} 메소 · 개인 {Math.floor(boss.personalPrice).toLocaleString('ko-KR')} 메소
                                              <span className="party-recommendation-badge">{boss.recommendedPartySize}인 추천</span>
                                              {boss.cycle === 'monthly' && <span className="boss-cycle-badge">월간</span>}
                                            </small>
                                          </div>
                                          <button className="outline-button" type="button" disabled={alreadyAssigned || full || busy === busyKey} onClick={() => assignBossToCharacter(character, boss)}>
                                            {busy === busyKey ? '저장 중...' : alreadyAssigned ? '참가 중' : full ? '12개 한도' : existing ? '난이도 변경' : '파티 배정'}
                                          </button>
                                        </article>
                                      );
                                    }) : <p className="recommendation-empty">조건을 만족하는 추천이 없습니다. 캐릭터 배율을 갱신하거나 <code>src/boss-recommendations.json</code>의 임계치를 조정하세요.</p>}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : <div className="empty-state compact"><strong>그룹에 등록된 캐릭터가 없습니다</strong><p>위에서 실사용 캐릭터를 추가하세요.</p></div>}
                      </section>
                    </>
                  )}
                </section>
              )}
            </>
          )}
          <footer className="page-footer"><span>MAPLE / SCOUT</span><span>Nexon Scheduler · Cloudflare D1</span></footer>
        </main>
      </div>
    </div>
  );
}

export default App;
