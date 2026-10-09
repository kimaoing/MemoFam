import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    const path = new URL(url).pathname;
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

  const apiKeyInput = screen.getByLabelText('Nexon Open API 키');
  fireEvent.change(apiKeyInput, { target: { value: 'test-nexon-key' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'API 키 유지' }));
  expect(document.cookie).toContain('maple-scout-nexon-api-key=test-nexon-key');
  firstPage.unmount();

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  expect(screen.getByLabelText('Nexon Open API 키').value).toBe('test-nexon-key');
  expect(screen.getByRole('checkbox', { name: 'API 키 유지' }).checked).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'API 키 유지' }));
  expect(document.cookie).not.toContain('maple-scout-nexon-api-key=');
});

test('syncs all characters with one Nexon API key and refreshes a selected character', async () => {
  const workerCalls = [];
  const mapleScouterPopup = {};
  vi.spyOn(window, 'open').mockReturnValue(mapleScouterPopup);
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
      worldName: '스카니아',
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
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init.method || 'GET';
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return Response.json({ email: 'member@example.test', name: 'Member' });
    }

    const request = init.body ? JSON.parse(init.body) : {};
    workerCalls.push({ path, method, init, request });
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
        : path === '/api/groups'
          ? { groups: [{ id: 'group-1', name: 'Test group', role: 'admin' }] }
          : path === '/api/characters'
            ? { characters: [syncedCharacters[0]] }
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
  expect(screen.queryByLabelText(/캐릭터 닉네임/)).toBeNull();

  fireEvent.change(screen.getByLabelText('Nexon Open API 키'), { target: { value: 'test-nexon-key' } });
  fireEvent.click(screen.getByRole('button', { name: '전체 캐릭터 불러오기' }));
  expect((await screen.findByRole('status')).textContent).toContain('4개 캐릭터 정보를 동기화했습니다.');
  expect(screen.queryByText(/숨길캐릭터/)).toBeNull();
  expect(await screen.findByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.getByText('Lv. 291')).toBeDefined();
  expect(screen.getByText('72,807')).toBeDefined();
  expect(screen.queryByText(/미완료 \d+/)).toBeNull();
  const worldGroups = [...document.querySelectorAll('.world-character-group')];
  expect(worldGroups.map((group) => group.querySelector('h3').textContent)).toEqual(['스카니아', '에오스']);
  expect([...worldGroups[0].querySelectorAll('.character-info > strong')].map((name) => name.textContent))
    .toEqual(['아잉느', '오잉느', '세번째']);

  const syncCall = workerCalls.find(({ method, path }) => method === 'POST' && path === '/api/characters/verify');
  expect(syncCall.request).toEqual({ apiKey: 'test-nexon-key' });
  expect(screen.queryByDisplayValue('test-nexon-key')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /아잉느/ }));
  fireEvent.click(screen.getByTitle('Test group'));
  expect(await screen.findByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeDefined();
  expect(screen.getByText('일일 퀘스트')).toBeDefined();
  fireEvent.click(await screen.findByRole('button', { name: '아잉느 데이터 가져오기' }));
  expect(window.open).toHaveBeenCalledWith(
    'https://maplescouter.com/ko/result?name=%EC%95%84%EC%9E%89%EB%8A%90',
    '_blank',
  );
  expect(await screen.findByRole('dialog', { name: 'MapleScouter 데이터 가져오기' })).toBeDefined();
  const bookmarklet = screen.getByLabelText('북마클릿 주소').value;
  expect(bookmarklet.startsWith('javascript:(')).toBe(true);
  expect(bookmarklet).toContain(window.location.origin);
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://maplescouter.com',
    source: {},
    data: {
      type: 'maple-scout/maplescouter-import',
      payload: { nickname: '아잉느', boss380HexaScore: 70000, multipliers: [] },
    },
  }));
  expect(screen.getByText('MapleScouter 결과를 기다리는 중')).toBeDefined();
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
  expect(await screen.findByText('보스 배율 1개')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '가져온 데이터 저장' }));
  await screen.findByText('보스380 헥사 점수와 1개 보스 배율을 저장했습니다.');

  const importCall = workerCalls.find(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-import');
  expect(importCall.request).toEqual({
    nickname: '아잉느',
    boss380HexaScore: 70000,
    multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }],
    groupId: 'group-1',
  });
  expect(new Headers(importCall.init.headers).get('Authorization')).toBe('Bearer test-access-token');
  expect(workerCalls.some(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-scores')).toBe(false);
});
