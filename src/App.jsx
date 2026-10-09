import { useEffect, useRef, useState } from 'react';
import './App.css';
import { workerRequest } from './workerApi';

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const workerApiUrl = import.meta.env.VITE_WORKER_API_URL;
const rememberLoginKey = 'maple-scout-remember-login';
const themeKey = 'maple-scout-theme';
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
  const [view, setView] = useState('characters');
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(() => readPreference(rememberLoginKey, 'false') === 'true');
  const [rememberApiKey, setRememberApiKey] = useState(() => Boolean(readNexonApiKeyCookie()));
  const [theme, setTheme] = useState(() => readPreference(themeKey, 'dark'));
  const characterWorldGroups = groupCharactersByWorld(characters);
  const restoreLoginOnMount = useRef(rememberLogin);
  const loginRestoreAttempted = useRef(false);

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
      setAccessToken(token);
      setAccount({ email: profile.email, name: profile.name });
      setCharacters(savedCharacters);
      setSelectedCharacterId(savedCharacters[0]?.ocid || '');
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
      setSelectedCharacterId((current) => (
        syncedCharacters.some((character) => character.ocid === current)
          ? current
          : syncedCharacters[0].ocid
      ));
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
    const groupId = view === 'group' ? selectedGroupId : null;
    setBusy('maplescouter-refresh');
    setNotice(null);
    try {
      const scrapeResponse = await fetch('/api/maplescouter/multipliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: character.nickname }),
      });
      const scraped = await scrapeResponse.json().catch(() => ({}));
      if (!scrapeResponse.ok) {
        throw new Error(scraped.error || `로컬 크롤링 요청 오류 (${scrapeResponse.status})`);
      }
      if (typeof scraped.nickname !== 'string'
        || scraped.nickname.toLocaleLowerCase('ko') !== character.nickname.toLocaleLowerCase('ko')
        || !Number.isSafeInteger(scraped.boss380HexaScore)
        || !Array.isArray(scraped.multipliers)) {
        throw new Error('로컬 크롤링 결과를 확인할 수 없습니다. Vite 개발 서버와 Playwright Chromium 설치를 확인해 주세요.');
      }
      if (groupId && !scraped.multipliers.length) {
        throw new Error('MapleScouter에서 보스 배율을 찾지 못했습니다. 결과가 모두 표시된 뒤 다시 시도해 주세요.');
      }

      const result = await workerRequest(accessToken, '/api/characters/maplescouter-import', {
        method: 'POST',
        body: JSON.stringify({
          nickname: character.nickname,
          boss380HexaScore: scraped.boss380HexaScore,
          multipliers: groupId ? scraped.multipliers : [],
          groupId,
        }),
      });
      setCharacters((current) => current.map((character) => (
        character.ocid === selectedCharacter.ocid
          ? { ...character, boss380HexaScore: result.boss380HexaScore }
          : character
      )));
      if (groupId) await loadGroupData(accessToken, groupId);
      setNotice({
        type: 'success',
        text: `${groupId
          ? `보스380 헥사 점수와 ${result.updatedMultipliers}개 보스 배율을 저장했습니다.`
          : '보스380 헥사 점수를 저장했습니다.'}${result.ignoredMultipliers ? ` 그룹에 없는 ${result.ignoredMultipliers}개 보스는 제외했습니다.` : ''}`,
      });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy('');
    }
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
  const selectedCharacter = characters.find(({ ocid }) => ocid === selectedCharacterId);
  const currentRows = multipliers
    .slice()
    .sort((first, second) => first.nickname.localeCompare(second.nickname) || first.bossId.localeCompare(second.bossId));
  const viewTitle = view === 'characters'
    ? '내 정보'
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
              <button className="primary-button" type="button" onClick={refreshMapleScouterData} disabled={busy === 'maplescouter-refresh'}>
                {busy === 'maplescouter-refresh' ? 'MapleScouter 수집 중...' : `${selectedCharacter.nickname} 자동 갱신`}
              </button>
            )}
          </div>

          {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}

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
              {view === 'characters' && (
                <>
                  <section className="sync-card">
                    <div className="sync-copy">
                      <span className="sync-mark">N</span>
                      <div>
                        <p className="eyebrow">NEXON OPEN API</p>
                        <h2>Nexon 계정 연결</h2>
                        <p>API 키 하나로 계정의 모든 캐릭터, 기본 정보, 스케줄러 수행 현황을 불러옵니다.</p>
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
                        {busy === 'sync' ? '캐릭터 불러오는 중...' : '전체 캐릭터 불러오기'}
                      </button>
                    </form>
                    <div className="sync-footer">
                      <span>API 키는 브라우저 쿠키에 30일간 저장할 수 있습니다. 공용 기기에서는 유지 옵션을 사용하지 마세요.</span>
                      <a href="https://openapi.nexon.com/ko/game/maplestory/?id=14" target="_blank" rel="noreferrer">API 키 및 캐릭터 API 안내</a>
                      <a href="https://openapi.nexon.com/ko/game/maplestory/?id=57" target="_blank" rel="noreferrer">스케줄러 API 안내</a>
                    </div>
                  </section>

                  <section className="character-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">MY CHARACTERS</p>
                        <h2>내 캐릭터 <span className="character-count">{characters.length}</span></h2>
                      </div>
                      <div className="character-tools">
                        <span className="updated-count">보스380 헥사환산 기준으로 정렬</span>
                        <button
                          className="outline-button character-score-refresh"
                          type="button"
                          onClick={refreshMapleScouterData}
                          disabled={!selectedCharacter || busy === 'maplescouter-refresh'}
                        >
                          {busy === 'maplescouter-refresh' ? 'MapleScouter 수집 중...' : 'MapleScouter 자동 갱신'}
                        </button>
                      </div>
                    </div>
                    {characters.length ? (
                      characterWorldGroups.map(({ worldName, characters: worldCharacters }) => (
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
                        <strong>아직 연결된 캐릭터가 없습니다</strong>
                        <p>위에 Nexon Open API 키를 입력하면 계정의 모든 캐릭터를 불러옵니다.</p>
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
                        {!characters.length ? (
                          <div className="empty-state compact"><strong>연결된 캐릭터가 없습니다</strong><p>내 정보에서 Nexon API 키로 캐릭터를 동기화하세요.</p></div>
                        ) : (
                          <div className="schedule-character-list">
                            {characters.map((character) => {
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
                          최근 동기화된 Nexon 스케줄러 기준입니다. 최신 현황을 불러오려면 내 정보에서 API 키로 다시 동기화하세요.
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
