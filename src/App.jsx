import { useEffect, useRef, useState } from 'react';
import './App.css';
import { workerRequest } from './workerApi';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const workerApiUrl = import.meta.env.VITE_WORKER_API_URL;
const mapleScouterOrigin = 'https://maplescouter.com';
const mapleScouterMessageType = 'maple-scout/maplescouter-import';
const extensionCheckType = 'maple-scout/extension-check';
const extensionStatusType = 'maple-scout/extension-status';
const rememberLoginKey = 'maple-scout-remember-login';
const themeKey = 'maple-scout-theme';
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
  if (item.type === 'quest') return item.quest_state !== '2';
  return Number(item.now_count || 0) < Number(item.max_count || 0);
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
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [bossIds, setBossIds] = useState([]);
  const [multipliers, setMultipliers] = useState([]);
  const [nexonKey, setNexonKey] = useState(readNexonApiKeyCookie);
  const [newGroupName, setNewGroupName] = useState('');
  const [newBossId, setNewBossId] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
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
    function clearPendingRequest() {
      if (mapleScouterTimeout.current) window.clearTimeout(mapleScouterTimeout.current);
      mapleScouterTimeout.current = null;
      mapleScouterPopup.current = null;
      mapleScouterRequest.current = null;
    }

    async function saveMapleScouterResult(payload, request) {
      try {
        if (payload.error) throw new Error(payload.error);
        if (typeof payload.nickname !== 'string'
          || payload.nickname.toLocaleLowerCase('ko') !== request.nickname.toLocaleLowerCase('ko')
          || !Number.isSafeInteger(payload.boss380HexaScore)
          || !Array.isArray(payload.multipliers)) {
          throw new Error('MapleScouter 확장에서 받은 결과를 확인할 수 없습니다.');
        }
        if (request.groupId && !payload.multipliers.length) {
          throw new Error('MapleScouter에서 보스 배율을 찾지 못했습니다. 결과가 모두 표시된 뒤 다시 시도해 주세요.');
        }

        const result = await workerRequest(accessToken, '/api/characters/maplescouter-import', {
          method: 'POST',
          body: JSON.stringify({
            nickname: request.nickname,
            boss380HexaScore: payload.boss380HexaScore,
            multipliers: request.groupId ? payload.multipliers : [],
            groupId: request.groupId,
          }),
        });
        setCharacters((current) => current.map((character) => (
          character.ocid === request.ocid
            ? { ...character, boss380HexaScore: result.boss380HexaScore }
            : character
        )));
        if (request.groupId) await loadGroupData(accessToken, request.groupId);
        setNotice({
          type: 'success',
          text: `${request.groupId
            ? `보스380 헥사 점수와 ${result.updatedMultipliers}개 보스 배율을 저장했습니다.`
            : '보스380 헥사 점수를 저장했습니다.'}${result.ignoredMultipliers ? ` 그룹에 없는 ${result.ignoredMultipliers}개 보스는 제외했습니다.` : ''}`,
        });
          setShowExtensionInstallHelp(false);
      } catch (error) {
        reportError(error);
      } finally {
        setBusy('');
      }
    }

    function receiveMapleScouterResult(event) {
      if (event.origin !== mapleScouterOrigin || event.source !== mapleScouterPopup.current) return;
      const request = mapleScouterRequest.current;
      const payload = event.data?.type === mapleScouterMessageType ? event.data.payload : null;
      if (!request || !payload) return;

      clearPendingRequest();
      void saveMapleScouterResult(payload, request);
    }

    window.addEventListener('message', receiveMapleScouterResult);
    return () => {
      window.removeEventListener('message', receiveMapleScouterResult);
    };
  }, [accessToken]);

  const reportError = (error) => {
    setNotice({ type: 'error', text: error.message || '요청에 실패했습니다.' });
  };

  async function loadGroupData(token, groupId) {
    if (!groupId) {
      setBossIds([]);
      setMultipliers([]);
      return;
    }
    const [bossResult, multiplierResult] = await Promise.all([
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/bosses`),
      workerRequest(token, `/api/groups/${encodeURIComponent(groupId)}/multipliers`),
    ]);
    setBossIds(bossResult.bossIds);
    setMultipliers(multiplierResult.multipliers);
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
      const [groupResult, characterResult] = await Promise.all([
        workerRequest(token, '/api/groups'),
        workerRequest(token, '/api/characters'),
      ]);
      const savedCharacters = characterResult.characters || [];
      const savedGroups = groupResult.groups || [];
      const savedActiveCharacterIds = readActiveCharacterIds(profile.email, savedCharacters);
      setAccessToken(token);
      setAccount({ email: profile.email, name: profile.name });
      setCharacters(savedCharacters);
      setActiveCharacterIds(savedActiveCharacterIds);
      setSelectedCharacterId(savedActiveCharacterIds[0] || '');
      setGroups(savedGroups);
      setSelectedGroupId(savedGroups[0]?.id || '');
      await loadGroupData(token, savedGroups[0]?.id || '');
      if (!silent) setNotice({ type: 'success', text: `${profile.email} 계정으로 연결했습니다.` });
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

  async function refreshMapleScouterData() {
    const character = characters.find(({ ocid }) => ocid === selectedCharacterId);
    if (!character) return;
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
    mapleScouterRequest.current = { nickname: character.nickname, ocid: character.ocid, groupId };
    setBusy('maplescouter-refresh');
    const resultUrl = new URL('/ko/result', mapleScouterOrigin);
    resultUrl.searchParams.set('name', character.nickname);
    mapleScouterTimeout.current = window.setTimeout(() => {
      if (mapleScouterPopup.current !== popup) return;
      mapleScouterPopup.current = null;
      mapleScouterRequest.current = null;
      setBusy('');
      setShowExtensionInstallHelp(true);
      setNotice({
        type: 'error',
        text: '결과를 받지 못했습니다. MemoFam MapleScouter Reader 브라우저 확장을 설치했는지 확인해 주세요.',
      });
    }, 65_000);
    popup.location.href = resultUrl.toString();
  }

  async function createBoss(event) {
    event.preventDefault();
    const bossId = newBossId.trim();
    if (!/^[a-z]+_[a-zA-Z]+$/.test(bossId)) {
      setNotice({ type: 'error', text: 'bossId 형식으로 입력해 주세요. 예: hard_kaling' });
      return;
    }
    setBusy('boss');
    try {
      const result = await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/bosses`, {
        method: 'POST',
        body: JSON.stringify({ bossId }),
      });
      if (result.added) setBossIds((previous) => [...new Set([...previous, bossId])]);
      setNewBossId('');
      setNotice({ type: 'success', text: `${bossId} 보스를 등록했습니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  async function addMember(event) {
    event.preventDefault();
    if (!memberEmail.trim() || !selectedGroupId) return;
    setBusy('member');
    try {
      await workerRequest(accessToken, `/api/groups/${encodeURIComponent(selectedGroupId)}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: memberEmail.trim() }),
      });
      setMemberEmail('');
      setNotice({ type: 'success', text: `${memberEmail.trim()} 계정을 그룹에 추가했습니다.` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
  }

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const activeCharacters = characters.filter(({ ocid }) => activeCharacterIds.includes(ocid));
  const activeCharacterWorldGroups = groupCharactersByWorld(activeCharacters);
  const characterWorldGroups = groupCharactersByWorld(characters);
  const selectedCharacter = activeCharacters.find(({ ocid }) => ocid === selectedCharacterId);
  const currentRows = multipliers
    .slice()
    .sort((first, second) => first.nickname.localeCompare(second.nickname) || first.bossId.localeCompare(second.bossId));
  const viewTitle = view === 'characters'
    ? '내 캐릭터'
    : view === 'settings'
      ? '계정 설정'
    : view === 'bosses'
      ? '보스 설정'
      : selectedGroup?.name || '그룹';
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
            className={`rail-button account-settings-button ${view === 'settings' ? 'active' : ''}`}
            type="button"
            title="계정 설정"
            aria-label="계정 설정"
            onClick={() => setView('settings')}
          >
            <span className="rail-avatar">⚙</span>
            <span className="rail-tooltip">계정 설정</span>
          </button>
        )}
        {account && (
          <button
            className="rail-button add-group-button"
            type="button"
            title="그룹 만들기"
            onClick={() => {
              setSelectedGroupId('');
              setBossIds([]);
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
          <button className="rail-button logout-button" type="button" title="로그아웃" onClick={logOut}>
            <span className="rail-avatar">↪</span>
            <span className="rail-tooltip">로그아웃</span>
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
              <>
                <span className="account-email">{account.email}</span>
                <button className="quiet-button" type="button" onClick={logOut}>로그아웃</button>
              </>
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
            {account && view === 'group' && selectedGroup && selectedCharacter && (
              <button className="primary-button" type="button" onClick={refreshMapleScouterData} disabled={busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}>
                {busy === 'maplescouter-check' ? '확장 확인 중...' : busy === 'maplescouter-refresh' ? 'MapleScouter 수집 중...' : `${selectedCharacter.nickname} 자동 갱신`}
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
              <ol>
                <li>Chrome에서 <code>chrome://extensions</code>, Edge에서 <code>edge://extensions</code>를 엽니다.</li>
                <li>개발자 모드를 켜고 <strong>압축해제된 확장 프로그램을 로드</strong>를 누릅니다.</li>
                <li>저장소의 <code>browser-extension/</code> 폴더를 선택한 뒤 이 앱 페이지를 새로고침합니다. 사용자 지정 도메인이라면 manifest.json에 도메인을 추가하세요.</li>
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
                          disabled={!selectedCharacter || busy === 'maplescouter-check' || busy === 'maplescouter-refresh'}
                        >
                          {busy === 'maplescouter-check' ? '확장 확인 중...' : busy === 'maplescouter-refresh' ? 'MapleScouter 수집 중...' : 'MapleScouter 자동 갱신'}
                        </button>
                      </div>
                    </div>
                    {activeCharacters.length ? (
                      activeCharacterWorldGroups.map(({ worldName, characters: worldCharacters }) => (
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
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      ))
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
                      <section className="party-header">
                        <div>
                          <p className="eyebrow">PARTY BOSS STATUS</p>
                          <h2>{selectedGroup.name}</h2>
                          <p>{selectedGroup.role === 'admin' ? '관리자' : '그룹 멤버'} · {multipliers.length}개 배율 기록</p>
                        </div>
                        <button className="outline-button" type="button" onClick={() => setView('bosses')}>그룹 관리</button>
                      </section>

                      <section className="panel-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">BOSS PARTY</p><h2>파티 보스 현황</h2></div>
                          <span className="updated-count">{bossIds.length} BOSSES</span>
                        </div>
                        {currentRows.length ? (
                          <div className="boss-grid">
                            {currentRows.map((row) => {
                              const icon = bossImages[`./bossImage/${row.bossId}.png`];
                              return (
                                <article className="boss-item" key={`${row.nickname}:${row.bossId}`}>
                                  {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder">◇</span>}
                                  <span className="boss-owner">{row.nickname}</span>
                                  <span className="boss-id">{row.bossId}</span>
                                  <strong>{row.multiplier}%</strong>
                                  <small>{row.updatedAt ? new Date(row.updatedAt).toLocaleString('ko-KR') : '기록 없음'}</small>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="empty-state compact">
                            <strong>저장된 파티 보스 배율이 없습니다</strong>
                            <p>그룹 관리에서 보스를 등록한 뒤 캐릭터를 선택해 배율을 갱신하세요.</p>
                          </div>
                        )}
                      </section>

                      <section className="panel-section schedule-section">
                        <div className="section-heading">
                          <div><p className="eyebrow">NEXON SCHEDULER</p><h2>내 캐릭터 미완료 일정</h2></div>
                          {selectedCharacter && <span className="updated-count">선택 캐릭터: {selectedCharacter.nickname}</span>}
                        </div>
                        {!activeCharacters.length ? (
                          <div className="empty-state compact"><strong>사용 캐릭터가 선택되지 않았습니다</strong><p>계정 설정에서 사용할 캐릭터를 선택하세요.</p></div>
                        ) : (
                          <div className="schedule-character-list">
                            {activeCharacters.map((character) => {
                              const scheduler = character.scheduler || {};
                              const daily = (scheduler.daily_contents || []).filter((item) => isIncomplete(item));
                              const weekly = (scheduler.weekly_contents || []).filter((item) => isIncomplete(item));
                              const bosses = (scheduler.boss_contents || []).filter((item) => isIncomplete(item, true));
                              const incompleteCount = daily.length + weekly.length + bosses.length;
                              return (
                                <article className="schedule-character" key={character.ocid}>
                                  <button
                                    className="schedule-character-name"
                                    type="button"
                                    onClick={() => setSelectedCharacterId(character.ocid)}
                                  >
                                    {character.image
                                      ? <img src={character.image} alt="" loading="lazy" />
                                      : <span className="character-fallback small">{character.nickname.slice(0, 1)}</span>}
                                    <span><strong>{character.nickname}</strong><small>Lv. {character.level || '-'}</small></span>
                                  </button>
                                  <div className="schedule-tasks">
                                    {scheduler.date ? (
                                      <>
                                        {[...daily, ...weekly].map((item, index) => (
                                          <span className="task-chip pending" key={`${item.content_name}-${index}`}>
                                            {item.content_name} {item.max_count > 1 ? `(${item.now_count || 0}/${item.max_count})` : ''}
                                          </span>
                                        ))}
                                        {bosses.map((item, index) => (
                                          <span className="task-chip pending" key={`${item.content_name}-${item.difficulty}-${index}`}>
                                            {item.content_name}{item.difficulty ? ` ${item.difficulty}` : ''}
                                          </span>
                                        ))}
                                        {!incompleteCount && <span className="task-chip completed">미완료 일정 없음</span>}
                                      </>
                                    ) : (
                                      <span className="task-chip unavailable">해당 날짜의 스케줄 기록이 없습니다</span>
                                    )}
                                  </div>
                                  <span className={`schedule-total ${incompleteCount ? 'has-pending' : ''}`}>
                                    {scheduler.date ? `미완료 ${incompleteCount}` : '기록 없음'}
                                  </span>
                                </article>
                              );
                            })}
                          </div>
                        )}
                        <p className="privacy-note">
                          최근 동기화된 Nexon 스케줄러 기준입니다. 최신 현황을 불러오려면 계정 설정에서 API 키로 다시 동기화하세요.
                        </p>
                      </section>
                    </>
                  )}
                </section>
              )}

              {view === 'bosses' && (
                <section className="boss-config-section">
                  {!selectedGroup ? (
                    <div className="empty-state">
                      <strong>관리할 그룹을 먼저 선택하세요</strong>
                      <p>왼쪽 그룹 아이콘을 누르면 해당 그룹의 보스 설정을 볼 수 있습니다.</p>
                    </div>
                  ) : (
                    <>
                      <div className="section-heading">
                        <div><p className="eyebrow">{selectedGroup.name}</p><h2>그룹 보스 및 멤버 설정</h2></div>
                        <span className="updated-count">{bossIds.length} BOSSES</span>
                      </div>
                      {selectedGroup.role === 'admin' && (
                        <>
                          <form className="management-form" onSubmit={createBoss}>
                            <label htmlFor="boss-id">bossId</label>
                            <input id="boss-id" value={newBossId} onChange={(event) => setNewBossId(event.target.value)} placeholder="예: hard_kaling" required />
                            <button className="outline-button" type="submit" disabled={busy === 'boss'}>보스 추가</button>
                          </form>
                          <form className="management-form" onSubmit={addMember}>
                            <label htmlFor="member-email">Google 이메일로 멤버 초대</label>
                            <input id="member-email" type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="member@gmail.com" required />
                            <button className="outline-button" type="submit" disabled={busy === 'member'}>{busy === 'member' ? '초대 중...' : '멤버 초대'}</button>
                          </form>
                        </>
                      )}
                      <div className="boss-list">
                        {bossIds.map((bossId) => {
                          const icon = bossImages[`./bossImage/${bossId}.png`];
                          return (
                            <div className="boss-list-row" key={bossId}>
                              {icon ? <img src={icon} alt="" /> : <span className="boss-placeholder small-placeholder">◇</span>}
                              <span>{bossId}</span><span className="row-note">배율 조회 대상</span>
                            </div>
                          );
                        })}
                        {!bossIds.length && <div className="empty-state compact">이 그룹에 등록된 보스가 없습니다.</div>}
                      </div>
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
