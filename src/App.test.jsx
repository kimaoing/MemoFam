import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  const themeMeta = document.createElement('meta');
  themeMeta.name = 'theme-color';
  themeMeta.content = '#171922';
  document.head.append(themeMeta);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.cookie = 'maple-scout-nexon-api-key=; Max-Age=0; Path=/; SameSite=Strict';
  document.querySelector('meta[name="theme-color"]')?.remove();
  delete document.documentElement.dataset.theme;
});

test('renders the Google sign-in screen', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /보스 파티와 캐릭터 일정을/ })).toBeDefined();
  expect(screen.getByRole('button', { name: /Google 계정으로 계속/i })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '로그인 유지' })).toBeDefined();
  expect(screen.getByRole('button', { name: '라이트 모드로 전환' })).toBeDefined();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.querySelector('meta[name="theme-color"]').content).toBe('#171922');
});

test('switches between and remembers light and dark themes', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 전환' }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  expect(window.localStorage.getItem('maple-scout-theme')).toBe('light');
  expect(document.querySelector('meta[name="theme-color"]').content).toBe('#f4f5f8');

  fireEvent.click(screen.getByRole('button', { name: '다크 모드로 전환' }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  expect(window.localStorage.getItem('maple-scout-theme')).toBe('dark');
});

test('restores the Google session silently when login retention is enabled', async () => {
  const prompts = [];
  vi.stubGlobal('fetch', async (input) => {
    const url = String(input);
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return Response.json({ email: 'member@example.test', name: 'Member' });
    }
    const path = new URL(url, 'http://localhost').pathname;
    return Response.json(path === '/api/groups' ? { groups: [] } : { characters: [] });
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: ({ callback }) => ({
          requestAccessToken: ({ prompt }) => {
            prompts.push(prompt);
            callback({ access_token: 'test-access-token' });
          },
        }),
      },
    },
  });

  const firstPage = render(<App />);
  fireEvent.click(screen.getByRole('checkbox', { name: '로그인 유지' }));
  expect(window.localStorage.getItem('maple-scout-remember-login')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  firstPage.unmount();

  render(<App />);
  await screen.findByText('member@example.test');
  expect(prompts).toEqual(['select_account', '']);
  expect(window.localStorage.getItem('maple-scout-remember-login')).toBe('true');
  expect(window.localStorage.getItem('maple-scout-access-token')).toBeNull();
});

test('remembers the Nexon API key in a cookie only when requested', async () => {
  vi.stubGlobal('fetch', async (input) => {
    const url = String(input);
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return Response.json({ email: 'member@example.test', name: 'Member' });
    }
    const path = new URL(url).pathname;
    return Response.json(path === '/api/groups' ? { groups: [] } : { characters: [] });
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: ({ callback }) => ({
          requestAccessToken: () => callback({ access_token: 'test-access-token' }),
        }),
      },
    },
  });

  const firstPage = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  fireEvent.click(screen.getByRole('button', { name: '계정 설정' }));

  const apiKeyInput = screen.getByLabelText('Nexon Open API 키');
  fireEvent.change(apiKeyInput, { target: { value: 'test-nexon-key' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'API 키 유지' }));
  expect(document.cookie).toContain('maple-scout-nexon-api-key=test-nexon-key');
  firstPage.unmount();

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  fireEvent.click(screen.getByRole('button', { name: '계정 설정' }));
  expect(screen.getByLabelText('Nexon Open API 키').value).toBe('test-nexon-key');
  expect(screen.getByRole('checkbox', { name: 'API 키 유지' }).checked).toBe(true);
  const logoutButton = screen.getByRole('button', { name: '로그아웃' });
  expect(logoutButton.closest('.account-danger-zone')).toBeDefined();
  expect(document.querySelector('.logout-button')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'API 키 유지' }));
  expect(document.cookie).not.toContain('maple-scout-nexon-api-key=');
});

