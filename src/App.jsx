import { useEffect, useRef, useState } from 'react';
import './App.css';
import { workerRequest } from './workerApi';
import bossRecommendationSettings from './boss-recommendations.json';
import {
  bossRecommendationForCharacter,
  maxPartySizeForBoss,
  recommendationsForCharacter,
} from './bossRecommendations';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const workerApiUrl = import.meta.env.VITE_WORKER_API_URL;
const mapleScouterOrigin = 'https://maplescouter.com';
const mapleScouterMessageType = 'maple-scout/maplescouter-import';
const extensionCheckType = 'maple-scout/extension-check';
const extensionStatusType = 'maple-scout/extension-status';
const rememberLoginKey = 'maple-scout-remember-login';
const savedSessionKey = 'maple-scout-session';
const themeKey = 'maple-scout-theme';
const activeCharactersKeyPrefix = 'maple-scout-active-characters:';
const nexonApiKeyCookie = 'maple-scout-nexon-api-key';
const nexonApiKeyCookieMaxAge = 60 * 60 * 24 * 30;
const bossImages = import.meta.glob('./bossImage/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
});
const bossFamilyDisplayNames = {
  bardrix: '발드릭스',
  bellona: '벨로나',
  blackmage: '검은 마법사',
  jupiter: '유피테르',
  kalos: '칼로스',
  kaling: '카링',
  limbo: '림보',
  maleficstar: '흉성',
  seren: '세렌',
};

const bossFamilyTopPrice = bossRecommendationSettings.bosses.reduce((prices, boss) => {
  prices[boss.familyId] = Math.max(prices[boss.familyId] || 0, boss.changedPrice);
  return prices;
}, {});

function recommendationPartyLabel(size) {
  return Number(size) === 1 ? '솔플 가능' : `${size}인격 가능`;
}

function bossImageFor(bossId) {
  const normalizedBossId = String(bossId || '').toLocaleLowerCase('en-US');
  const findImagePath = (imageBossId) => Object.keys(bossImages).find((path) => (
    path.split('/').at(-1).replace(/\.png$/i, '').toLocaleLowerCase('en-US') === imageBossId
  ));
  const directImagePath = findImagePath(normalizedBossId);
  if (directImagePath) return bossImages[directImagePath];
  const boss = bossRecommendationSettings.bosses.find((entry) => (
    entry.bossId.toLocaleLowerCase('en-US') === normalizedBossId
  ));
  const familyImageBoss = boss && bossRecommendationSettings.bosses
    .filter((entry) => entry.familyId === boss.familyId)
    .sort((left, right) => right.changedPrice - left.changedPrice)
    .find((entry) => findImagePath(entry.bossId.toLocaleLowerCase('en-US')));
  const familyImagePath = familyImageBoss && findImagePath(familyImageBoss.bossId.toLocaleLowerCase('en-US'));
  if (familyImagePath) return bossImages[familyImagePath];
  return null;
}

function getGoogleAuthorizationCode() {
  return new Promise((resolve, reject) => {
    const google = window.google;
    if (!google?.accounts?.oauth2 || !clientId) {
      reject(new Error('Google OAuth Client ID 설정을 확인해 주세요.'));
      return;
    }

    const codeClient = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: 'openid email profile',
      ux_mode: 'popup',
      select_account: true,
      callback: (response) => {
        if (response.error) reject(new Error(response.error_description || response.error));
        else if (response.code) resolve(response.code);
        else reject(new Error('Google 인증 코드를 받지 못했습니다.'));
      },
      error_callback: (error) => reject(new Error(error.message || 'Google 로그인 창을 열지 못했습니다.')),
    });
    codeClient.requestCode({ prompt: 'consent' });
  });
}

function readSavedSession() {
  try {
    return window.localStorage.getItem(savedSessionKey) || '';
  } catch {
    return '';
  }
}

function clearSavedSession() {
  try {
    window.localStorage.removeItem(savedSessionKey);
  } catch {
    // Logging out still clears the in-memory session.
  }
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

function bossDetails(bossId) {
  const boss = bossRecommendationSettings.bosses.find((entry) => entry.bossId.toLowerCase() === bossId.toLowerCase());
  return boss ? {
    ...boss,
    maxPartySize: maxPartySizeForBoss(boss),
  } : { bossId, name: bossId, difficultyLabel: '', maxPartySize: 1, cycle: 'weekly' };
}

const scheduleDifficultyLabels = {
  easy: '이지',
  normal: '노말',
  hard: '하드',
  extreme: '익스트림',
  chaos: '카오스',
};
const difficultyOrder = ['extreme', 'hard', 'chaos', 'normal', 'easy'];
const difficultyMarks = {
  easy: 'E',
  normal: 'N',
  hard: 'H',
  extreme: 'E',
  chaos: 'C',
};

function compareBossDifficulty(left, right) {
  const leftRank = difficultyOrder.indexOf(left.option?.difficulty || left.difficulty);
  const rightRank = difficultyOrder.indexOf(right.option?.difficulty || right.difficulty);
  return (leftRank === -1 ? difficultyOrder.length : leftRank)
    - (rightRank === -1 ? difficultyOrder.length : rightRank);
}

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
    bossId: config?.bossId || '',
    familyId: familyKey,
    familyKey,
    difficulty,
    difficultyLabel: scheduleDifficultyLabels[difficulty] || difficulty,
    cycle: config?.cycle || (item.cycle === 'bossMonthly' ? 'monthly' : 'weekly'),
    key: `${familyKey}::${difficulty}`,
  };
}

function summarizeBossParty(party, groupCharacters = []) {
  const boss = bossDetails(party.bossId);
  const members = party.members || [];
  const totalMultiplier = members.reduce((total, member) => total + (Number(member.multiplier) || 0), 0);
  const matchingSchedules = members.flatMap((member) => {
    const character = groupCharacters.find((groupCharacter) => (
      groupCharacter.ocid === member.ocid
      && (!member.ownerSub || groupCharacter.ownerSub === member.ownerSub)
    )) || member;
    return (character.scheduler?.boss_contents || [])
      .filter((item) => scheduleBossOption(item).familyKey === boss.familyId);
  });
  const cleared = matchingSchedules.some((item) => item.complete_flag === true || item.complete_flag === 'true');
  return {
    totalMultiplier,
    ready: totalMultiplier >= 100,
    cleared,
    clearRecordAvailable: matchingSchedules.length > 0,
    statusLabel: cleared ? '클리어' : '미클리어',
  };
}

function characterBossClearStatus(character, boss) {
  const matchingSchedules = (character.scheduler?.boss_contents || []).filter((item) => {
    const option = scheduleBossOption(item);
    return option.familyKey === boss.familyId && option.difficulty === boss.difficulty;
  });
  return matchingSchedules.some((item) => item.complete_flag === true || item.complete_flag === 'true')
    ? '클리어'
    : '미클리어';
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
        (Number(right.level) || 0) - (Number(left.level) || 0)
        || compareScore(left, right)
        || left.nickname.localeCompare(right.nickname, 'ko')
      )),
    }))
    .sort((left, right) => (
      (Number(right.characters[0]?.level) || 0) - (Number(left.characters[0]?.level) || 0)
      || compareScore(left.characters[0], right.characters[0])
      || left.worldName.localeCompare(right.worldName, 'ko')
    ));
}

function App() {
  const [accessToken, setAccessToken] = useState('');
  const [account, setAccount] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [activeCharacterIds, setActiveCharacterIds] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characterWorldFilter, setCharacterWorldFilter] = useState('');
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [multipliers, setMultipliers] = useState([]);
  const [accountMultipliers, setAccountMultipliers] = useState([]);
  const [groupCharacters, setGroupCharacters] = useState([]);
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupParties, setGroupParties] = useState([]);
  const [partyDraft, setPartyDraft] = useState(null);
  const [allGroupParties, setAllGroupParties] = useState([]);
  const [partyOverviewSearch, setPartyOverviewSearch] = useState('');
  const [partyOverviewSort, setPartyOverviewSort] = useState('default');
  const [partyOverviewFilters, setPartyOverviewFilters] = useState({
    mine: false,
    empty: false,
    belowTarget: false,
    uncleared: false,
  });
  const [partyRemovalConfirmationId, setPartyRemovalConfirmationId] = useState('');
  const [showGroupDeleteConfirmation, setShowGroupDeleteConfirmation] = useState(false);
  const [memberRemovalEmail, setMemberRemovalEmail] = useState('');
  const [focusedPartyId, setFocusedPartyId] = useState('');
  const [selectedBossFamilyId, setSelectedBossFamilyId] = useState('');
  const [selectedBossDifficultyId, setSelectedBossDifficultyId] = useState('');
  const [quickPartyBossId, setQuickPartyBossId] = useState('');
  const [selectedQuickCharacterKey, setSelectedQuickCharacterKey] = useState('');
  const [quickRecommendedOnly, setQuickRecommendedOnly] = useState(true);
  const [quickIncludeFullMultiplier, setQuickIncludeFullMultiplier] = useState(false);
  const [partyWarningPopup, setPartyWarningPopup] = useState(null);
  const [activeBuilderPartyId, setActiveBuilderPartyId] = useState('');
  const [draggedPartyCharacter, setDraggedPartyCharacter] = useState(null);
  const [dragOverPartyId, setDragOverPartyId] = useState('');
  const [bossQuickMenuCollapsed, setBossQuickMenuCollapsed] = useState(() => window.innerWidth <= 560);
  const [characterQuickMenuCollapsed, setCharacterQuickMenuCollapsed] = useState(() => window.innerWidth <= 560);
  const [inviteLink, setInviteLink] = useState('');
  const [invitePrompt, setInvitePrompt] = useState(null);
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
  const restoreLoginOnMount = useRef(rememberLogin && Boolean(readSavedSession()));
  const loginRestoreAttempted = useRef(false);
  const mapleScouterPopup = useRef(null);
  const mapleScouterRequest = useRef(null);
  const mapleScouterTimeout = useRef(null);
  const characterSelectionSaveQueue = useRef(Promise.resolve());

  useEffect(() => {
    const closePopup = (event) => {
      if (event.target.closest?.('.group-party-warning-popup, .group-party-warning-trigger')) return;
      setPartyWarningPopup(null);
    };
    const closePopupOnEscape = (event) => {
      if (event.key === 'Escape') setPartyWarningPopup(null);
    };
    document.addEventListener('click', closePopup);
    window.addEventListener('keydown', closePopupOnEscape);
    return () => {
      document.removeEventListener('click', closePopup);
      window.removeEventListener('keydown', closePopupOnEscape);
    };
  }, []);

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
    if (view !== 'group' || !focusedPartyId) return;
    const party = groupParties.find(({ partyId }) => partyId === focusedPartyId);
    if (!party) return;
    const partyElement = document.getElementById(`group-party-${focusedPartyId}`);
    if (typeof partyElement?.scrollIntoView === 'function') {
      partyElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [view, focusedPartyId, groupParties]);

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
      setGroupMembers([]);
      setGroupParties([]);
      setInviteLink('');
      return;
    }
    const [multiplierResult, characterResult, partyResult, memberResult] = await Promise.all([
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/multipliers`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/characters`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/parties`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/members`),
    ]);
    setMultipliers(multiplierResult.multipliers);
    setGroupCharacters(characterResult.characters || []);
    setGroupMembers(memberResult.members || []);
    setGroupParties(partyResult.parties || []);
  }

  async function loadAllGroupPartyData(token, groupsToLoad = groups) {
    const results = await Promise.all(groupsToLoad.map(async (group) => {
      const partyResult = await workerRequest(token, `/api/groups/${encodeURIComponent(group.id)}/parties`);
      return {
        groupId: group.id,
        groupName: group.name,
        parties: partyResult.parties || [],
      };
    }));
    setAllGroupParties(results.flatMap(({ groupId, groupName, parties }) => (
      parties.map((party) => ({ ...party, groupId, groupName }))
    )));
  }

  async function createGroupInvite() {
    if (!selectedGroupId) return;
    setBusy('invite');
    try {
      const result = await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/invites`, { method: 'POST' });
      const inviteUrl = new URL('/', window.location.origin);
      inviteUrl.searchParams.set('invite', result.token);
      setInviteLink(inviteUrl.toString());
      setNotice({ type: 'success', text: `초대 링크를 만들었습니다. ${new Date(result.expiresAt).toLocaleString('ko-KR')}까지 유효합니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function removeMemberFromGroup(email) {
    if (!selectedGroupId || selectedGroup?.role !== 'admin') return;
    const groupId = selectedGroupId;
    setBusy('group-member-remove');
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'DELETE',
        body: JSON.stringify({ email }),
      });
      setMemberRemovalEmail('');
      await Promise.all([
        loadGroupData(accessToken, groupId),
        loadAllGroupPartyData(accessToken),
      ]);
      setNotice({ type: 'success', text: `${email} 님을 그룹에서 제거했습니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  function openGroupMembers() {
    if (partyDraft?.groupId === selectedGroupId) {
      setNotice({ type: 'error', text: '먼저 파티 편성 변경을 완료하거나 취소한 뒤 인원을 관리해 주세요.' });
      return;
    }
    setView('members');
  }

  async function updateGroupImage(mainImageBossId) {
    if (!selectedGroupId) return;
    setBusy('group-image');
    try {
      const result = await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ mainImageBossId }),
      });
      setGroups((current) => current.map((group) => (
        group.id === selectedGroupId ? { ...group, mainImageBossId: result.mainImageBossId } : group
      )));
      setNotice({ type: 'success', text: '그룹 대표 이미지를 변경했습니다.' });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function deleteSelectedGroup() {
    if (!selectedGroupId || selectedGroup?.role !== 'admin') return;
    const deletedGroupName = selectedGroup.name;
    setBusy('group-delete');
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}`, { method: 'DELETE' });
      const remainingGroups = groups.filter(({ id }) => id !== selectedGroupId);
      setGroups(remainingGroups);
      setShowGroupDeleteConfirmation(false);
      setView('group');
      setSelectedGroupId(remainingGroups[0]?.id || '');
      await Promise.all([
        loadGroupData(accessToken, remainingGroups[0]?.id || ''),
        loadAllGroupPartyData(accessToken, remainingGroups),
      ]);
      setNotice({ type: 'success', text: `“${deletedGroupName}” 그룹을 삭제했습니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  function updatePartyDraft(update) {
    const parties = partyDraft?.groupId === selectedGroupId ? partyDraft.parties : groupParties;
    setPartyDraft({ groupId: selectedGroupId, parties: update(parties) });
  }

  function partyMemberFromCharacter(character, bossId) {
    return {
      ...character,
      multiplier: getCharacterBossMultiplier(character, bossId),
    };
  }

  function stageCharacterOnParty(character, partyId) {
    const target = currentGroupParties.find(({ partyId: currentId }) => currentId === partyId);
    if (!target) return;
    if (character.ownerSub !== account?.sub && selectedGroup?.role !== 'admin') {
      setNotice({ type: 'error', text: '본인 캐릭터 또는 그룹 관리자만 파티를 편성할 수 있습니다.' });
      return;
    }
    const targetFamilyId = target.familyId || bossDetails(target.bossId).familyId;
    const assignedInOtherGroup = allGroupParties.some((party) => (
      party.groupId !== selectedGroupId
      && (party.familyId || bossDetails(party.bossId).familyId) === targetFamilyId
      && (party.members || []).some(({ ownerSub, ocid }) => (
        ownerSub === character.ownerSub && ocid === character.ocid
      ))
    ));
    if (assignedInOtherGroup) {
      setNotice({ type: 'error', text: `${character.nickname}은(는) 다른 그룹에서 이미 같은 보스 파티에 편성되어 있습니다.` });
      return;
    }
    const targetMembers = target.members || [];
    if (targetMembers.some(({ ownerSub, ocid }) => (
      ownerSub === character.ownerSub && ocid !== character.ocid
    ))) {
      setNotice({ type: 'error', text: '한 파티에는 같은 계정의 캐릭터를 한 명만 편성할 수 있습니다.' });
      return;
    }
    if (targetMembers.some(({ ocid }) => ocid === character.ocid)) return;
    const maxPartySize = bossDetails(target.bossId).maxPartySize;
    if (targetMembers.length >= maxPartySize) {
      setNotice({ type: 'error', text: `${bossDetails(target.bossId).name} 파티는 최대 ${maxPartySize}명까지 편성할 수 있습니다.` });
      return;
    }
    const familyId = target.familyId || bossDetails(target.bossId).familyId;
    const member = partyMemberFromCharacter(character, target.bossId);
    updatePartyDraft((parties) => parties.map((party) => {
      const partyFamily = party.familyId || bossDetails(party.bossId).familyId;
      const remainingMembers = party.members.filter((currentMember) => (
        !(partyFamily === familyId
          && currentMember.ownerSub === character.ownerSub
          && currentMember.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko'))
      ));
      return {
        ...party,
        members: party.partyId === partyId
          ? [...remainingMembers, member]
          : remainingMembers,
      };
    }));
    setNotice({ type: 'success', text: '편성 변경을 임시 저장했습니다. 완료를 눌러 반영하세요.' });
  }

  function removePartyMemberDraft(character, partyId) {
    if (character.ownerSub !== account?.sub && selectedGroup?.role !== 'admin') {
      setNotice({ type: 'error', text: '본인 캐릭터 또는 그룹 관리자만 파티에서 제외할 수 있습니다.' });
      return;
    }
    updatePartyDraft((parties) => parties.map((party) => (
      party.partyId === partyId
        ? {
          ...party,
          members: party.members.filter((member) => !(
            member.ownerSub === character.ownerSub && member.ocid === character.ocid
          )),
        }
        : party
    )));
    setNotice({ type: 'success', text: '편성 변경을 임시 저장했습니다. 완료를 눌러 반영하세요.' });
  }

  function removePartyDraft(partyId) {
    const party = currentGroupParties.find(({ partyId: id }) => id === partyId);
    if (!party) return;
    if (selectedGroup?.role !== 'admin' && (party.members || []).some(({ ownerSub }) => ownerSub !== account?.sub)) {
      setNotice({ type: 'error', text: '다른 그룹원의 캐릭터가 포함된 파티는 관리자만 삭제할 수 있습니다.' });
      return;
    }
    updatePartyDraft((parties) => parties.filter(({ partyId: id }) => id !== partyId));
    if (focusedPartyId === partyId) setFocusedPartyId('');
    if (activeBuilderPartyId === partyId) setActiveBuilderPartyId('');
    setNotice({ type: 'success', text: '파티 삭제를 임시 저장했습니다. 완료를 누르면 파티와 편성이 삭제됩니다.' });
  }

  function requestPartyRemoval(party) {
    if (quickPartyBossId && focusedPartyId === party.partyId) {
      setQuickPartyBossId('');
      return;
    }
    setPartyRemovalConfirmationId(party.partyId);
  }

  function confirmPartyRemoval() {
    if (!partyRemovalConfirmationId) return;
    removePartyDraft(partyRemovalConfirmationId);
    setPartyRemovalConfirmationId('');
  }

  function createEmptyBossParty(boss, character = null) {
    if (!selectedGroupId) return;
    if (character && character.ownerSub !== account?.sub && selectedGroup?.role !== 'admin') {
      setNotice({ type: 'error', text: '본인 캐릭터 또는 그룹 관리자만 파티를 편성할 수 있습니다.' });
      return;
    }
    const partyId = crypto.randomUUID();
    updatePartyDraft((parties) => [...parties, {
      partyId,
      bossId: boss.bossId,
      familyId: boss.familyId,
      members: character ? [partyMemberFromCharacter(character, boss.bossId)] : [],
      createdAt: new Date().toISOString(),
    }]);
    setSelectedBossFamilyId(boss.familyId);
    setSelectedBossDifficultyId(boss.bossId);
    setFocusedPartyId(partyId);
    setActiveBuilderPartyId(partyId);
    setQuickPartyBossId(boss.bossId);
    setNotice({
      type: 'success',
      text: character
        ? `${character.nickname}을(를) 포함한 새 파티를 임시로 추가했습니다. 완료를 눌러 반영하세요.`
        : '빈 파티를 임시로 추가했습니다. 완료를 눌러 반영하세요.',
    });
  }

  function focusQuickParty(party) {
    setFocusedPartyId(party.partyId);
    setQuickPartyBossId(party.bossId);
  }

  function assignBossToCharacter(character, boss, partyId = null) {
    const target = partyId
      ? currentGroupParties.find(({ partyId: currentId }) => currentId === partyId)
      : currentGroupParties.find(({ bossId: currentBossId, members = [] }) => (
        currentBossId === boss.bossId
          && members.length < boss.maxPartySize
          && !members.some(({ ownerSub }) => ownerSub === character.ownerSub)
      ));
    if (target) stageCharacterOnParty(character, target.partyId);
    else if (!partyId) {
      const newPartyId = crypto.randomUUID();
      updatePartyDraft((parties) => [...parties, {
        partyId: newPartyId,
        bossId: boss.bossId,
        familyId: boss.familyId,
        members: [partyMemberFromCharacter(character, boss.bossId)],
        createdAt: new Date().toISOString(),
      }]);
      setNotice({ type: 'success', text: '새 파티 편성을 임시 저장했습니다. 완료를 눌러 반영하세요.' });
    }
  }

  function unassignBossFromCharacter(character, bossId, partyId = null) {
    const party = partyId
      ? currentGroupParties.find(({ partyId: currentId }) => currentId === partyId)
      : currentGroupParties.find(({ bossId: currentBossId, members = [] }) => (
        currentBossId === bossId && members.some(({ ocid }) => ocid === character.ocid)
      ));
    if (party) removePartyMemberDraft(character, party.partyId);
  }

  async function savePartyDraft(partiesToSave = partyDraft?.groupId === selectedGroupId ? partyDraft.parties : null) {
    if (!selectedGroupId || !partiesToSave || busy === 'party-save') return;
    setBusy('party-save');
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/parties/commit`, {
        method: 'PUT',
        body: JSON.stringify({
          parties: partiesToSave.map(({ partyId, bossId, members }) => ({
            partyId,
            bossId,
            members: members.map(({ ocid }) => ({ ocid })),
          })),
        }),
      });
      setGroupParties(partiesToSave);
      setPartyDraft(null);
      await loadGroupData(accessToken, selectedGroupId);
      await loadAllGroupPartyData(accessToken);
      setNotice({ type: 'success', text: '파티 편성 변경을 모두 저장했습니다.' });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  function discardPartyDraft() {
    setPartyDraft(null);
    setNotice({ type: 'success', text: '저장하지 않은 파티 편성 변경을 취소했습니다.' });
  }

  function getCharacterBossMultiplier(character, bossId) {
    return Math.max(0, ...multipliers
      .filter((entry) => (!entry.ownerSub || entry.ownerSub === character.ownerSub)
        && entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
        && entry.bossId?.toLowerCase() === bossId.toLowerCase())
      .map((entry) => Number(entry.multiplier) || 0));
  }

  function startPartyMemberDrag(event, character, assignedParty = null) {
    if (character.ownerSub !== account?.sub && selectedGroup?.role !== 'admin') {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${character.ownerSub}:${character.ocid}`);
    const draggedFromPartyId = assignedParty
      && (!assignedParty.groupId || assignedParty.groupId === selectedGroupId)
      ? assignedParty.partyId
      : '';
    setDraggedPartyCharacter({ ...character, draggedFromPartyId });
  }

  function dragOverParty(event, party) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverPartyId(party.partyId);
  }

  function dropCharacterOnParty(event, party) {
    event.preventDefault();
    setDragOverPartyId('');
    setActiveBuilderPartyId(party.partyId);
    const characterKey = event.dataTransfer.getData('text/plain');
    const character = groupCharacters.find((entry) => `${entry.ownerSub}:${entry.ocid}` === characterKey)
      || (draggedPartyCharacter
        && `${draggedPartyCharacter.ownerSub}:${draggedPartyCharacter.ocid}` === characterKey
        ? draggedPartyCharacter
        : null);
    if (!character) return;
    stageCharacterOnParty(character, party.partyId);
    setDraggedPartyCharacter(null);
  }

  function handleGroupCanvasDragOver(event) {
    if (!draggedPartyCharacter || !['group', 'bosses'].includes(view)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function dropPartyCharacterOnEmptySpace(event) {
    if (!draggedPartyCharacter || !['group', 'bosses'].includes(view)) return;
    if (event.target.closest?.('.group-main-party-card, .builder-party-card')) return;
    event.preventDefault();
    const partyId = draggedPartyCharacter.draggedFromPartyId;
    const party = currentGroupParties.find(({ partyId: currentId }) => currentId === partyId);
    if (party) removePartyMemberDraft(draggedPartyCharacter, party.partyId);
    setDraggedPartyCharacter(null);
    setDragOverPartyId('');
  }

  function finishPartyMemberDrag() {
    setDraggedPartyCharacter(null);
    setDragOverPartyId('');
  }

  async function openPartyGroup(groupId, partyId = '') {
    setFocusedPartyId(partyId);
    if (groupId !== selectedGroupId) await selectGroup(groupId);
    else setView('group');
    if (!partyId) setView('bosses');
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

  async function previewGroupInvite(token, authToken) {
    try {
      const invitation = await workerRequest(authToken, '/api/group-invites/preview', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      return { ...invitation, token };
    } catch (error) {
      return { token, error: error.message || '초대 정보를 불러오지 못했습니다.' };
    }
  }

  async function retryGroupInvitePreview() {
    if (!invitePrompt?.token) return;
    setBusy('invite-preview');
    try {
      setInvitePrompt(await previewGroupInvite(invitePrompt.token, accessToken));
    } finally {
      setBusy('');
    }
  }

  async function joinInvitedGroup() {
    if (!invitePrompt?.token || !accessToken) return;
    setBusy('invite-accept');
    try {
      await workerRequest(accessToken, '/api/characters/selection', {
        method: 'PUT',
        body: JSON.stringify({ ocids: activeCharacterIds }),
      });
      const joined = await workerRequest(accessToken, '/api/group-invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token: invitePrompt.token }),
      });
      const refreshedGroups = await workerRequest(accessToken, '/api/groups');
      const savedGroups = refreshedGroups.groups || [];
      setGroups(savedGroups);
      setSelectedGroupId(joined.groupId);
      setView('group');
      setInvitePrompt(null);
      await Promise.all([
        loadGroupData(accessToken, joined.groupId),
        loadAllGroupPartyData(accessToken, savedGroups),
      ]);
      setNotice({
        type: 'success',
        text: joined.joined === false
          ? `이미 ${joined.groupName} 그룹에 참여한 상태입니다.`
          : `${joined.groupName} 그룹에 참가했습니다.`,
      });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function openInvitedGroup() {
    if (!invitePrompt?.groupId) return;
    setBusy('invite-accept');
    try {
      setSelectedGroupId(invitePrompt.groupId);
      setView('group');
      await Promise.all([
        loadGroupData(accessToken, invitePrompt.groupId),
        loadAllGroupPartyData(accessToken),
      ]);
      setInvitePrompt(null);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function finishSignIn(token, profile, silent = false) {
    const [groupResult, characterResult, selectionResult, multiplierResult] = await Promise.all([
      workerRequest(token, '/api/groups'),
      workerRequest(token, '/api/characters'),
      workerRequest(token, '/api/characters/selection').catch(() => null),
      workerRequest(token, '/api/characters/multipliers'),
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
    setCharacters(savedCharacters);
    setAccountMultipliers(multiplierResult.multipliers || []);
    setActiveCharacterIds(savedActiveCharacterIds);
    setSelectedCharacterId(savedActiveCharacterIds[0] || '');
    const inviteToken = new URLSearchParams(window.location.search).get('invite');
    let invitation = null;
    if (inviteToken) {
      invitation = await previewGroupInvite(inviteToken, token);
      window.history.replaceState({}, '', `${window.location.origin}/`);
      if (invitation?.alreadyJoined) {
        setSelectedGroupId(invitation.groupId);
        setView('group');
      }
    }
    setGroups(savedGroups);
    const initialGroupId = invitation?.alreadyJoined
      ? invitation.groupId
      : savedGroups[0]?.id || '';
    setSelectedGroupId(initialGroupId);
    await Promise.all([
      loadGroupData(token, initialGroupId),
      loadAllGroupPartyData(token, savedGroups),
    ]);
    setAccessToken(token);
    setAccount({ email: profile.email, name: profile.name, sub: profile.sub });
    if (invitation) setInvitePrompt(invitation);
    if (!silent && !inviteToken) setNotice({ type: 'success', text: `${profile.email} 계정으로 연결했습니다.` });
  }

  async function signIn() {
    setBusy('signin');
    setNotice(null);
    try {
      if (!workerApiUrl) throw new Error('VITE_WORKER_API_URL 설정을 확인해 주세요.');
      const code = await getGoogleAuthorizationCode();
      const session = await workerRequest('', '/api/auth/google', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ code, remember: rememberLogin }),
      });
      const token = session.sessionToken;
      const profile = session.account;
      if (!token || !profile?.email) throw new Error('로그인 세션을 만들지 못했습니다.');
      let sessionStorageFailed = false;
      if (rememberLogin) {
        try {
          window.localStorage.setItem(savedSessionKey, token);
        } catch {
          sessionStorageFailed = true;
        }
      }
      await finishSignIn(token, profile);
      if (sessionStorageFailed) {
        setNotice({ type: 'error', text: '로그인은 완료했지만 이 브라우저에 로그인 세션을 저장하지 못했습니다.' });
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function restoreSavedLogin() {
    const token = readSavedSession();
    if (!token) return;
    setBusy('signin');
    try {
      const session = await workerRequest(token, '/api/auth/session');
      if (!session.account?.email) throw new Error('저장된 로그인 세션을 확인할 수 없습니다.');
      await finishSignIn(token, session.account, true);
    } catch (error) {
      if (error.status === 401) clearSavedSession();
      setNotice({
        type: 'error',
        text: error.status === 401
          ? '로그인 세션이 만료되었습니다. Google 계정으로 다시 로그인해 주세요.'
          : `로그인 세션을 복원하지 못했습니다: ${error.message}`,
      });
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    if (restoreLoginOnMount.current && !loginRestoreAttempted.current) {
      loginRestoreAttempted.current = true;
      restoreSavedLogin();
    }
  }, []);

  function changeRememberLogin(event) {
    const checked = event.target.checked;
    setRememberLogin(checked);
    try {
      window.localStorage.setItem(rememberLoginKey, String(checked));
      if (!checked) clearSavedSession();
    } catch {
      if (checked) {
        setNotice({ type: 'error', text: '브라우저가 로그인 유지 설정을 저장하지 못했습니다.' });
      }
    }
  }

  async function logOut() {
    const token = accessToken;
    setRememberLogin(false);
    clearSavedSession();
    try {
      window.localStorage.removeItem(rememberLoginKey);
    } catch {
      // The current in-memory session is still cleared below.
    }
    setAccessToken('');
    setAccount(null);
    setCharacters([]);
    setNexonKey('');
    setActiveCharacterIds([]);
    setSelectedGroupId('');
    setGroups([]);
    setGroupCharacters([]);
    setGroupParties([]);
    setMultipliers([]);
    setAccountMultipliers([]);
    setAllGroupParties([]);
    setView('characters');
    try {
      await workerRequest(token, '/api/auth/session', { method: 'DELETE' });
    } catch (error) {
      setNotice({ type: 'error', text: `로그아웃했지만 서버 세션을 폐기하지 못했습니다: ${error.message}` });
    }
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

  async function syncCharacters(event, { quiet = false } = {}) {
    event?.preventDefault();
    const apiKey = nexonKey.trim();
    if (!apiKey) {
      const error = new Error('계정 설정에서 Nexon API 키를 먼저 입력해 주세요.');
      if (quiet) throw error;
      setNotice({ type: 'error', text: error.message });
      return null;
    }
    if (!quiet) {
      setBusy('sync');
      setNotice(null);
    }
    try {
      const result = await workerRequest(accessToken, '/api/characters/verify', {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      });
      const syncedCharacters = result.characters || [];
      if (!syncedCharacters.length) throw new Error('Nexon API에서 캐릭터 목록을 찾을 수 없습니다.');
      setCharacters(syncedCharacters);
      const retainedActiveIds = activeCharacterIds.filter((ocid) => (
        syncedCharacters.some((character) => character.ocid === ocid)
      ));
      saveActiveCharacterIds(retainedActiveIds);
      const skippedCharacters = result.skippedCharacters || [];
      const schedulerUnavailable = result.schedulerUnavailable || [];
      const summary = {
        characterCount: syncedCharacters.length,
        skippedCount: skippedCharacters.length,
        schedulerUnavailableCount: schedulerUnavailable.length,
        characters: syncedCharacters,
      };
      if (!quiet) {
        setNotice({
          type: 'success',
          text: [
            `${syncedCharacters.length}개 캐릭터 정보를 동기화했습니다.`,
            skippedCharacters.length ? `${skippedCharacters.length}개 캐릭터는 정보를 가져오지 못해 건너뛰었습니다.` : '',
            schedulerUnavailable.length ? `${schedulerUnavailable.length}개 캐릭터의 스케줄러 정보는 가져오지 못했습니다.` : '',
          ].filter(Boolean).join(' '),
        });
      }
      return summary;
    } catch (error) {
      if (quiet) throw error;
      reportError(error);
      return null;
    } finally {
      if (!quiet) setBusy('');
    }
  }

  async function importCharactersAndSyncMultipliers(event) {
    event.preventDefault();
    if (!nexonKey.trim()) {
      await syncCharacters(null);
      return;
    }

    const popup = window.open('about:blank', '_blank');
    setBusy('maplescouter-check');
    setNotice(null);
    setShowExtensionInstallHelp(false);
    const extensionInstalled = await checkMapleScouterExtension();
    setBusy('');
    if (!extensionInstalled) {
      popup?.close();
      setShowExtensionInstallHelp(true);
    }

    const result = await syncCharacters(null);
    if (!result) {
      popup?.close();
      return;
    }
    if (!extensionInstalled) {
      setNotice({
        type: 'error',
        text: `캐릭터 ${result.characterCount}개와 스케줄을 불러왔습니다. 배율 동기화를 위해 MemoFam Reader 확장을 설치하고 활성화해 주세요.`,
      });
      return;
    }

    await refreshMapleScouterData(
      result.characters,
      Promise.resolve(result),
      extensionInstalled,
      popup,
    );
  }

  async function selectGroup(groupId) {
    setPartyDraft(null);
    setSelectedGroupId(groupId);
    setPartyOverviewSearch('');
    setPartyOverviewSort('default');
    setPartyOverviewFilters({ mine: false, empty: false, belowTarget: false, uncleared: false });
    setQuickPartyBossId('');
    setSelectedQuickCharacterKey('');
    setShowGroupDeleteConfirmation(false);
    setSelectedBossFamilyId('');
    setSelectedBossDifficultyId('');
    setActiveBuilderPartyId('');
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

  async function openGroupPartyBuilder(groupId, bossId = '') {
    if (bossId) setQuickPartyBossId(bossId);
    if (groupId !== selectedGroupId) await selectGroup(groupId);
    document.getElementById('group-party-builder')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
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
      setShowGroupDeleteConfirmation(false);
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

  async function refreshMapleScouterData(
    charactersToRefresh = activeCharacters,
    existingScheduleSyncPromise = null,
    extensionAlreadyChecked = null,
    existingPopup = undefined,
  ) {
    const refreshCharacters = charactersToRefresh.slice();
    if (!nexonKey.trim()) {
      setNotice({ type: 'error', text: '계정 설정에서 Nexon API 키를 먼저 입력해 주세요.' });
      return;
    }
    const scheduleSyncPromise = (existingScheduleSyncPromise || syncCharacters(null, { quiet: true }))
      .then((result) => ({ result }))
      .catch((error) => ({ error }));
    const scheduleSyncMessage = (outcome) => outcome.error
      ? `스케줄 동기화 실패: ${outcome.error.message || '실패'}`
      : `스케줄 ${outcome.result.characterCount}개 캐릭터 동기화 완료.`;
    const refreshGroupData = async () => {
      if (!selectedGroupId) return '';
      try {
        await loadGroupData(accessToken, selectedGroupId);
        return '';
      } catch (error) {
        return ` 그룹 정보 갱신 실패: ${error.message || '실패'}`;
      }
    };
    if (!refreshCharacters.length) {
      setBusy('sync');
      const scheduleOutcome = await scheduleSyncPromise;
      setBusy('');
      const groupFailure = await refreshGroupData();
      setNotice({
        type: scheduleOutcome.error ? 'error' : 'success',
        text: `${scheduleSyncMessage(scheduleOutcome)}${groupFailure}`,
      });
      return;
    }
    const popup = existingPopup === undefined ? window.open('about:blank', '_blank') : existingPopup;
    if (!popup) {
      setBusy('sync');
      const scheduleOutcome = await scheduleSyncPromise;
      setBusy('');
      const groupFailure = await refreshGroupData();
      setNotice({
        type: 'error',
        text: `MapleScouter 팝업이 차단됐습니다. 팝업을 허용해 주세요. ${scheduleSyncMessage(scheduleOutcome)}${groupFailure}`,
      });
      return;
    }

    setBusy('maplescouter-check');
    setNotice(null);
    if (extensionAlreadyChecked === null) setShowExtensionInstallHelp(false);
    const extensionInstalled = extensionAlreadyChecked ?? await checkMapleScouterExtension();
    if (!extensionInstalled) {
      popup.close();
      setBusy('');
      setShowExtensionInstallHelp(true);
      const scheduleOutcome = await scheduleSyncPromise;
      const groupFailure = await refreshGroupData();
      setNotice({
        type: 'error',
        text: `MemoFam Reader 확장이 없거나 현재 앱 도메인에서 활성화되지 않았습니다. ${scheduleSyncMessage(scheduleOutcome)}${groupFailure}`,
      });
      return;
    }
    if (popup.closed) {
      const scheduleOutcome = await scheduleSyncPromise;
      setBusy('');
      setNotice(scheduleOutcome.error
        ? { type: 'error', text: `새로 연 MapleScouter 창이 닫혔습니다. 스케줄 동기화 실패: ${scheduleOutcome.error.message || '실패'}` }
        : { type: 'success', text: `새로 연 MapleScouter 창이 닫혔습니다. ${scheduleOutcome.result.characterCount}개 캐릭터의 스케줄을 동기화했습니다.` });
      return;
    }

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
          const payload = await waitForMapleScouterResult(popup, character, null);
          if (payload.error) throw new Error(payload.error);
          if (typeof payload.nickname !== 'string'
            || payload.nickname.toLocaleLowerCase('ko') !== character.nickname.toLocaleLowerCase('ko')
            || !Number.isSafeInteger(payload.boss380HexaScore)
            || !Array.isArray(payload.multipliers)) {
            throw new Error('확장에서 받은 결과를 확인할 수 없습니다.');
          }
          if (!payload.multipliers.length) {
            throw new Error('보스 배율을 찾지 못했습니다.');
          }

          const result = await workerRequest(accessToken, '/api/characters/maplescouter-import', {
            method: 'POST',
            body: JSON.stringify({
              nickname: character.nickname,
              boss380HexaScore: payload.boss380HexaScore,
              multipliers: payload.multipliers,
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

      const scheduleOutcome = await scheduleSyncPromise;
      if (scheduleOutcome.error) {
        failures.push(`스케줄 동기화: ${scheduleOutcome.error.message || '실패'}`);
      }
      try {
        if (selectedGroupId) {
          await loadGroupData(accessToken, selectedGroupId);
        }
        const multiplierResult = await workerRequest(accessToken, '/api/characters/multipliers');
        setAccountMultipliers(multiplierResult.multipliers || []);
        await loadAllGroupPartyData(accessToken);
      } catch (error) {
        failures.push(`캐릭터/그룹 배율 새로고침: ${error.message || '실패'}`);
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

    const scheduleOutcome = await scheduleSyncPromise;
    const scheduleSummary = scheduleOutcome.error
      ? ''
      : ` ${scheduleSyncMessage(scheduleOutcome)}${scheduleOutcome.result.schedulerUnavailableCount
        ? ` ${scheduleOutcome.result.schedulerUnavailableCount}개 캐릭터의 스케줄 정보를 가져오지 못했습니다.`
        : ''}`;
    const summary = `실사용 캐릭터 ${successfulCharacters}/${refreshCharacters.length}명 동기화 완료, ${updatedMultipliers}개 캐릭터 배율 저장.${ignoredMultipliers ? ` ${ignoredMultipliers}개 보스는 제외했습니다.` : ''}${scheduleSummary}`;
    setNotice({
      type: failures.length ? 'error' : 'success',
      text: `${summary}${failures.length ? ` 실패: ${failures.join(' · ')}` : ''}`,
    });
  }

  async function refreshGroupPartySchedules() {
    await refreshMapleScouterData();
  }

  async function openChromeExtensionSettings() {
    const settingsUrl = window.navigator.userAgent.includes('Edg/') ? 'edge://extensions' : 'chrome://extensions';
    try {
      await window.navigator.clipboard.writeText(settingsUrl);
      setNotice({
        type: 'success',
        text: `${settingsUrl} 주소를 복사했습니다. 주소창에 붙여넣어 확장 프로그램 페이지를 여세요.`,
      });
    } catch {
      setNotice({
        type: 'error',
        text: `브라우저 보안 정책상 웹페이지에서 확장 프로그램 페이지를 직접 열 수 없습니다. 주소창에 ${settingsUrl} 를 입력해 주세요.`,
      });
    }
  }

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const currentGroupParties = partyDraft?.groupId === selectedGroupId ? partyDraft.parties : groupParties;
  const partyOverviewEntries = currentGroupParties.map((party, index) => {
    const config = bossDetails(party.bossId);
    const members = party.members || [];
    return {
      party,
      config,
      members,
      summary: summarizeBossParty(party, groupCharacters),
      hasOwnMember: members.some(({ ownerSub }) => ownerSub === account?.sub),
      isEmpty: members.length === 0,
      index,
    };
  });
  const normalizedPartySearch = partyOverviewSearch.trim().toLocaleLowerCase('ko');
  const hasPartyTypeFilter = partyOverviewFilters.mine || partyOverviewFilters.empty;
  const visiblePartyEntries = partyOverviewEntries
    .filter(({ config, members, summary, hasOwnMember, isEmpty }) => {
      if (hasPartyTypeFilter
        && !((partyOverviewFilters.mine && hasOwnMember) || (partyOverviewFilters.empty && isEmpty))) return false;
      if (partyOverviewFilters.belowTarget && summary.totalMultiplier >= 100) return false;
      if (partyOverviewFilters.uncleared && summary.cleared) return false;
      if (!normalizedPartySearch) return true;
      const searchableText = [
        config.name,
        config.difficultyLabel,
        ...members.map(({ nickname }) => nickname),
      ].join(' ').toLocaleLowerCase('ko');
      return searchableText.includes(normalizedPartySearch);
    })
    .sort((left, right) => {
      if (partyOverviewSort === 'multiplier-asc') {
        return left.summary.totalMultiplier - right.summary.totalMultiplier || left.index - right.index;
      }
      if (partyOverviewSort === 'members-asc') {
        return left.members.length - right.members.length || left.index - right.index;
      }
      if (partyOverviewSort === 'boss-name') {
        return left.config.name.localeCompare(right.config.name, 'ko')
          || compareBossDifficulty(left.config, right.config)
          || Number(left.summary.cleared) - Number(right.summary.cleared)
          || left.index - right.index;
      }
      return Number(left.summary.cleared) - Number(right.summary.cleared)
        || left.index - right.index;
    });
  const hasActivePartyOverviewFilters = Boolean(
    normalizedPartySearch
    || Object.values(partyOverviewFilters).some(Boolean)
    || partyOverviewSort !== 'default',
  );
  const activeCharacters = characters
    .filter(({ ocid }) => activeCharacterIds.includes(ocid))
    .sort((left, right) => (
      (Number(right.level) || 0) - (Number(left.level) || 0)
      || (Number(right.boss380HexaScore) || 0) - (Number(left.boss380HexaScore) || 0)
      || left.nickname.localeCompare(right.nickname, 'ko')
    ));
  const groupSettingsCharacters = [...new Map([
    ...activeCharacters,
    ...groupCharacters.filter((character) => (
      character.ownerSub === account?.sub
      || character.ownerEmail?.toLocaleLowerCase('ko') === account?.email?.toLocaleLowerCase('ko')
    )),
  ].map((character) => [character.ocid, character])).values()]
    .sort((left, right) => (
      (Number(right.level) || 0) - (Number(left.level) || 0)
      || left.nickname.localeCompare(right.nickname, 'ko')
    ));
  const activeOcids = new Set(activeCharacters.map(({ ocid }) => ocid));
  const personalParties = allGroupParties.filter((party) => (
    (party.members || []).some((member) => member.ownerSub === account?.sub && activeOcids.has(member.ocid))
  ));
  const filteredActiveCharacters = activeCharacters.filter((character) => {
    const matchesWorld = !characterWorldFilter || (character.worldName || '월드 정보 없음') === characterWorldFilter;
    return matchesWorld;
  });
  const activeCharacterWorldGroups = groupCharactersByWorld(filteredActiveCharacters);
  const activeCharacterWorlds = [...new Set(activeCharacters.map(({ worldName }) => worldName || '월드 정보 없음'))]
    .sort((left, right) => left.localeCompare(right, 'ko'));
  const characterWorldGroups = groupCharactersByWorld(characters);
  const selectedCharacter = activeCharacters.find(({ ocid }) => ocid === selectedCharacterId);
  const groupBossFamilies = [...bossRecommendationSettings.bosses.reduce((families, boss) => {
    const maxPartySize = bossRecommendationSettings.maxPartySizeByFamily[boss.familyId]
      || bossRecommendationSettings.defaultMaxPartySize;
    if (maxPartySize <= 1) return families;
    const family = families.get(boss.familyId) || {
      familyId: boss.familyId,
      name: bossFamilyDisplayNames[boss.familyId] || boss.name,
      maxPartySize,
      bosses: [],
    };
    family.bosses.push(boss);
    families.set(boss.familyId, family);
    return families;
  }, new Map()).values()].map((family) => ({
    ...family,
    bosses: family.bosses.slice().sort((left, right) => left.changedPrice - right.changedPrice),
  })).sort((left, right) => (
    Math.max(...right.bosses.map(({ changedPrice }) => changedPrice))
    - Math.max(...left.bosses.map(({ changedPrice }) => changedPrice))
  ));
  const selectedBossFamily = groupBossFamilies.find(({ familyId }) => familyId === selectedBossFamilyId);
  const selectedBossOptions = selectedBossFamily?.bosses.slice().sort(compareBossDifficulty) || [];
  const quickPartyBosses = groupBossFamilies.flatMap(({ bosses }) => bosses);
  const selectedQuickPartyBoss = quickPartyBosses.find(({ bossId }) => bossId === quickPartyBossId);
  const focusedQuickParty = currentGroupParties.find(({ partyId }) => partyId === focusedPartyId);
  const focusedQuickPartyNumber = focusedQuickParty
    ? currentGroupParties.filter(({ bossId }) => bossId === focusedQuickParty.bossId)
      .findIndex(({ partyId }) => partyId === focusedQuickParty.partyId) + 1
    : null;
  const partiesAcrossGroups = [
    ...currentGroupParties.map((party) => ({
      ...party,
      groupId: selectedGroupId,
      groupName: selectedGroup?.name,
    })),
    ...allGroupParties.filter(({ groupId }) => groupId !== selectedGroupId),
  ];
  const quickPartyCandidates = groupCharacters
    .map((character) => {
      const assignedParty = selectedQuickPartyBoss
        ? partiesAcrossGroups.find((party) => (
          (party.familyId || bossDetails(party.bossId).familyId) === selectedQuickPartyBoss.familyId
          && (party.members || []).some(({ ownerSub, ocid }) => (
            ownerSub === character.ownerSub && ocid === character.ocid
          ))
        ))
        : partiesAcrossGroups.find((party) => (
          (party.members || []).some(({ ownerSub, ocid }) => (
            ownerSub === character.ownerSub && ocid === character.ocid
          ))
        ));
      const characterMultipliers = multipliers.filter((entry) => (
        (!entry.ownerSub || entry.ownerSub === character.ownerSub)
        && entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
      ));
      return {
        ...character,
        quickMultiplier: selectedQuickPartyBoss
          ? getCharacterBossMultiplier(character, selectedQuickPartyBoss.bossId)
          : 0,
        quickRecommendation: selectedQuickPartyBoss
          ? bossRecommendationForCharacter(
            character,
            characterMultipliers,
            selectedQuickPartyBoss,
          )
          : null,
        missingPartyRecommendations: recommendationsForCharacter(character, characterMultipliers)
          .filter((boss) => (
            boss.recommendedPartySize > 1
            && !partiesAcrossGroups.some((party) => party.bossId === boss.bossId)
          )),
        assignedParty,
        sameAccountCharacterAssigned: Boolean(focusedQuickParty && (focusedQuickParty.members || []).some((member) => (
          member.ownerSub === character.ownerSub && member.ocid !== character.ocid
        ))),
      };
    })
    .sort((left, right) => (
      (Number(Boolean(left.assignedParty)) - Number(Boolean(right.assignedParty)))
      || (selectedQuickPartyBoss ? right.quickMultiplier - left.quickMultiplier : 0)
      || (Number(right.boss380HexaScore) || 0) - (Number(left.boss380HexaScore) || 0)
      || (Number(right.level) || 0) - (Number(left.level) || 0)
      || left.nickname.localeCompare(right.nickname, 'ko')
    ))
    .filter((character) => {
      if (!quickRecommendedOnly || !selectedQuickPartyBoss) return true;
      if (character.assignedParty) return false;
      const partySize = character.quickRecommendation?.recommendedPartySize;
      return partySize > 1 || (quickIncludeFullMultiplier && partySize === 1);
    });
  const quickPartyCharacterGroups = quickPartyCandidates
    .reduce((groups, character) => {
      const ownerEmail = character.ownerEmail?.toLocaleLowerCase('ko') || '';
      const member = groupMembers.find(({ email }) => email.toLocaleLowerCase('ko') === ownerEmail);
      const ownerName = character.ownerSub === account?.sub
        ? account?.name || account?.email?.split('@')[0] || '내 캐릭터'
        : member?.name?.trim() || character.ownerEmail?.split('@')[0] || '그룹 멤버';
      const group = groups.find(({ key }) => key === character.ownerSub);
      if (group) group.characters.push(character);
      else groups.push({ key: character.ownerSub, ownerName, characters: [character] });
      return groups;
    }, [])
    .sort((left, right) => (
      Number(right.key === account?.sub) - Number(left.key === account?.sub)
    ));
  const selectedQuickCharacter = quickPartyCandidates.find((character) => (
    `${character.ownerSub}:${character.ocid}` === selectedQuickCharacterKey
  ));
  const selectedQuickCharacterRecommendations = selectedQuickCharacter
    ? recommendationsForCharacter(
      selectedQuickCharacter,
      multipliers.filter((entry) => (
        (!entry.ownerSub || entry.ownerSub === selectedQuickCharacter.ownerSub)
        && entry.nickname?.toLocaleLowerCase('ko') === selectedQuickCharacter.nickname.toLocaleLowerCase('ko')
      )),
    )
    : [];
  const selectedQuickRecommendedBossIds = new Set(
    selectedQuickCharacterRecommendations.map(({ bossId }) => bossId),
  );
  const selectedBossDetails = selectedBossOptions.find(({ bossId }) => bossId === selectedBossDifficultyId);
  const selectedFamilyParties = selectedBossFamily
    ? groupParties.filter(({ familyId, bossId }) => (
      (familyId || bossDetails(bossId).familyId) === selectedBossFamily.familyId
    ))
    : [];
  const selectedDifficultyParties = selectedBossDetails
    ? selectedFamilyParties.filter(({ bossId }) => bossId === selectedBossDetails.bossId)
    : [];
  const assignedFamilyCharacterIds = new Set(selectedFamilyParties.flatMap(({ members = [] }) => (
    members.map(({ ocid, ownerSub }) => `${ownerSub}:${ocid}`)
  )));
  const groupPartyCandidates = groupCharacters
    .filter((character) => !selectedBossFamily
      || !assignedFamilyCharacterIds.has(`${character.ownerSub}:${character.ocid}`))
    .map((character) => {
      const familyMultiplierOptions = selectedBossFamily?.bosses
        .map((boss) => ({
          boss,
          multiplier: getCharacterBossMultiplier(character, boss.bossId),
        })) || [];
      const selectedMultiplier = selectedBossDetails
        ? getCharacterBossMultiplier(character, selectedBossDetails.bossId)
        : Math.max(0, ...familyMultiplierOptions.map(({ multiplier }) => multiplier));
      return {
        ...character,
        selectedMultiplier,
        recommendedBoss: familyMultiplierOptions
          .filter(({ boss, multiplier }) => multiplier === selectedMultiplier)
          .sort((left, right) => right.boss.changedPrice - left.boss.changedPrice)[0]?.boss,
      };
    })
    .sort((left, right) => (
      (selectedBossFamily ? right.selectedMultiplier - left.selectedMultiplier : 0)
      || (Number(right.boss380HexaScore) || 0) - (Number(left.boss380HexaScore) || 0)
      || (Number(right.level) || 0) - (Number(left.level) || 0)
      || left.nickname.localeCompare(right.nickname, 'ko')
    ));
  const unassignedRecommendations = new Map();
  const characterPartyAssignments = new Map();
  const soloRecommendations = new Map();
  for (const character of activeCharacters) {
    const characterMultipliers = accountMultipliers.filter((entry) => (
      entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
    ));
    const assignments = allGroupParties.flatMap((party) => (
      (party.members || [])
        .filter((member) => member.ocid === character.ocid && member.ownerSub === account?.sub)
        .map(() => ({ ...party, boss: bossDetails(party.bossId) }))
    ));
    if (assignments.length) characterPartyAssignments.set(character.ocid, assignments);
    const assignedBossIds = new Set(assignments.map(({ boss }) => boss.bossId));
    const solo = recommendationsForCharacter(character, characterMultipliers, { includeSolo: true })
      .filter((boss) => boss.recommendedPartySize === 1 && !assignedBossIds.has(boss.bossId));
    if (solo.length) soloRecommendations.set(character.ocid, solo);
    const missing = recommendationsForCharacter(character, characterMultipliers)
      .filter((boss) => boss.recommendedPartySize > 1 && !assignments.some(({ boss: assignedBoss }) => (
        assignedBoss.bossId === boss.bossId
      )));
    if (missing.length) unassignedRecommendations.set(character.ocid, missing);
  }
  const viewTitle = view === 'characters'
    ? '내 캐릭터'
    : view === 'settings'
      ? '계정 설정'
    : view === 'bosses'
      ? '그룹 설정'
      : view === 'members'
        ? '그룹 인원'
      : selectedGroup?.name || '그룹';
  const mapleScouterButtonLabel = busy === 'maplescouter-check'
    ? '확장 확인 중...'
    : busy === 'maplescouter-refresh'
      ? `갱신 중 ${mapleScouterProgress?.current || 0}/${mapleScouterProgress?.total || activeCharacters.length} · ${mapleScouterProgress?.nickname || ''}`
      : `실사용 ${activeCharacters.length}명 전체 갱신`;
  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  const groupBossQuickMenu = selectedGroup && (
    <aside className={`group-boss-quick-menu ${bossQuickMenuCollapsed ? 'collapsed' : ''}`} aria-label="보스 빠른 편성">
      <header>
        <div className="group-quick-menu-heading">
          <div>
            <p className="eyebrow">PARTY QUICK MENU</p>
            <h2>보스 빠른 편성</h2>
            <p className="group-boss-quick-group">{selectedGroup.name}</p>
            <p>난이도를 누르면 빈 파티가 추가됩니다.</p>
          </div>
          <button
            className="sidebar-edge-toggle"
            type="button"
            aria-label={`보스 빠른 메뉴 ${bossQuickMenuCollapsed ? '펼치기' : '접기'}`}
            aria-expanded={!bossQuickMenuCollapsed}
            title={`보스 빠른 메뉴 ${bossQuickMenuCollapsed ? '펼치기' : '접기'}`}
            onClick={() => setBossQuickMenuCollapsed((collapsed) => !collapsed)}
          >
            <svg
              className="sidebar-edge-chevron"
              data-direction={bossQuickMenuCollapsed ? 'right' : 'left'}
              aria-hidden="true"
              viewBox="0 0 24 24"
            >
              <path d={bossQuickMenuCollapsed ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'} />
            </svg>
          </button>
        </div>
      </header>
      <div className="group-boss-family-list">
        {groupBossFamilies.map((family) => {
          const representative = family.bosses.at(-1);
          const icon = bossImageFor(representative.bossId);
          const familyParties = currentGroupParties.filter(({ familyId, bossId }) => (
            (familyId || bossDetails(bossId).familyId) === family.familyId
          ));
          return (
            <article className="group-boss-family-option" key={family.familyId}>
              {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder">◇</span>}
              <strong>{family.name}</strong>
              <div className="group-boss-difficulty-buttons" aria-label={`${family.name} 난이도`}>
                {family.bosses.slice().sort(compareBossDifficulty).map((boss) => {
                  const partiesForBoss = familyParties.filter(({ bossId }) => bossId === boss.bossId);
                  return (
                    <button
                      className={`group-boss-difficulty difficulty-${boss.difficulty} ${quickPartyBossId === boss.bossId ? 'selected' : ''}`}
                      type="button"
                      disabled={busy === 'party-save'}
                      key={boss.bossId}
                      aria-pressed={quickPartyBossId === boss.bossId}
                      aria-label={`${boss.difficultyLabel} ${boss.name} 파티 편성${selectedQuickRecommendedBossIds.has(boss.bossId) ? ', 추천 보스' : ''}${partiesForBoss.length ? `, 파티 ${partiesForBoss.length}개` : ''}`}
                      title={`${boss.difficultyLabel} ${boss.name}${selectedQuickRecommendedBossIds.has(boss.bossId) ? ' · 선택 캐릭터 추천 보스' : ''}${partiesForBoss.length ? ` · 파티 ${partiesForBoss.length}개` : ''}`}
                      onClick={() => createEmptyBossParty(boss)}
                    >
                      {difficultyMarks[boss.difficulty] || boss.difficultyLabel.slice(0, 1)}
                      {selectedQuickRecommendedBossIds.has(boss.bossId) && <i className="difficulty-star" aria-hidden="true">★</i>}
                      {partiesForBoss.length > 0 && <small>{partiesForBoss.length}</small>}
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      <nav className="group-boss-quick-navigation" aria-label="그룹 관리">
        <button type="button" aria-label="인원 관리" title={`인원 관리 · ${groupMembers.length}`} onClick={openGroupMembers}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span>{groupMembers.length}</span>
        </button>
        <button type="button" aria-label="그룹 설정" title="그룹 설정" onClick={() => setView('bosses')}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
            <path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z" />
          </svg>
        </button>
      </nav>
    </aside>
  );
  const renderQuickCharacterCard = (character) => {
    const canManage = character.ownerSub === account?.sub || selectedGroup.role === 'admin';
    const isAssigned = Boolean(character.assignedParty);
    const sameAccountCharacterAssigned = !isAssigned && character.sameAccountCharacterAssigned;
    const characterKey = `${character.ownerSub}:${character.ocid}`;
    const isSelectedForHighlights = selectedQuickCharacterKey === characterKey;
    const isWarningPopupOpen = partyWarningPopup?.characterKey === characterKey;
    return (
      <article
        className={`group-character-quick-card ${character.missingPartyRecommendations.length ? 'has-missing-recommendations' : ''} ${isAssigned ? 'already-assigned' : ''} ${sameAccountCharacterAssigned ? 'blocked-by-account' : ''} ${isSelectedForHighlights ? 'selected-for-boss-highlights' : ''}`}
        key={characterKey}
        draggable={canManage && !isAssigned && !sameAccountCharacterAssigned}
        tabIndex={0}
        title={isSelectedForHighlights ? '선택됨 · 왼쪽에 추천 보스 표시 중' : '선택하여 왼쪽에 추천 보스 표시'}
        onClick={() => setSelectedQuickCharacterKey((current) => current === characterKey ? '' : characterKey)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          setSelectedQuickCharacterKey((current) => current === characterKey ? '' : characterKey);
        }}
        onDragStart={(event) => startPartyMemberDrag(event, character)}
        onDragEnd={finishPartyMemberDrag}
      >
        {character.missingPartyRecommendations.length > 0 && (
          <button
            className="group-party-warning-trigger"
            type="button"
            aria-label={`${character.nickname} 그룹 파티 편성 필요 안내`}
            aria-expanded={isWarningPopupOpen}
            title="그룹 파티 편성 필요"
            onClick={(event) => {
              event.stopPropagation();
              if (isWarningPopupOpen) {
                setPartyWarningPopup(null);
                return;
              }
              const popupWidth = Math.min(260, window.innerWidth - 16);
              const popupHeight = Math.min(300, window.innerHeight - 16);
              setPartyWarningPopup({
                characterKey,
                left: Math.max(8, Math.min(event.clientX + 8, window.innerWidth - popupWidth - 8)),
                top: Math.max(8, Math.min(event.clientY + 8, window.innerHeight - popupHeight - 8)),
              });
            }}
          >⚠</button>
        )}
        <div className="group-character-quick-profile">
          <span className="group-character-quick-avatar">
            {character.image
              ? <img src={character.image} alt={`${character.nickname} 캐릭터`} />
              : <span className="group-character-quick-fallback">{character.nickname.slice(0, 1)}</span>}
          </span>
          <span className="group-character-quick-details">
            <strong>{character.nickname}</strong>
            <small>Lv. {character.level || '-'}</small>
            {selectedQuickPartyBoss && <b>{character.quickMultiplier.toFixed(1)}%</b>}
          </span>
          {(character.quickRecommendation || isAssigned || sameAccountCharacterAssigned) && (
            <span className="group-character-quick-statuses">
              {character.quickRecommendation && (
                <strong className={`group-character-quick-recommendation ${character.quickRecommendation.recommendedPartySize ? `party-size-${character.quickRecommendation.recommendedPartySize}` : 'impossible'}`}>
                  {character.quickRecommendation.recommendedPartySize
                    ? recommendationPartyLabel(character.quickRecommendation.recommendedPartySize)
                    : '불가능'}
                </strong>
              )}
              {(isAssigned || sameAccountCharacterAssigned) && (
                <em className="group-character-quick-assignment-note">편성됨</em>
              )}
            </span>
          )}
        </div>
      </article>
    );
  };
  const groupCharacterQuickMenu = selectedGroup && (
    <aside className={`group-character-quick-menu ${characterQuickMenuCollapsed ? 'collapsed' : ''}`} aria-label="그룹 캐릭터 빠른 편성">
      <header>
        <div className="group-quick-menu-heading">
          <div>
            <p className="eyebrow">CHARACTER QUICK MENU</p>
            <h2>{selectedQuickPartyBoss ? `${selectedQuickPartyBoss.name} 배율순` : '그룹 캐릭터'}</h2>
            <p>{selectedQuickPartyBoss ? '파티 카드로 드래그해 편성하고, 퀵메뉴나 빈 공간에 놓아 제외하세요.' : '보스 난이도를 선택하면 해당 배율이 표시됩니다.'}</p>
          </div>
          <button
            className="sidebar-edge-toggle"
            type="button"
            aria-label={`캐릭터 빠른 메뉴 ${characterQuickMenuCollapsed ? '펼치기' : '접기'}`}
            aria-expanded={!characterQuickMenuCollapsed}
            title={`캐릭터 빠른 메뉴 ${characterQuickMenuCollapsed ? '펼치기' : '접기'}`}
            onClick={() => setCharacterQuickMenuCollapsed((collapsed) => !collapsed)}
          >
            <svg
              className="sidebar-edge-chevron"
              data-direction={characterQuickMenuCollapsed ? 'left' : 'right'}
              aria-hidden="true"
              viewBox="0 0 24 24"
            >
              <path d={characterQuickMenuCollapsed ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
            </svg>
          </button>
        </div>
        {selectedQuickPartyBoss && (
          <div className="group-character-quick-filters">
            <button
              className={quickRecommendedOnly ? 'active' : ''}
              type="button"
              aria-pressed={quickRecommendedOnly}
              onClick={() => setQuickRecommendedOnly((value) => !value)}
            >
              파티 추천만 (미편성)
            </button>
            <button
              className={quickIncludeFullMultiplier ? 'active' : ''}
              type="button"
              aria-pressed={quickIncludeFullMultiplier}
              disabled={!quickRecommendedOnly}
              title="추천 보기를 켠 상태에서 100% 이상 배율 캐릭터도 표시"
              onClick={() => setQuickIncludeFullMultiplier((value) => !value)}
            >
              100% 이상도 보기
            </button>
          </div>
        )}
      </header>
      <div className="group-character-quick-list">
        {quickPartyCharacterGroups.map(({ key, ownerName, characters: ownerCharacters }) => (
          <section className="group-character-owner-group" key={key} aria-label={`${ownerName} 캐릭터`}>
            <h3>{ownerName}</h3>
            <div className="group-character-owner-grid">
              {ownerCharacters.map(renderQuickCharacterCard)}
            </div>
          </section>
        ))}
        {!quickPartyCandidates.length && (
          <div className="empty-state compact">
            <strong>{groupCharacters.length ? '표시할 캐릭터가 없습니다' : '그룹에 참여된 캐릭터가 없습니다'}</strong>
            <p>{selectedQuickPartyBoss ? '이 보스에 편성할 수 있는 캐릭터가 없습니다.' : '그룹에 참여된 캐릭터가 여기에 표시됩니다.'}</p>
          </div>
        )}
      </div>
    </aside>
  );
  const partyWarningCharacter = partyWarningPopup
    ? quickPartyCandidates.find((character) => `${character.ownerSub}:${character.ocid}` === partyWarningPopup.characterKey)
    : null;
  const partyWarningPopupElement = partyWarningCharacter && partyWarningPopup && (
    <div
      className="unassigned-party-warning group-character-quick-missing group-party-warning-popup"
      role="dialog"
      aria-label={`${partyWarningCharacter.nickname} 그룹 파티 편성 필요`}
      style={{ left: `${partyWarningPopup.left}px`, top: `${partyWarningPopup.top}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <strong><span aria-hidden="true">⚠</span> 그룹 파티 편성 필요</strong>
      {partyWarningCharacter.missingPartyRecommendations.map((boss) => (
        <div key={boss.bossId}>
          <button
            className="group-character-quick-missing-boss"
            type="button"
            aria-label={`${boss.difficultyLabel} ${boss.name} 그룹 파티 추가`}
            onClick={(event) => {
              event.stopPropagation();
              createEmptyBossParty(boss, partyWarningCharacter);
              setPartyWarningPopup(null);
            }}
          >
            <span className="unassigned-party-boss">
              {bossImageFor(boss.bossId)
                ? <img src={bossImageFor(boss.bossId)} alt="" />
                : <span className="boss-placeholder" aria-hidden="true">◇</span>}
              <span>
                <strong>{boss.difficultyLabel} {boss.name}</strong>
                <small>{recommendationPartyLabel(boss.recommendedPartySize)} · 배율 {boss.multiplier.toFixed(1)}%</small>
              </span>
            </span>
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div
      className={`app-shell ${draggedPartyCharacter && ['group', 'bosses'].includes(view) ? 'party-character-drag-active' : ''}`}
      data-theme={theme}
      onDragOver={handleGroupCanvasDragOver}
      onDrop={dropPartyCharacterOnEmptySpace}
    >
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
              className={`rail-button ${['group', 'members', 'bosses'].includes(view) && selectedGroupId === group.id ? 'active' : ''}`}
              type="button"
              title={group.name}
              key={group.id}
              onClick={() => selectGroup(group.id)}
            >
              <span className="rail-avatar group-avatar">
                {group.mainImageBossId && bossImageFor(group.mainImageBossId)
                  ? <img src={bossImageFor(group.mainImageBossId)} alt="" />
                  : group.name.slice(0, 1)}
              </span>
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
            <span className="rail-avatar settings-avatar" aria-hidden="true">⚙</span>
            <span className="rail-tooltip">계정 설정</span>
          </button>
        ) : (
          <span className="rail-brand" aria-label="Maple Scout">M</span>
        )}
      </aside>

      {view === 'group' && selectedGroup && groupBossQuickMenu}

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
          </div>

          {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
          {showExtensionInstallHelp && (view === 'characters' || view === 'settings') && (
            <section className="extension-install-help" role="alert" aria-labelledby="extension-install-title">
              <div className="extension-install-heading">
                <h2 id="extension-install-title">MemoFam Reader 설치</h2>
                <button className="quiet-button" type="button" aria-label="설치 안내 닫기" onClick={() => setShowExtensionInstallHelp(false)}>×</button>
              </div>
              <p>Chrome Web Store 등록 없이 ZIP 파일로 설치할 수 있습니다.</p>
              <div className="extension-install-actions">
                <a className="outline-button extension-download" href="/memofam-maplescouter-reader.zip" download>
                  MemoFam Reader 다운로드
                </a>
                <button
                  className="outline-button extension-open-settings"
                  type="button"
                  onClick={openChromeExtensionSettings}
                >
                  Chrome 확장 프로그램 열기
                </button>
              </div>
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
                <input type="checkbox" aria-label="로그인 유지" checked={rememberLogin} onChange={changeRememberLogin} />
                <span>이 기기에서 로그인 유지 (30일간 미사용 시 만료)</span>
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
                    <form className="sync-form" onSubmit={importCharactersAndSyncMultipliers}>
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
                      <button className="primary-button" type="submit" disabled={busy === 'sync' || busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}>
                        {busy === 'maplescouter-check' ? '확장 확인 중...' : busy === 'sync' ? '캐릭터 불러오는 중...' : busy === 'maplescouter-refresh' ? '배율 동기화 중...' : '캐릭터 불러오기'}
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
                      <div className="section-heading-spacer" aria-hidden="true" />
                      <div className="character-tools">
                        <button
                          className={`outline-button character-score-refresh ${busy === 'maplescouter-refresh' ? 'refreshing' : ''}`}
                          type="button"
                          onClick={() => refreshMapleScouterData()}
                          disabled={!activeCharacters.length || busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}
                          aria-label={mapleScouterButtonLabel}
                          title={mapleScouterButtonLabel}
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="M20 7v5h-5M4 17v-5h5" />
                            <path d="M5.7 9A7 7 0 0 1 18 6.2L20 12M4 12l2 5.8A7 7 0 0 0 18.3 15" />
                          </svg>
                          <span>{busy === 'maplescouter-refresh' ? '동기화 중' : '배율 동기화'}</span>
                        </button>
                      </div>
                    </div>
                    {activeCharacters.length > 0 && (
                      <div className="character-filter-bar">
                        <label>
                          <span>월드</span>
                          <select aria-label="월드 필터" value={characterWorldFilter} onChange={(event) => setCharacterWorldFilter(event.target.value)}>
                            <option value="">전체 월드</option>
                            {activeCharacterWorlds.map((worldName) => <option key={worldName} value={worldName}>{worldName}</option>)}
                          </select>
                        </label>
                        {characterWorldFilter && (
                          <button className="quiet-button" type="button" onClick={() => setCharacterWorldFilter('')}>
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
                              const missingRecommendations = unassignedRecommendations.get(character.ocid) || [];
                              const assignedParties = characterPartyAssignments.get(character.ocid) || [];
                              const characterSoloRecommendations = soloRecommendations.get(character.ocid) || [];
                              const characterMultipliers = accountMultipliers.filter((entry) => (
                                entry.nickname?.toLocaleLowerCase('ko') === character.nickname.toLocaleLowerCase('ko')
                              ));
                              const groupCharacter = groupCharacters.find(({ ocid }) => ocid === character.ocid);
                              const canDragToParty = groupCharacter
                                && (groupCharacter.ownerSub === account?.sub || selectedGroup?.role === 'admin');
                              return (
                                <div className="character-card-wrap" key={character.ocid}>
                                  <button
                                    className={`character-card ${selectedCharacterId === character.ocid ? 'selected' : ''}`}
                                    type="button"
                                    draggable={Boolean(canDragToParty)}
                                    onDragStart={(event) => canDragToParty && startPartyMemberDrag(event, groupCharacter)}
                                    onDragEnd={finishPartyMemberDrag}
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
                                  </button>
                                  <div className="character-card-side-info">
                                    <div className="character-party-column" aria-label={`${character.nickname} 파티 보스`}>
                                    {assignedParties.length > 0 && (
                                      <div className="character-party-links" aria-label={`${character.nickname} 편성된 그룹 파티`}>
                                        {assignedParties.map((party) => {
                                          const boss = bossDetails(party.bossId);
                                          const recommendation = bossRecommendationForCharacter(
                                            character,
                                            characterMultipliers,
                                            boss,
                                          );
                                          const partyRecommendation = recommendation.recommendedPartySize
                                            ? `${recommendationPartyLabel(recommendation.recommendedPartySize)}`
                                            : '불가능';
                                          const multiplierLabel = recommendation.multiplier === null
                                            ? '배율 미기록'
                                            : `${recommendation.multiplier.toFixed(1)}%`;
                                          const clearStatus = characterBossClearStatus(character, boss);
                                          return (
                                            <button
                                              className="character-party-link"
                                              type="button"
                                              key={`${party.groupId}:${party.partyId}`}
                                              onClick={() => openPartyGroup(party.groupId, party.partyId)}
                                            >
                                              <span className="character-party-link-title">
                                                {bossImageFor(boss.bossId) && <img src={bossImageFor(boss.bossId)} alt="" />}
                                                {party.groupName} · {boss.difficultyLabel} {boss.name}
                                              </span>
                                              <span className="character-party-link-details">
                                                <span>{multiplierLabel}</span>
                                                <span>{partyRecommendation}</span>
                                                <span className={`character-recommendation-clear ${clearStatus === '클리어' ? 'cleared' : 'not-cleared'}`}>
                                                  {clearStatus}
                                                </span>
                                              </span>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}
                                    {missingRecommendations.length > 0 && (
                                      <div className="unassigned-party-warning" role="status">
                                        <strong><span aria-hidden="true">⚠</span> 그룹 파티 편성 필요</strong>
                                        {missingRecommendations.map((boss) => (
                                          <div key={boss.bossId}>
                                            <span className="unassigned-party-boss">
                                              {bossImageFor(boss.bossId)
                                                ? <img src={bossImageFor(boss.bossId)} alt="" />
                                                : <span className="boss-placeholder" aria-hidden="true">◇</span>}
                                              <span>
                                                <strong>{boss.difficultyLabel} {boss.name}</strong>
                                                <small>{recommendationPartyLabel(boss.recommendedPartySize)} · 배율 {boss.multiplier.toFixed(1)}%</small>
                                              </span>
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {!assignedParties.length && !missingRecommendations.length && (
                                      <div className="character-recommendation-empty">편성된 파티 보스 없음</div>
                                    )}
                                    </div>
                                    <div className="character-solo-column" aria-label={`${character.nickname} 솔플 보스`}>
                                    {characterSoloRecommendations.length > 0 ? (
                                      <div className="character-solo-recommendations">
                                        <strong className="character-solo-recommendations-heading">솔플 추천</strong>
                                        {characterSoloRecommendations.map((boss) => {
                                          const clearStatus = characterBossClearStatus(character, boss);
                                          const multiplierLabel = boss.multiplier === null
                                            ? '배율 미기록'
                                            : `${boss.multiplier.toFixed(1)}%`;
                                          return (
                                            <div
                                              className="character-solo-recommendation"
                                              data-boss-id={boss.bossId}
                                              key={boss.bossId}
                                            >
                                              <span className="character-solo-recommendation-title">
                                                {bossImageFor(boss.bossId)
                                                  ? <img src={bossImageFor(boss.bossId)} alt="" loading="lazy" />
                                                  : <span className="boss-placeholder" aria-hidden="true">◇</span>}
                                                <strong>{boss.difficultyLabel} {boss.name}</strong>
                                              </span>
                                              <span className="character-solo-recommendation-details">
                                                <span>{multiplierLabel}</span>
                                                <span className={`character-recommendation-clear ${clearStatus === '클리어' ? 'cleared' : 'not-cleared'}`}>
                                                  {clearStatus}
                                                </span>
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <div className="character-recommendation-empty">솔플 추천 보스 없음</div>
                                    )}
                                    </div>
                                  </div>
                                </div>
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
                      <section id="group-party-builder" className="panel-section group-quick-party-builder">
                        <div className="section-heading">
                          <div><p className="eyebrow">PARTY BUILDER</p><h2>파티 빠른 편성</h2></div>
                          <span className="updated-count">{currentGroupParties.length} 파티</span>
                        </div>
                        <p className="group-boss-picker-hint">
                          보스 난이도를 선택하면 빈 파티가 바로 추가됩니다. 파티 카드를 누르면 편성 후보를 열 수 있습니다.
                        </p>
                        <section className="group-main-party-overview" aria-label="편성된 파티">
                          <div className="group-main-party-overview-heading">
                            <h3>편성된 파티</h3>
                            <div>
                              <span>{currentGroupParties.length}개</span>
                              <button
                                className={`outline-button group-party-schedule-refresh ${busy === 'maplescouter-refresh' ? 'refreshing' : ''}`}
                                type="button"
                                onClick={refreshGroupPartySchedules}
                                disabled={busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}
                                aria-label="내 캐릭터 배율 및 스케줄 동기화"
                                title="배율과 내 계정 캐릭터 스케줄을 함께 동기화"
                              >
                                <svg aria-hidden="true" viewBox="0 0 24 24">
                                  <path d="M20 7v5h-5M4 17v-5h5" />
                                  <path d="M5.7 9A7 7 0 0 1 18 6.2L20 12M4 12l2 5.8A7 7 0 0 0 18.3 15" />
                                </svg>
                                <span>{busy === 'maplescouter-check' || busy === 'maplescouter-refresh' ? '동기화 중' : '배율 동기화'}</span>
                              </button>
                              {partyDraft?.groupId === selectedGroupId && (
                                <>
                                  <button className="outline-button" type="button" onClick={discardPartyDraft} disabled={busy === 'party-save'}>
                                    변경 취소
                                  </button>
                                  <button className="primary-button" type="button" onClick={() => savePartyDraft()} disabled={busy === 'party-save'}>
                                    {busy === 'party-save' ? '저장 중...' : '완료 · 변경 저장'}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="party-overview-controls">
                            <div className="party-overview-toolbar">
                              <label className="party-overview-search">
                                <span className="sr-only">보스 또는 캐릭터 검색</span>
                                <input
                                  type="search"
                                  value={partyOverviewSearch}
                                  onChange={(event) => setPartyOverviewSearch(event.target.value)}
                                  placeholder="보스·캐릭터 검색"
                                />
                              </label>
                              <label className="party-overview-sort">
                                <span>정렬</span>
                                <select value={partyOverviewSort} onChange={(event) => setPartyOverviewSort(event.target.value)}>
                                  <option value="default">기본 순서</option>
                                  <option value="multiplier-asc">배율 낮은 순</option>
                                  <option value="members-asc">인원 적은 순</option>
                                  <option value="boss-name">보스 이름 순</option>
                                </select>
                              </label>
                              <span className="party-overview-result-count" aria-live="polite">
                                {visiblePartyEntries.length} / {partyOverviewEntries.length} 파티
                              </span>
                            </div>
                            <div className="party-overview-filters" role="group" aria-label="파티 필터">
                              <button
                                className={partyOverviewFilters.mine ? 'active' : ''}
                                type="button"
                                aria-pressed={partyOverviewFilters.mine}
                                onClick={() => setPartyOverviewFilters((current) => ({ ...current, mine: !current.mine }))}
                              >내 캐릭터 파티</button>
                              <button
                                className={partyOverviewFilters.empty ? 'active' : ''}
                                type="button"
                                aria-pressed={partyOverviewFilters.empty}
                                onClick={() => setPartyOverviewFilters((current) => ({ ...current, empty: !current.empty }))}
                              >빈 파티</button>
                              <button
                                className={partyOverviewFilters.belowTarget ? 'active' : ''}
                                type="button"
                                aria-pressed={partyOverviewFilters.belowTarget}
                                onClick={() => setPartyOverviewFilters((current) => ({ ...current, belowTarget: !current.belowTarget }))}
                              >배율 100% 미달</button>
                              <button
                                className={partyOverviewFilters.uncleared ? 'active uncleared-only' : ''}
                                type="button"
                                aria-pressed={partyOverviewFilters.uncleared}
                                onClick={() => setPartyOverviewFilters((current) => ({ ...current, uncleared: !current.uncleared }))}
                              >미클 파티만 보기</button>
                              {hasActivePartyOverviewFilters && (
                                <button
                                  className="party-overview-reset"
                                  type="button"
                                  onClick={() => {
                                    setPartyOverviewSearch('');
                                    setPartyOverviewSort('default');
                                    setPartyOverviewFilters({ mine: false, empty: false, belowTarget: false, uncleared: false });
                                  }}
                                >초기화</button>
                              )}
                              {partyOverviewFilters.mine && partyOverviewFilters.empty && (
                                <span className="party-overview-filter-hint">내 캐릭터 파티와 빈 파티를 함께 표시합니다.</span>
                              )}
                            </div>
                          </div>
                          {currentGroupParties.length ? (
                            visiblePartyEntries.length ? (
                              <div className="group-main-party-grid">
                              {visiblePartyEntries.map(({ party, config, summary, members }) => {
                                const sameBossPartyNumber = currentGroupParties
                                  .filter(({ bossId }) => bossId === party.bossId)
                                  .findIndex(({ partyId }) => partyId === party.partyId) + 1;
                                const isSelectedParty = quickPartyBossId && focusedPartyId === party.partyId;
                                const canDeleteParty = selectedGroup.role === 'admin'
                                  || members.every(({ ownerSub }) => ownerSub === account?.sub);
                                return (
                                  <article
                                    className={`group-main-party-card ${summary.cleared ? 'boss-cleared' : 'boss-not-cleared'} ${focusedPartyId === party.partyId ? 'focused' : ''} ${isSelectedParty ? 'selected-party' : ''} ${quickPartyBossId && !isSelectedParty ? 'unselected-party' : ''} ${dragOverPartyId === party.partyId ? 'drag-over' : ''}`}
                                    id={`group-party-${party.partyId}`}
                                    key={party.partyId}
                                    onClick={(event) => {
                                      if (event.target.closest('button')) return;
                                      focusQuickParty(party);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
                                      event.preventDefault();
                                      focusQuickParty(party);
                                    }}
                                    tabIndex={0}
                                    onDragOver={(event) => dragOverParty(event, party)}
                                    onDragLeave={(event) => {
                                      if (!event.currentTarget.contains(event.relatedTarget)) setDragOverPartyId('');
                                    }}
                                    onDrop={(event) => dropCharacterOnParty(event, party)}
                                  >
                                    {isSelectedParty && <span className="group-main-party-selected-badge">✓ 편성 중</span>}
                                    <header>
                                      {bossImageFor(party.bossId)
                                        ? <img src={bossImageFor(party.bossId)} alt="" />
                                        : <span className="boss-placeholder">◇</span>}
                                      <span className="group-main-party-title">
                                        <small
                                          className={`party-difficulty-mark difficulty-${config.difficulty}`}
                                          title={config.difficultyLabel}
                                          aria-label={`${config.difficultyLabel} 난이도`}
                                        >
                                          {difficultyMarks[config.difficulty] || '?'}
                                        </small>
                                        <strong>{config.name}</strong>
                                      </span>
                                      <b>{members.length}/{config.maxPartySize}인</b>
                                      <span
                                        className={`party-clear-status ${summary.cleared ? 'cleared' : 'not-cleared'}`}
                                        title={summary.clearRecordAvailable
                                          ? '그룹 파티원의 해당 보스 완료 기록 기준'
                                          : '파티 멤버에게 이 보스의 완료 기록이 없습니다.'}
                                      >
                                        {summary.statusLabel}
                                      </span>
                                      {canDeleteParty && (
                                        <button
                                          className="party-remove-button"
                                          type="button"
                                          aria-label={`${config.difficultyLabel} ${config.name} ${sameBossPartyNumber}번째 파티 ${isSelectedParty ? '편성 닫기' : '삭제'}`}
                                          title={isSelectedParty ? '파티 편성 닫기' : '파티 삭제'}
                                          onClick={() => requestPartyRemoval(party)}
                                        >×</button>
                                      )}
                                    </header>
                                    <div className="group-main-party-members">
                                      {members.length ? members.map((member) => {
                                        const canManageMember = member.ownerSub === account?.sub || selectedGroup.role === 'admin';
                                        return (
                                          <span
                                            className={`party-overview-member ${member.ownerSub === account?.sub ? 'own' : ''}`}
                                            key={`${member.ownerSub}:${member.ocid}`}
                                            title={`${member.nickname} · ${Number(member.multiplier || 0).toFixed(1)}%`}
                                            draggable={canManageMember}
                                            onDragStart={(event) => startPartyMemberDrag(event, member, party)}
                                            onDragEnd={finishPartyMemberDrag}
                                          >
                                            <span>{member.nickname}</span>
                                            <small>{Number(member.multiplier || 0).toFixed(1)}%</small>
                                            {canManageMember && (
                                              <button
                                                type="button"
                                                aria-label={`${member.nickname} 파티 편성 제외`}
                                                title="파티 편성에서 제외"
                                                onClick={(event) => {
                                                  event.stopPropagation();
                                                  removePartyMemberDraft(member, party.partyId);
                                                }}
                                              >×</button>
                                            )}
                                          </span>
                                        );
                                      }) : (
                                        <span className="group-main-party-empty">빈 파티 · 캐릭터를 끌어 놓아 추가</span>
                                      )}
                                    </div>
                                    <div className={`party-summary ${summary.ready ? 'ready' : ''} ${summary.cleared ? 'cleared' : ''}`}>
                                      <span>총 <strong>{summary.totalMultiplier.toFixed(1)}%</strong></span>
                                      <div
                                        className="party-multiplier-progress"
                                        role="progressbar"
                                        aria-label={`${config.name} 파티 배율`}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.min(100, Math.max(0, summary.totalMultiplier))}
                                      >
                                        <span style={{ width: `${Math.min(100, Math.max(0, summary.totalMultiplier))}%` }} />
                                      </div>
                                      <span>{summary.cleared
                                        ? '클리어'
                                        : summary.ready
                                          ? '클리어 가능'
                                          : `${Math.max(0, 100 - summary.totalMultiplier).toFixed(1)}% 부족`}</span>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                            ) : (
                              <div className="party-overview-no-results">
                                <span>조건에 맞는 파티가 없습니다.</span>
                                <button
                                  className="outline-button"
                                  type="button"
                                  onClick={() => {
                                    setPartyOverviewSearch('');
                                    setPartyOverviewSort('default');
                                    setPartyOverviewFilters({ mine: false, empty: false, belowTarget: false, uncleared: false });
                                  }}
                                >필터 초기화</button>
                              </div>
                            )
                          ) : (
                            <p className="group-main-party-empty-state">아직 편성된 파티가 없습니다. 위에서 보스 난이도를 선택해 파티를 만들어 보세요.</p>
                          )}
                        </section>
                        {partyRemovalConfirmationId && (() => {
                          const partyToRemove = currentGroupParties.find(({ partyId }) => partyId === partyRemovalConfirmationId);
                          if (!partyToRemove) return null;
                          const partyToRemoveDetails = bossDetails(partyToRemove.bossId);
                          const partyNumber = currentGroupParties
                            .filter(({ bossId }) => bossId === partyToRemove.bossId)
                            .findIndex(({ partyId }) => partyId === partyToRemove.partyId) + 1;
                          return (
                            <div className="party-removal-backdrop">
                              <section
                                className="party-removal-dialog"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="party-removal-title"
                              >
                                <span className="party-removal-icon" aria-hidden="true">!</span>
                                <h3 id="party-removal-title">파티를 삭제할까요?</h3>
                                <p>{partyToRemoveDetails.difficultyLabel} {partyToRemoveDetails.name} {partyNumber}번째 파티와 파티 편성이 삭제됩니다. 이 변경은 저장 전까지 취소할 수 있습니다.</p>
                                <div>
                                  <button
                                    className="outline-button"
                                    type="button"
                                    onClick={() => setPartyRemovalConfirmationId('')}
                                  >취소</button>
                                  <button className="logout-danger-button" type="button" onClick={confirmPartyRemoval}>파티 삭제</button>
                                </div>
                              </section>
                            </div>
                          );
                        })()}
                        {selectedQuickPartyBoss && (
                          <section className="group-quick-party-editor" aria-label={`${selectedQuickPartyBoss.name} 파티 편성 후보`}>
                            <header className="group-quick-party-editor-heading">
                              <div>
                                <p className="eyebrow">PARTY BUILDER · {selectedQuickPartyBoss.difficultyLabel}</p>
                                <h3>{selectedQuickPartyBoss.name} 파티 편성</h3>
                                <p>대상: {focusedQuickPartyNumber ? `${focusedQuickPartyNumber}번째 파티` : '파티를 선택하세요'} · 클리어 기준은 파티 합산 배율 100%입니다.</p>
                              </div>
                              {bossImageFor(selectedQuickPartyBoss.bossId) && (
                                <img src={bossImageFor(selectedQuickPartyBoss.bossId)} alt="" />
                              )}
                              <button className="outline-button" type="button" onClick={() => setQuickPartyBossId('')}>닫기</button>
                            </header>
                          </section>
                        )}
                      </section>
                    </>
                  )}
                </section>
              )}

              {view === 'members' && (
                <section className="group-members-view">
                  {!selectedGroup ? (
                    <div className="empty-state">
                      <strong>관리할 그룹을 먼저 선택하세요</strong>
                      <p>왼쪽 그룹 아이콘에서 그룹을 선택하세요.</p>
                    </div>
                  ) : (
                    <>
                      <section className="group-management-header">
                        <div>
                          <p className="eyebrow">GROUP MEMBERS</p>
                          <h2>{selectedGroup.name} 인원 관리</h2>
                          <p>그룹 참여 인원, 권한, 캐릭터 수를 확인하고 관리합니다.</p>
                        </div>
                        <button className="outline-button" type="button" onClick={() => setView('group')}>← 그룹 메인으로</button>
                      </section>

                      <section className="group-members-panel panel-section">
                        <div className="group-members-toolbar">
                          <div>
                            <p className="eyebrow">MEMBERS</p>
                            <h2>참여 인원 <span>{groupMembers.length}</span></h2>
                          </div>
                          {selectedGroup.role === 'admin' && (
                            <button className="primary-button" type="button" onClick={createGroupInvite} disabled={busy === 'invite'}>
                              {busy === 'invite' ? '초대 링크 생성 중...' : '＋ 초대 링크 만들기'}
                            </button>
                          )}
                        </div>
                        {inviteLink && (
                          <div className="invite-link-field">
                            <input aria-label="그룹 초대 링크" readOnly value={inviteLink} onFocus={(event) => event.target.select()} />
                          </div>
                        )}
                        {groupMembers.length ? (
                          <div className="group-member-list" role="list" aria-label={`${selectedGroup.name} 참여 인원`}>
                            {groupMembers.map((member) => {
                              const displayName = member.name?.trim() || member.email.split('@')[0];
                              const isSelf = member.email.toLocaleLowerCase('ko') === account?.email?.toLocaleLowerCase('ko');
                              return (
                                <article className="group-member-card" key={member.email} role="listitem">
                                  <span className="group-member-avatar" aria-hidden="true">{displayName.slice(0, 1).toLocaleUpperCase('ko')}</span>
                                  <div className="group-member-identity">
                                    <strong>{displayName}</strong>
                                    <span>{member.email}</span>
                                  </div>
                                  <div className="group-member-details">
                                    <span className={`group-member-role ${member.role === 'admin' ? 'admin' : ''}`}>
                                      {member.isOwner ? '그룹장' : member.role === 'admin' ? '관리자' : '멤버'}
                                    </span>
                                    {isSelf && <span className="group-member-self">내 계정</span>}
                                    <span>{member.characterCount} 캐릭터</span>
                                    <time dateTime={member.joinedAt}>
                                      {member.joinedAt ? `${new Date(member.joinedAt).toLocaleDateString('ko-KR')} 참여` : '참여 날짜 정보 없음'}
                                    </time>
                                  </div>
                                  {selectedGroup.role === 'admin' && !member.isOwner && !isSelf && (
                                    memberRemovalEmail === member.email ? (
                                      <div className="group-member-confirmation" role="alert">
                                        <span>이 인원의 그룹 캐릭터와 파티 편성도 함께 제거됩니다.</span>
                                        <button className="quiet-button" type="button" onClick={() => setMemberRemovalEmail('')}>취소</button>
                                        <button
                                          className="logout-danger-button"
                                          type="button"
                                          disabled={busy === 'group-member-remove'}
                                          onClick={() => removeMemberFromGroup(member.email)}
                                        >
                                          {busy === 'group-member-remove' ? '제거 중...' : '제거 확인'}
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        className="group-member-remove"
                                        type="button"
                                        disabled={busy === 'group-member-remove'}
                                        onClick={() => setMemberRemovalEmail(member.email)}
                                      >
                                        멤버 제거
                                      </button>
                                    )
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="empty-state compact">
                            <strong>그룹 인원 정보가 없습니다</strong>
                            <p>초대 링크를 만들어 새 멤버를 초대할 수 있습니다.</p>
                          </div>
                        )}
                        {selectedGroup.role !== 'admin' && (
                          <p className="group-members-note">멤버 초대와 제거는 그룹 관리자만 할 수 있습니다.</p>
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
                      <section className="group-management-header">
                        <div>
                          <p className="eyebrow">GROUP SETTINGS</p>
                          <h2>{selectedGroup.name}</h2>
                          <p>
                            {selectedGroup.role === 'admin' && '관리자 설정을 관리합니다. '}
                            사용 캐릭터는 그룹에 자동 참여하며, 여기서 제거하면 자동 재참여하지 않습니다. 원할 때 참여 버튼으로 다시 추가할 수 있습니다.
                          </p>
                        </div>
                        <button className="outline-button" type="button" onClick={() => setView('group')}>← 그룹 메인으로</button>
                      </section>

                      <section className="group-character-picker panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">GROUP CHARACTERS</p><h2>그룹 참여 캐릭터</h2></div>
                          <span className="updated-count">사용 또는 그룹 참여 캐릭터 {groupSettingsCharacters.length}명</span>
                        </div>
                        {groupSettingsCharacters.length ? (
                          <div className="group-add-character-grid">
                            {groupSettingsCharacters.map((character) => {
                              const alreadyAdded = groupCharacters.some((entry) => (
                                entry.ocid === character.ocid
                                && (!entry.ownerSub || entry.ownerSub === account?.sub)
                              ));
                              return (
                                <article className="group-add-character" key={character.ocid}>
                                  {character.image ? <img src={character.image} alt="" /> : <span className="boss-placeholder">◇</span>}
                                  <span><strong>{character.nickname}</strong><small>Lv. {character.level}</small></span>
                                  <button
                                    className={`outline-button ${alreadyAdded ? 'group-character-remove' : 'group-character-add'}`}
                                    type="button"
                                    onClick={() => alreadyAdded
                                      ? removeCharacterFromGroup(character.ocid)
                                      : addCharacterToGroup(character.ocid)}
                                  >
                                    {alreadyAdded ? '− 제거' : '＋ 참여'}
                                  </button>
                                </article>
                              );
                            })}
                          </div>
                        ) : <div className="empty-state compact"><strong>표시할 캐릭터가 없습니다</strong><p>계정 설정에서 사용할 캐릭터로 선택하거나 먼저 이 그룹에 참여시키세요.</p></div>}
                      </section>

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

                      {selectedGroup.role === 'admin' && (
                        <>
                          <section className="group-settings-card panel-section">
                            <div className="section-heading">
                              <div><p className="eyebrow">GROUP APPEARANCE</p><h2>그룹 대표 이미지</h2></div>
                            </div>
                            <div className="group-image-options" aria-label="그룹 대표 이미지 선택">
                              <button
                                className={`group-image-option ${!selectedGroup.mainImageBossId ? 'selected' : ''}`}
                                type="button"
                                disabled={busy === 'group-image'}
                                aria-pressed={!selectedGroup.mainImageBossId}
                                onClick={() => updateGroupImage(null)}
                              >
                                <span>{selectedGroup.name.slice(0, 1)}</span><small>기본</small>
                              </button>
                              {groupBossFamilies.map((family) => {
                                const imageBoss = family.bosses.at(-1);
                                const image = bossImageFor(imageBoss.bossId);
                                return (
                                  <button
                                    className={`group-image-option ${selectedGroup.mainImageBossId === imageBoss.bossId ? 'selected' : ''}`}
                                    type="button"
                                    key={family.familyId}
                                    disabled={busy === 'group-image'}
                                    aria-label={`${family.name} 아이콘으로 설정`}
                                    aria-pressed={selectedGroup.mainImageBossId === imageBoss.bossId}
                                    onClick={() => updateGroupImage(imageBoss.bossId)}
                                  >
                                    {image ? <img src={image} alt="" /> : <span>◇</span>}<small>{family.name}</small>
                                  </button>
                                );
                              })}
                            </div>
                            <p className="group-settings-note">현재 앱의 보스 아이콘 중 하나를 선택합니다. 이미지는 그룹 사이드바에 표시됩니다.</p>
                          </section>

                          <section className="group-danger-zone">
                            <div>
                              <p className="eyebrow">DANGER ZONE</p>
                              <h2>그룹 삭제</h2>
                              <p>그룹 파티와 참여 정보가 함께 삭제되며 복구할 수 없습니다.</p>
                            </div>
                            {!showGroupDeleteConfirmation ? (
                              <button
                                className="logout-danger-button"
                                type="button"
                                onClick={() => setShowGroupDeleteConfirmation(true)}
                              >그룹 삭제</button>
                            ) : (
                              <div className="group-delete-confirmation" role="alert">
                                <strong>“{selectedGroup.name}” 그룹을 정말 삭제할까요?</strong>
                                <button className="outline-button" type="button" onClick={() => setShowGroupDeleteConfirmation(false)}>취소</button>
                                <button
                                  className="logout-danger-button"
                                  type="button"
                                  disabled={busy === 'group-delete'}
                                  onClick={deleteSelectedGroup}
                                >{busy === 'group-delete' ? '삭제 중...' : '삭제 확인'}</button>
                              </div>
                            )}
                          </section>
                        </>
                      )}

                      {false && <section className="group-party-builder panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">PARTY BUILDER</p><h2>보스를 고르고 파티를 편성하세요</h2></div>
                          <span className="updated-count">그룹 캐릭터 {groupCharacters.length}명 · 추천은 자동 편성되지 않습니다</span>
                        </div>
                        <div className="party-builder-layout">
                          <aside className="party-boss-sidebar" aria-label="파티를 구성할 보스">
                            <h3>보스 선택</h3>
                            <div className="party-boss-list">
                              {groupBossFamilies.map((family) => {
                                const representative = family.bosses
                                  .slice()
                                  .sort((left, right) => right.changedPrice - left.changedPrice)[0];
                                const icon = bossImageFor(representative.bossId);
                                const partyCount = groupParties.filter(({ familyId, bossId }) => (
                                  (familyId || bossDetails(bossId).familyId) === family.familyId
                                )).length;
                                return (
                                  <button
                                    className={`party-boss-option ${selectedBossFamilyId === family.familyId ? 'selected' : ''}`}
                                    type="button"
                                    key={family.familyId}
                                    aria-pressed={selectedBossFamilyId === family.familyId}
                                    onClick={() => {
                                      setSelectedBossFamilyId(family.familyId);
                                      setSelectedBossDifficultyId('');
                                      setActiveBuilderPartyId('');
                                    }}
                                  >
                                    {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder">◇</span>}
                                    <span><strong>{family.name}</strong><small>최대 {family.maxPartySize}인 · 파티 {partyCount}개</small></span>
                                  </button>
                                );
                              })}
                            </div>
                          </aside>

                          <div className="party-builder-workspace">
                            {selectedBossFamily ? (
                              <>
                                <div className="party-builder-boss-heading">
                                  <div>
                                    <p className="eyebrow">선택한 보스</p>
                                    <h3>{selectedBossFamily.name}</h3>
                                  </div>
                                  <span>이미 이 보스에 편성된 캐릭터는 후보에서 제외됩니다.</span>
                                </div>
                                <div className="party-difficulty-picker" aria-label={`${selectedBossFamily.name} 난이도 선택`}>
                                  {selectedBossOptions.map((boss) => (
                                    <button
                                      className={`schedule-boss-difficulty difficulty-${boss.difficulty} ${selectedBossDifficultyId === boss.bossId ? 'selected' : ''}`}
                                      type="button"
                                      key={boss.bossId}
                                      aria-pressed={selectedBossDifficultyId === boss.bossId}
                                      onClick={() => {
                                        setSelectedBossDifficultyId(boss.bossId);
                                        setActiveBuilderPartyId('');
                                      }}
                                      aria-label={`${boss.difficultyLabel} ${boss.name}`}
                                      title={boss.difficultyLabel}
                                    >
                                      {{ easy: 'E', normal: 'N', hard: 'H', extreme: 'E', chaos: 'C' }[boss.difficulty] || boss.difficultyLabel}
                                    </button>
                                  ))}
                                </div>

                                {selectedBossDetails ? (
                                  <section className="builder-parties" aria-label={`${selectedBossDetails.difficultyLabel} ${selectedBossDetails.name} 파티`}>
                                    <div className="builder-section-heading">
                                      <div>
                                        <h4>{selectedBossDetails.difficultyLabel} {selectedBossDetails.name} 파티</h4>
                                        <p>파티 카드를 선택한 뒤 캐릭터를 끌어 놓거나 카드의 편성 버튼을 누르세요.</p>
                                      </div>
                                      <button
                                        className="primary-button"
                                        type="button"
                                        disabled={busy === 'party-create'}
                                        onClick={() => createEmptyBossParty(selectedBossDetails)}
                                      >
                                        {busy === 'party-create' ? '생성 중...' : '+ 새 파티'}
                                      </button>
                                    </div>
                                    {selectedDifficultyParties.length ? (
                                      <div className="builder-party-list">
                                        {selectedDifficultyParties.map((party) => {
                                          const config = bossDetails(party.bossId);
                                          const summary = summarizeBossParty(party, groupCharacters);
                                          const members = party.members || [];
                                          const icon = bossImageFor(party.bossId);
                                          return (
                                            <article
                                              className={`group-party-item builder-party-card party-drop-target ${dragOverPartyId === party.partyId ? 'drag-over' : ''} ${activeBuilderPartyId === party.partyId ? 'target-selected' : ''}`}
                                              key={party.partyId}
                                              onDragOver={(event) => dragOverParty(event, party)}
                                              onDragLeave={(event) => {
                                                if (!event.currentTarget.contains(event.relatedTarget)) setDragOverPartyId('');
                                              }}
                                              onDrop={(event) => dropCharacterOnParty(event, party)}
                                            >
                                              <div className="group-party-heading">
                                                {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder">◇</span>}
                                                <div><p className="eyebrow">{config.difficultyLabel}</p><h3>{config.name}</h3></div>
                                                <span className="party-size-count">{members.length}/{config.maxPartySize}인</span>
                                              </div>
                                              <div className="group-party-members">
                                                {members.map((member) => (
                                                  <span className="group-party-member" key={`${member.ownerSub}:${member.ocid}`} title={`${member.ownerEmail} · ${member.multiplier}%`}>
                                                    {member.image ? <img src={member.image} alt="" /> : <span>{member.nickname.slice(0, 1)}</span>}
                                                    {member.nickname} <small>{Number(member.multiplier || 0)}%</small>
                                                  </span>
                                                ))}
                                                {!members.length && <span className="party-drop-hint">캐릭터를 여기로 드래그해 편성</span>}
                                              </div>
                                              <div className={`party-summary ${summary.ready ? 'ready' : ''} ${summary.cleared ? 'cleared' : ''}`}>
                                                <span>파티 배율 <strong>{summary.totalMultiplier.toFixed(1)}%</strong></span>
                                                <span>{summary.cleared ? '클리어 완료' : summary.ready ? '클리어 가능' : `${Math.max(0, 100 - summary.totalMultiplier).toFixed(1)}% 더 필요`}</span>
                                              </div>
                                              <button
                                                className="party-target-button"
                                                type="button"
                                                aria-pressed={activeBuilderPartyId === party.partyId}
                                                onClick={() => setActiveBuilderPartyId((current) => current === party.partyId ? '' : party.partyId)}
                                              >
                                                {activeBuilderPartyId === party.partyId ? '편성 대상 선택됨' : '편성 대상으로 선택'}
                                              </button>
                                            </article>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <div className="builder-empty-party">
                                        <strong>이 난이도에 아직 파티가 없습니다</strong>
                                        <span>새 파티를 만들면 캐릭터 후보를 바로 편성할 수 있습니다.</span>
                                      </div>
                                    )}
                                  </section>
                                ) : (
                                  <div className="builder-prompt">난이도를 선택하면 파티 목록과 해당 보스 배율 순 캐릭터를 볼 수 있습니다.</div>
                                )}
                              </>
                            ) : (
                              <div className="builder-prompt">
                                <strong>왼쪽에서 보스를 선택하세요</strong>
                                <span>전체 그룹 캐릭터는 헥사환산 점수 순으로 표시됩니다.</span>
                              </div>
                            )}

                            <section className="builder-roster" aria-label="그룹 파티 편성 가능 캐릭터">
                              <div className="builder-section-heading">
                                <div>
                                  <h4>{selectedBossDetails ? '편성 가능 캐릭터' : '그룹 캐릭터'}</h4>
                                  <p>
                                    {selectedBossDetails
                                      ? `${selectedBossDetails.difficultyLabel} ${selectedBossDetails.name} 보스 배율 순 · 이미 같은 보스 파티에 편성된 캐릭터 제외`
                                      : '헥사환산 점수 내림차순 · 레벨과 캐릭터 이미지'}
                                  </p>
                                </div>
                                <span className="updated-count">{groupPartyCandidates.length}명</span>
                              </div>
                              {groupPartyCandidates.length ? (
                                <div className="party-character-card-grid">
                                  {groupPartyCandidates.map((character) => {
                                    const canManage = character.ownerSub === account?.sub || selectedGroup.role === 'admin';
                                    const multiplierBoss = selectedBossDetails || character.recommendedBoss;
                                    const recommendations = recommendationsForCharacter(character, multipliers);
                                    const multiplier = selectedBossDetails ? character.selectedMultiplier : multiplierBoss
                                      ? getCharacterBossMultiplier(character, multiplierBoss.bossId)
                                      : null;
                                    return (
                                      <article
                                        className="party-character-card"
                                        data-dragging={draggedPartyCharacter?.ocid === character.ocid}
                                        key={`${character.ownerSub}:${character.ocid}`}
                                        draggable={canManage}
                                        onDragStart={(event) => startPartyMemberDrag(event, character)}
                                        onDragEnd={finishPartyMemberDrag}
                                      >
                                        {character.image
                                          ? <img src={character.image} alt={`${character.nickname} 캐릭터`} />
                                          : <span className="party-character-fallback">{character.nickname.slice(0, 1)}</span>}
                                        <div className="party-character-details">
                                          <strong>{character.nickname}</strong>
                                          <span>Lv. {character.level || '-'} · {character.characterClass || '직업 정보 없음'}</span>
                                          <span>헥사 {Number(character.boss380HexaScore || 0).toLocaleString('ko-KR')}</span>
                                          {!selectedBossFamily && recommendations.length > 0 && (
                                            <div className="party-character-recommendations" aria-label={`${character.nickname} 다인 추천 보스`}>
                                              {recommendations.slice(0, 3).map((boss) => (
                                                <span className="party-character-recommendation" key={boss.bossId}>
                                                  {bossImageFor(boss.bossId)
                                                    ? <img src={bossImageFor(boss.bossId)} alt="" />
                                                    : <span className="boss-placeholder" aria-hidden="true">◇</span>}
                                                  <span>{boss.difficultyLabel} {boss.name}</span>
                                                  <b>{recommendationPartyLabel(boss.recommendedPartySize)} · {boss.multiplier.toFixed(1)}%</b>
                                                </span>
                                              ))}
                                            </div>
                                          )}
                                          {character.bosses?.length > 0 && (
                                            <div className="party-character-assigned-bosses" aria-label={`${character.nickname} 편성된 보스`}>
                                              {character.bosses.map((assignment) => {
                                                const assignedBoss = bossDetails(assignment.bossId);
                                                return (
                                                  <button
                                                    className="party-character-assigned-boss"
                                                    type="button"
                                                    key={assignment.bossId}
                                                    onClick={() => unassignBossFromCharacter(character, assignment.bossId)}
                                                    title="보스 파티에서 제외"
                                                  >
                                                    {assignedBoss.difficultyLabel} {assignedBoss.name} ×
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          )}
                                          {selectedBossFamily && (
                                            <b className="party-character-multiplier">
                                              {multiplierBoss && !selectedBossDetails ? `${multiplierBoss.difficultyLabel} ` : ''}
                                              보스 배율 {Number(multiplier || 0).toFixed(1)}%
                                            </b>
                                          )}
                                        </div>
                                        {activeBuilderPartyId && selectedBossDetails && canManage && (
                                          <button
                                            className="party-character-assign"
                                            type="button"
                                            disabled={busy.startsWith('party:')}
                                            onClick={() => {
                                              const party = selectedDifficultyParties.find(({ partyId }) => partyId === activeBuilderPartyId);
                                              if (party) assignBossToCharacter(character, selectedBossDetails, party.partyId);
                                            }}
                                          >
                                            편성
                                          </button>
                                        )}
                                        {canManage && (
                                          <button
                                            className="party-character-remove"
                                            type="button"
                                            onClick={() => removeCharacterFromGroup(character.ocid)}
                                            aria-label={`${character.nickname} 그룹에서 제거`}
                                          >
                                            <span aria-hidden="true">−</span> 그룹에서 제거
                                          </button>
                                        )}
                                      </article>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="builder-empty-party">
                                  <strong>{groupCharacters.length ? '편성할 수 있는 캐릭터가 없습니다' : '그룹에 참여한 캐릭터가 없습니다'}</strong>
                                  <span>{selectedBossFamily ? '이 보스 파티에서 캐릭터를 제외하면 여기에 표시됩니다.' : '실사용 캐릭터를 그룹에 추가하면 여기에 표시됩니다.'}</span>
                                </div>
                              )}
                            </section>
                          </div>
                        </div>
                      </section>}
                    </>
                  )}
                </section>
              )}
            </>
          )}
          <footer className="page-footer"><span>MAPLE / SCOUT</span><span>Nexon Scheduler · Cloudflare D1</span></footer>
        </main>
      </div>
      {invitePrompt && (
        <div className="invite-prompt-backdrop">
          <section
            className="invite-prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-prompt-title"
          >
            <span className="invite-prompt-icon" aria-hidden="true">✉</span>
            <p className="eyebrow">GROUP INVITATION</p>
            <h2 id="invite-prompt-title">
              {invitePrompt.error
                ? '초대 정보를 확인할 수 없습니다'
                : invitePrompt.alreadyJoined
                  ? '이미 참여한 그룹입니다'
                  : `${invitePrompt.groupName} 그룹에 참여할까요?`}
            </h2>
            <p>
              {invitePrompt.error
                ? invitePrompt.error
                : invitePrompt.alreadyJoined
                  ? `${invitePrompt.groupName} 그룹에 이미 참여한 상태입니다.`
                  : '참여하면 실사용 캐릭터가 그룹 로스터에 추가됩니다.'}
            </p>
            <div className="invite-prompt-actions">
              {invitePrompt.error ? (
                <>
                  <button className="outline-button" type="button" onClick={() => setInvitePrompt(null)}>닫기</button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={retryGroupInvitePreview}
                    disabled={busy === 'invite-preview'}
                  >{busy === 'invite-preview' ? '확인 중...' : '다시 시도'}</button>
                </>
              ) : invitePrompt.alreadyJoined ? (
                <>
                  <button className="outline-button" type="button" onClick={() => setInvitePrompt(null)}>닫기</button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={openInvitedGroup}
                    disabled={busy === 'invite-accept'}
                  >그룹으로 이동</button>
                </>
              ) : (
                <>
                  <button className="outline-button" type="button" onClick={() => setInvitePrompt(null)}>나중에</button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={joinInvitedGroup}
                    disabled={busy === 'invite-accept'}
                  >{busy === 'invite-accept' ? '참여 중...' : '그룹 참여하기'}</button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {view === 'group' && selectedGroup && groupCharacterQuickMenu}
      {view === 'group' && partyWarningPopupElement}
    </div>
  );
}

export default App;