test('syncs all characters with one Nexon API key and refreshes a selected character', async () => {
  const workerCalls = [];
  const mapleScouterPopup = { location: { href: '' }, close: vi.fn() };
  const extensionChecks = [];
  vi.spyOn(window, 'open').mockReturnValue(mapleScouterPopup);
  vi.spyOn(window, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'maple-scout/extension-check') return;
    extensionChecks.push(message);
    if (extensionChecks.length > 1) {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: {
          type: 'maple-scout/extension-status',
          requestId: message.requestId,
          installed: true,
        },
      }));
    }
  });
  const syncedCharacters = [
    {
      nickname: '오잉느',
      ocid: 'ocid-1',
      worldName: '스카니아',
      characterClass: '아델',
      level: 291,
      image: 'https://image.example.test/ocid-1.png',
      boss380HexaScore: 67619,
      scheduler: {
        date: '2026-10-08',
        daily_contents: [{ content_name: '일일 퀘스트', type: 'quest', quest_state: '1' }],
        weekly_contents: [],
        boss_contents: [],
      },
    },
    {
      nickname: '아잉느',
      ocid: 'ocid-2',
      worldName: '루나',
      characterClass: '비숍',
      level: 280,
      image: 'https://image.example.test/ocid-2.png',
      boss380HexaScore: 72807,
      scheduler: { date: '2026-10-08', daily_contents: [], weekly_contents: [], boss_contents: [] },
    },
    {
      nickname: '최고레벨',
      ocid: 'ocid-3',
      worldName: '에오스',
      characterClass: '아크메이지',
      level: 285,
      image: 'https://image.example.test/ocid-3.png',
      boss380HexaScore: 65000,
      scheduler: { date: '2026-10-08', daily_contents: [], weekly_contents: [], boss_contents: [] },
    },
    {
      nickname: '세번째',
      ocid: 'ocid-4',
      worldName: '스카니아',
      characterClass: '나이트로드',
      level: 275,
      image: 'https://image.example.test/ocid-4.png',
      boss380HexaScore: 67144,
      scheduler: { date: '2026-10-08', daily_contents: [], weekly_contents: [], boss_contents: [] },
    },
  ];
  let groupCharacterAdded = false;
  let kalosAssigned = false;
  const groupRoster = () => (groupCharacterAdded ? [{
    ...syncedCharacters[0],
    ownerSub: 'member-sub',
    ownerEmail: 'member@example.test',
    bosses: kalosAssigned ? [{ bossId: 'chaos_kalos', familyId: 'kalos' }] : [],
  }] : []);
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    const method = init.method || 'GET';
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return Response.json({ email: 'member@example.test', name: 'Member', sub: 'member-sub' });
    }

    const request = init.body ? JSON.parse(init.body) : {};
    workerCalls.push({ path, method, init, request });
    if (method === 'POST' && path === '/api/groups/group-1/characters') {
      groupCharacterAdded = true;
      return Response.json({ added: true });
    }
    if (method === 'POST' && path.startsWith('/api/groups/group-1/party-characters/')) {
      kalosAssigned = true;
      return Response.json({ bossId: 'chaos_kalos', familyId: 'kalos', added: true }, { status: 201 });
    }
    const payload = method === 'POST' && path === '/api/characters/verify'
      ? {
        characters: syncedCharacters,
        skippedCharacters: ['숨길캐릭터'],
        schedulerUnavailable: [],
        verified: true,
      }
      : method === 'POST' && path === '/api/characters/maplescouter-scores'
        ? {
          scores: syncedCharacters.map(({ nickname, boss380HexaScore }) => ({ nickname, boss380HexaScore })),
          refreshedCount: syncedCharacters.length,
          unavailableCount: 0,
        }
      : method === 'POST' && path === '/api/characters/maplescouter-import'
        ? {
          nickname: request.nickname,
          boss380HexaScore: request.boss380HexaScore,
          updatedMultipliers: request.multipliers.length,
          ignoredMultipliers: 0,
          updatedAt: '2026-10-09T00:00:00.000Z',
        }
      : method === 'POST' && path.endsWith('/multipliers')
        ? { nickname: request.nickname, updated: 1 }
        : path === '/api/characters/selection' && method === 'GET'
          ? { ocids: [] }
          : path === '/api/characters/selection' && method === 'PUT'
            ? { ocids: request.ocids }
        : path === '/api/groups'
          ? { groups: [{ id: 'group-1', name: 'Test group', role: 'admin' }] }
          : path === '/api/characters'
            ? { characters: [syncedCharacters[0]] }
            : path === '/api/groups/group-1/characters'
              ? { characters: groupRoster() }
            : path.endsWith('/multipliers')
              ? { multipliers: [
                { nickname: '오잉느', bossId: 'normal_kalos', multiplier: 100 },
                { nickname: '오잉느', bossId: 'chaos_kalos', multiplier: 50 },
              ] }
            : path.endsWith('/bosses')
              ? { bossIds: ['normal_kaling'] }
              : { multipliers: [] };
    return Response.json(payload);
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: ({ callback }) => ({
          requestAccessToken: () => callback({ access_token: 'test-access-token' }),
        }),
      },
    },
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  fireEvent.click(screen.getByRole('button', { name: '계정 설정' }));
  expect(screen.queryByLabelText(/캐릭터 닉네임/)).toBeNull();

  fireEvent.change(screen.getByLabelText('Nexon Open API 키'), { target: { value: 'test-nexon-key' } });
  fireEvent.click(screen.getByRole('button', { name: '캐릭터 불러오기' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('4개 캐릭터 정보를 동기화했습니다.'));
  expect(screen.queryByText(/숨길캐릭터/)).toBeNull();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 아잉느 Lv. 280' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 최고레벨 Lv. 285' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 세번째 Lv. 275' })).toBeDefined();

  const syncCall = workerCalls.find(({ method, path }) => method === 'POST' && path === '/api/characters/verify');
  expect(syncCall.request).toEqual({ apiKey: 'test-nexon-key' });
  expect(screen.queryByDisplayValue('test-nexon-key')).toBeNull();

  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 아잉느 Lv. 280' }));
  expect(window.localStorage.getItem('maple-scout-active-characters:member@example.test'))
    .toBe(JSON.stringify(['ocid-1', 'ocid-2']));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path === '/api/characters/selection').at(-1).request.ocids)
    .toEqual(['ocid-1', 'ocid-2']));
  fireEvent.click(screen.getByTitle('내 정보'));
  expect(screen.getByRole('heading', { name: '실사용 캐릭터 2' })).toBeDefined();
  expect(screen.getByRole('searchbox', { name: '캐릭터 검색' })).toBeDefined();
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.getByRole('button', { name: /아잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /최고레벨/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /세번째/ })).toBeNull();
  expect(screen.getByText('72,807')).toBeDefined();
  const unassignedIndicator = screen.getByLabelText('오잉느 추천 보스가 그룹 파티에 편성되지 않음');
  expect(unassignedIndicator.getAttribute('title')).toContain('카오스 칼로스');

  fireEvent.change(screen.getByRole('searchbox', { name: '캐릭터 검색' }), { target: { value: '아잉' } });
  expect(screen.getByRole('button', { name: /아잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /오잉느/ })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox', { name: '캐릭터 검색' }), { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: '월드 필터' }), { target: { value: '스카니아' } });
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /아잉느/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));

  fireEvent.click(screen.getByRole('checkbox', { name: '오잉느 일일 일정 알림' }));
  expect(JSON.parse(window.localStorage.getItem('maple-scout-schedule-notifications:member@example.test')))
    .toEqual({ 'ocid-1': { daily: true } });
  expect(screen.getByText('일일 퀘스트')).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: /아잉느/ }));
  fireEvent.click(screen.getByTitle('Test group'));
  await waitFor(() => expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull());
  expect(screen.queryByText('일일 퀘스트')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '그룹 및 파티 관리' }));
  const addOwnCharacterButton = screen.getByText('오잉느').closest('.group-add-character').querySelector('button');
  fireEvent.click(addOwnCharacterButton);
  const chaosKalosRecommendation = await screen.findByText('카오스 칼로스');
  expect(chaosKalosRecommendation.closest('.recommendation-row').textContent).toContain('추천 2인');
  fireEvent.click(chaosKalosRecommendation.closest('.recommendation-row').querySelector('button'));
  await waitFor(() => expect(screen.getByText('카오스 칼로스', { selector: '.assigned-boss-chip span:first-child' })).toBeDefined());
  fireEvent.click(screen.getByTitle('내 정보'));
  await waitFor(() => expect(screen.queryByLabelText('오잉느 추천 보스가 그룹 파티에 편성되지 않음')).toBeNull());
  fireEvent.click(screen.getByTitle('Test group'));
  await waitFor(() => expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull());
  fireEvent.click(await screen.findByRole('button', { name: '실사용 2명 전체 갱신' }));
  expect(window.open).toHaveBeenNthCalledWith(1, 'about:blank', '_blank');
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 650)));
  expect(screen.getByRole('alert').textContent).toContain('MemoFam Reader 설치');
  expect(screen.getByText(/압축해제된 확장 프로그램을 로드/)).toBeDefined();
  const extensionDownload = screen.getByRole('link', { name: 'MemoFam Reader 다운로드' });
  expect(extensionDownload.getAttribute('href')).toBe('/memofam-maplescouter-reader.zip');
  expect(extensionDownload.hasAttribute('download')).toBe(true);
  expect(mapleScouterPopup.close).toHaveBeenCalledOnce();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '실사용 2명 전체 갱신' }));
    await Promise.resolve();
  });
  expect(window.open).toHaveBeenNthCalledWith(2, 'about:blank', '_blank');
  await waitFor(() => expect(mapleScouterPopup.location.href)
    .toBe('https://maplescouter.com/ko/result?name=%EC%98%A4%EC%9E%89%EB%8A%90'));
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://maplescouter.com',
    source: {},
    data: {
      type: 'maple-scout/maplescouter-import',
      payload: {
        nickname: '오잉느',
        boss380HexaScore: 67619,
        multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }],
      },
    },
  }));
  expect(workerCalls.some(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-import')).toBe(false);
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://maplescouter.com',
    source: mapleScouterPopup,
    data: {
      type: 'maple-scout/maplescouter-import',
      payload: {
        nickname: '오잉느',
        boss380HexaScore: 67619,
        multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }],
      },
    },
  }));
  await waitFor(() => expect(mapleScouterPopup.location.href)
    .toBe('https://maplescouter.com/ko/result?name=%EC%95%84%EC%9E%89%EB%8A%90'));
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://maplescouter.com',
    source: mapleScouterPopup,
    data: {
      type: 'maple-scout/maplescouter-import',
      payload: {
        nickname: '아잉느',
        boss380HexaScore: 70000,
        multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }],
      },
    },
  }));
  await screen.findByText(/실사용 캐릭터 2\/2명 동기화 완료/);
  expect(screen.queryByLabelText('북마클릿 주소')).toBeNull();
  expect(mapleScouterPopup.close).toHaveBeenCalledTimes(2);

  const importCalls = workerCalls.filter(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-import');
  expect(importCalls.map(({ request }) => request)).toEqual([
    { nickname: '오잉느', boss380HexaScore: 67619, multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }], groupId: 'group-1' },
    { nickname: '아잉느', boss380HexaScore: 70000, multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }], groupId: 'group-1' },
  ]);
  expect(new Headers(importCalls[0].init.headers).get('Authorization')).toBe('Bearer test-access-token');
  expect(workerCalls.some(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-scores')).toBe(false);
});
