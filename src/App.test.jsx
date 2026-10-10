import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function mockInviteSignIn({
  alreadyJoined = false,
  selectionUnavailable = false,
  characters = [],
} = {}) {
  const requests = [];
  let memberAdded = alreadyJoined;
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    requests.push({ path, method: init.method || 'GET' });
    if (path === '/api/auth/google') {
      return Response.json({
        sessionToken: 'invite-session-token',
        account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' },
      });
    }
    if (path === '/api/auth/session') {
      return Response.json({ account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' } });
    }
    if (path === '/api/groups') {
      return Response.json({
        groups: memberAdded ? [{ id: 'group-1', name: 'Test group', role: 'member' }] : [],
      });
    }
    if (path === '/api/group-invites/preview') {
      return Response.json({
        groupId: 'group-1',
        groupName: 'Test group',
        alreadyJoined,
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
    }
    if (path === '/api/group-invites/accept') {
      memberAdded = true;
      return Response.json({ groupId: 'group-1', groupName: 'Test group', joined: true });
    }
    if (path === '/api/characters/selection' && init.method === 'PUT') {
      return Response.json({ ocids: JSON.parse(init.body).ocids });
    }
    if (path === '/api/characters/selection') {
      return selectionUnavailable
        ? Response.json({ error: 'selection temporarily unavailable' }, { status: 500 })
        : Response.json({ ocids: [] });
    }
    if (path === '/api/characters') return Response.json({ characters });
    if (path === '/api/characters/multipliers') return Response.json({ multipliers: [] });
    if (path.startsWith('/api/groups/group-1/')) {
      return Response.json({ multipliers: [], characters: [], parties: [], members: [] });
    }
    return Response.json({});
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initCodeClient: ({ callback }) => ({
          requestCode: () => callback({ code: 'invite-auth-code' }),
        }),
      },
    },
  });
  return requests;
}

test('renders the Google sign-in screen', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /보스 파티와 캐릭터 일정을/ })).toBeDefined();
  expect(screen.getByRole('button', { name: /Google 계정으로 계속/i })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '로그인 유지' })).toBeDefined();
  expect(screen.getByRole('button', { name: '라이트 모드로 전환' })).toBeDefined();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.querySelector('meta[name="theme-color"]').content).toBe('#171922');
});

test('shows an invitation confirmation after login and joins only when confirmed', async () => {
  window.history.replaceState({}, '', `/?invite=${'a'.repeat(64)}`);
  const requests = mockInviteSignIn();
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Test group 그룹에 참여할까요?' })).toBeDefined();
  expect(requests.some(({ path }) => path === '/api/group-invites/preview')).toBe(true);
  expect(requests.some(({ path }) => path === '/api/group-invites/accept')).toBe(false);
  expect(requests.some(({ path, method }) => path === '/api/characters/selection' && method === 'PUT')).toBe(false);
  expect(window.location.pathname).toBe('/');
  expect(window.location.search).toBe('');

  fireEvent.click(within(dialog).getByRole('button', { name: '그룹 참여하기' }));
  await waitFor(() => expect(requests.some(({ path }) => path === '/api/group-invites/accept')).toBe(true));
  expect(requests.some(({ path, method }) => path === '/api/characters/selection' && method === 'PUT')).toBe(true);
  await screen.findByText('Test group 그룹에 참가했습니다.');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('restores a saved login from an invite before saving the selected characters', async () => {
  window.history.replaceState({}, '', `/?invite=${'c'.repeat(64)}`);
  window.localStorage.setItem('maple-scout-remember-login', 'true');
  window.localStorage.setItem('maple-scout-session', 'invite-session-token');
  window.localStorage.setItem('maple-scout-active-characters:member@example.test', '["ocid-1"]');
  const requests = mockInviteSignIn({
    selectionUnavailable: true,
    characters: [{ ocid: 'ocid-1', nickname: 'TestChar', level: 260 }],
  });
  render(<App />);

  const dialog = await screen.findByRole('dialog');
  expect(await screen.findByText('member@example.test')).toBeDefined();
  expect(screen.queryByText(/로그인 세션을 복원하지 못했습니다/)).toBeNull();
  expect(requests.some(({ path, method }) => path === '/api/characters/selection' && method === 'PUT')).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: '그룹 참여하기' }));
  await waitFor(() => expect(requests.some(({ path }) => path === '/api/group-invites/accept')).toBe(true));
  expect(requests.some(({ path, method }) => path === '/api/characters/selection' && method === 'PUT')).toBe(true);
});

test('shows an already-joined invitation without accepting it again', async () => {
  window.history.replaceState({}, '', `/?invite=${'b'.repeat(64)}`);
  const requests = mockInviteSignIn({ alreadyJoined: true });
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: '이미 참여한 그룹입니다' })).toBeDefined();
  expect(within(dialog).getByText('Test group 그룹에 이미 참여한 상태입니다.')).toBeDefined();
  expect(within(dialog).getByRole('button', { name: '그룹으로 이동' })).toBeDefined();
  expect(requests.some(({ path }) => path === '/api/group-invites/accept')).toBe(false);
  expect(window.location.pathname).toBe('/');
  expect(window.location.search).toBe('');

  fireEvent.click(within(dialog).getByRole('button', { name: '그룹으로 이동' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests.some(({ path }) => path === '/api/group-invites/accept')).toBe(false);
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

test('restores the server login session after a page reload when login retention is enabled', async () => {
  const prompts = [];
  const sessionHeaders = [];
  const revokedSessions = [];
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/auth/google') {
      return Response.json({
        sessionToken: 'server-session-token',
        account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' },
      });
    }
    if (path === '/api/auth/session' && init.method === 'DELETE') {
      revokedSessions.push(new Headers(init.headers).get('Authorization'));
      return Response.json({ loggedOut: true });
    }
    if (path === '/api/auth/session') {
      sessionHeaders.push(new Headers(init.headers).get('Authorization'));
      return Response.json({ account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' } });
    }
    return Response.json(path === '/api/groups' ? { groups: [] } : { characters: [] });
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initCodeClient: ({ callback }) => ({
          requestCode: ({ prompt }) => {
            prompts.push(prompt);
            callback({ code: 'one-time-auth-code' });
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
  expect(prompts).toEqual(['consent']);
  expect(window.localStorage.getItem('maple-scout-remember-login')).toBe('true');
  expect(window.localStorage.getItem('maple-scout-session')).toBe('server-session-token');
  expect(sessionHeaders).toEqual(['Bearer server-session-token']);
  fireEvent.click(screen.getByRole('button', { name: '계정 설정' }));
  fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
  await screen.findByRole('button', { name: /Google 계정으로 계속/i });
  expect(window.localStorage.getItem('maple-scout-session')).toBeNull();
  expect(window.localStorage.getItem('maple-scout-remember-login')).toBeNull();
  expect(revokedSessions).toEqual(['Bearer server-session-token']);
});

test('remembers the Nexon API key in a cookie only when requested', async () => {
  vi.stubGlobal('fetch', async (input) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (path === '/api/auth/google') {
      return Response.json({
        sessionToken: 'temporary-session-token',
        account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' },
      });
    }
    return Response.json(path === '/api/groups' ? { groups: [] } : { characters: [] });
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initCodeClient: ({ callback }) => ({
          requestCode: () => callback({ code: 'one-time-auth-code' }),
        }),
      },
    },
  });

  const firstPage = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  expect(window.localStorage.getItem('maple-scout-session')).toBeNull();
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
  const scheduleBosses = [
    { content_name: '검은 마법사', difficulty: 'hard', complete_flag: 'true' },
    { content_name: '감시자 칼로스', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '칼로스', difficulty: 'chaos', complete_flag: 'false' },
    { content_name: '시그너스', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '힐라', difficulty: 'hard', complete_flag: 'false' },
    { content_name: '아카이럼', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '반 레온', difficulty: 'hard', complete_flag: 'false' },
    { content_name: '카웅', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '혼테일', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '파풀라투스', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '매그너스', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '매그너스', difficulty: 'easy', complete_flag: 'false' },
    { content_name: '반반', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '벨룸', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '블러디퀸', difficulty: 'normal', complete_flag: 'false' },
    { content_name: '피에르', difficulty: 'normal', complete_flag: 'false' },
    ...Array.from({ length: 12 }, (_, index) => ({
      content_name: `테스트 보스 ${index + 1}`,
      difficulty: 'normal',
      complete_flag: 'false',
    })),
  ];
  window.localStorage.setItem('maple-scout-schedule-preferences:member@example.test', JSON.stringify({
    'ocid-1': { bosses: Array.from({ length: 12 }, (_, index) => `removed-boss-${index}::normal`) },
  }));
  const mapleScouterPopup = { location: { href: '' }, close: vi.fn() };
  const extensionChecks = [];
  const extensionStatusOverrides = [];
  vi.spyOn(window, 'open').mockReturnValue(mapleScouterPopup);
  vi.spyOn(window, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'maple-scout/extension-check') return;
    extensionChecks.push(message);
    const statusOverride = extensionStatusOverrides.shift();
    if (statusOverride !== undefined || extensionChecks.length > 1) {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: {
          type: 'maple-scout/extension-status',
          requestId: message.requestId,
          installed: statusOverride ?? true,
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
        weekly_contents: [
          { content_name: '에픽 던전 : 하이마운틴', type: 'contents', registration_flag: 'true', now_count: 0, max_count: 0, quest_state: null },
          { content_name: '에픽 던전 : 아우룸 레기스', type: 'contents', registration_flag: 'false', now_count: 0, max_count: 0, quest_state: null },
          { content_name: '[메이플 유니온] 주간 드래곤 퇴치', type: 'quest', registration_flag: 'false', now_count: 0, max_count: 0, quest_state: '0' },
        ],
        boss_contents: scheduleBosses,
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
  let kalosPartyCount = 0;
  let includeNormalKalingParty = false;
  let groupImageBossId = null;
  let groupMembers = [
    { email: 'member@example.test', name: 'Member', role: 'admin', joinedAt: '2026-10-01T00:00:00.000Z', characterCount: 1, isOwner: true },
    { email: 'teammate@example.test', name: 'Teammate', role: 'member', joinedAt: '2026-10-02T00:00:00.000Z', characterCount: 1, isOwner: false },
  ];
  let committedPartySnapshot = null;
  const assignedCharacters = new Map();
  const groupParties = () => (committedPartySnapshot || Array.from({ length: kalosPartyCount }, (_, index) => ({
    partyId: `party-kalos-${index + 1}`,
    bossId: 'chaos_kalos',
    members: [{
      nickname: '파티원',
      ocid: `ocid-teammate-${index + 1}`,
      ownerSub: `teammate-sub-${index + 1}`,
      ownerEmail: 'teammate@example.test',
      image: null,
      multiplier: 60,
    }],
  }))).concat(includeNormalKalingParty ? [{
    partyId: 'party-normal-kaling',
    bossId: 'normal_kaling',
    members: [{
      nickname: '오잉느',
      ocid: 'ocid-1',
      ownerSub: 'member-sub',
      ownerEmail: 'member@example.test',
      image: syncedCharacters[0].image,
      multiplier: 50,
    }],
  }] : []).map((party) => ({
    ...party,
    members: party.members.map((member) => {
      const ocid = member.ocid;
      return ocid === 'ocid-1'
        ? {
          nickname: '오잉느',
          ocid,
          ownerSub: 'member-sub',
          ownerEmail: 'member@example.test',
          image: syncedCharacters[0].image,
          multiplier: 50,
        }
        : ocid === 'ocid-teammate-roster'
          ? {
            nickname: '그룹동료',
            ocid,
            ownerSub: 'teammate-sub',
            ownerEmail: 'teammate@example.test',
            image: 'https://image.example.test/teammate.png',
            multiplier: 80,
          }
          : { ...member, ownerSub: member.ownerSub || 'teammate-sub', ownerEmail: 'teammate@example.test' };
    }),
  }));
  const groupRoster = () => (groupCharacterAdded ? [
    ...syncedCharacters.slice(0, 2).map((character) => ({
      ...character,
      ownerSub: 'member-sub',
      ownerEmail: 'member@example.test',
      bosses: assignedCharacters.has(character.ocid)
        ? [{ bossId: 'chaos_kalos', familyId: 'kalos', partyId: assignedCharacters.get(character.ocid) }]
        : [],
    })),
    {
    nickname: '그룹동료',
    ocid: 'ocid-teammate-roster',
    worldName: '스카니아',
    characterClass: '비숍',
    level: 293,
    image: 'https://image.example.test/teammate.png',
    boss380HexaScore: 78000,
    ownerSub: 'teammate-sub',
    ownerEmail: 'teammate@example.test',
    scheduler: {
      boss_contents: [{ content_name: '칼로스', difficulty: 'chaos', complete_flag: 'true' }],
    },
    bosses: assignedCharacters.has('ocid-teammate-roster')
      ? [{ bossId: 'chaos_kalos', familyId: 'kalos', partyId: assignedCharacters.get('ocid-teammate-roster') }]
      : [],
    },
  ] : []);
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    const method = init.method || 'GET';
    const request = init.body ? JSON.parse(init.body) : {};
    workerCalls.push({ path, method, init, request });
    if (method === 'POST' && path === '/api/auth/google') {
      return Response.json({
        sessionToken: 'test-access-token',
        account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' },
      });
    }
    if (method === 'POST' && path === '/api/groups/group-1/characters') {
      groupCharacterAdded = true;
      return Response.json({ added: true });
    }
    if (method === 'PATCH' && path === '/api/groups/group-1') {
      groupImageBossId = request.mainImageBossId;
      return Response.json({ id: 'group-1', mainImageBossId: groupImageBossId });
    }
    if (method === 'DELETE' && path === '/api/groups/group-1/members') {
      groupMembers = groupMembers.filter(({ email }) => email !== request.email);
      return Response.json({ email: request.email, removed: true });
    }
    if (method === 'POST' && path === '/api/groups/group-1/parties') {
      kalosPartyCount += 1;
      return Response.json({ partyId: `party-kalos-${kalosPartyCount}`, bossId: request.bossId }, { status: 201 });
    }
    if (method === 'POST' && path.startsWith('/api/groups/group-1/party-characters/')) {
      assignedCharacters.set(path.split('/').at(-1), request.partyId);
      return Response.json({ bossId: 'chaos_kalos', familyId: 'kalos', added: true }, { status: 201 });
    }
    const payload = method === 'PUT' && path.endsWith('/parties/commit')
      ? (() => {
        committedPartySnapshot = request.parties;
        assignedCharacters.clear();
        for (const party of request.parties) {
          for (const member of party.members) assignedCharacters.set(member.ocid, party.partyId);
        }
        kalosPartyCount = request.parties.filter(({ bossId }) => bossId === 'chaos_kalos').length;
        return { saved: true, partyCount: request.parties.length };
      })()
      : method === 'POST' && path === '/api/characters/verify'
      ? {
        characters: [...syncedCharacters].reverse(),
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
          ? { groups: [{ id: 'group-1', name: 'Test group', mainImageBossId: groupImageBossId, role: 'admin' }] }
          : path === '/api/characters'
            ? { characters: [syncedCharacters[0]] }
            : path === '/api/groups/group-1/characters'
              ? { characters: groupRoster() }
              : path === '/api/groups/group-1/members'
                ? { members: groupMembers }
              : path === '/api/groups/group-1/parties'
                ? { parties: groupParties() }
            : path.endsWith('/multipliers')
              ? { multipliers: [
                { nickname: '오잉느', bossId: 'normal_kalos', multiplier: 100 },
                { nickname: '오잉느', bossId: 'chaos_kalos', multiplier: 50 },
                { nickname: '오잉느', bossId: 'hard_blackmage', multiplier: 100 },
                { nickname: '그룹동료', bossId: 'chaos_kalos', multiplier: 80 },
                { nickname: '그룹동료', bossId: 'hard_blackmage', multiplier: 33 },
                { nickname: '오잉느', bossId: 'normal_bardrix', multiplier: 100 },
                { nickname: '오잉느', bossId: 'hard_bardrix', multiplier: 33 },
              ] }
            : path.endsWith('/bosses')
              ? { bossIds: ['normal_kaling'] }
              : { multipliers: [] };
    return Response.json(payload);
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initCodeClient: ({ callback }) => ({
          requestCode: () => callback({ code: 'one-time-auth-code' }),
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
  extensionStatusOverrides.push(true);
  fireEvent.click(screen.getByRole('button', { name: '캐릭터 불러오기' }));
  await waitFor(() => expect(document.querySelector('.notice[role="status"]').textContent).toContain('4개 캐릭터 정보를 동기화했습니다.'));
  let previousMapleScouterUrl = '';
  for (let index = 0; index < syncedCharacters.length; index += 1) {
    await waitFor(() => {
      expect(mapleScouterPopup.location.href).toContain('/ko/result?name=');
      expect(mapleScouterPopup.location.href).not.toBe(previousMapleScouterUrl);
    });
    previousMapleScouterUrl = mapleScouterPopup.location.href;
    const nickname = new URL(previousMapleScouterUrl).searchParams.get('name');
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://maplescouter.com',
      source: mapleScouterPopup,
      data: {
        type: 'maple-scout/maplescouter-import',
        payload: {
          nickname,
          boss380HexaScore: syncedCharacters.find((character) => character.nickname === nickname).boss380HexaScore,
          multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }],
        },
      },
    }));
  }
  await screen.findByText(/실사용 캐릭터 4\/4명 동기화 완료/);
  const importCountAfterCharacterLoad = workerCalls.filter(({ method, path }) => (
    method === 'POST' && path === '/api/characters/maplescouter-import'
  )).length;
  expect(importCountAfterCharacterLoad).toBe(4);
  expect(screen.queryByText(/숨길캐릭터/)).toBeNull();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 아잉느 Lv. 280' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 최고레벨 Lv. 285' })).toBeDefined();
  expect(screen.getByRole('checkbox', { name: '실사용 캐릭터 세번째 Lv. 275' })).toBeDefined();

  const syncCall = workerCalls.find(({ method, path }) => method === 'POST' && path === '/api/characters/verify');
  expect(syncCall.request).toEqual({ apiKey: 'test-nexon-key' });
  expect(screen.getByLabelText('Nexon Open API 키').value).toBe('test-nexon-key');

  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 아잉느 Lv. 280' }));
  expect(window.localStorage.getItem('maple-scout-active-characters:member@example.test'))
    .toBe(JSON.stringify(['ocid-1', 'ocid-2']));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path === '/api/characters/selection').at(-1).request.ocids)
    .toEqual(['ocid-1', 'ocid-2']));
  fireEvent.click(screen.getByTitle('내 정보'));
  expect(screen.queryByRole('heading', { name: '실사용 캐릭터 2' })).toBeNull();
  expect(screen.queryByRole('searchbox', { name: '캐릭터 검색' })).toBeNull();
  expect(document.querySelector('.my-schedule-section')).toBeNull();
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.getByRole('button', { name: /아잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /최고레벨/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /세번째/ })).toBeNull();
  expect(screen.getByText('72,807')).toBeDefined();
  const ownActiveCharacterWrap = screen.getByRole('button', { name: /오잉느/ }).closest('.character-card-wrap');
  expect([...ownActiveCharacterWrap.children].map((child) => child.className)).toEqual([
    expect.stringContaining('character-card'),
    'character-card-side-info',
  ]);
  expect([...ownActiveCharacterWrap.querySelector('.character-card-side-info').children]
    .map((child) => child.className))
    .toEqual(['character-party-column', 'character-solo-column']);
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .toContain('카오스 감시자 칼로스');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .toContain('2인격 가능');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning button')).toBeNull();
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .not.toContain('검은 마법사');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning img')).not.toBeNull();
  expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull();
  const blackMageSoloRecommendation = ownActiveCharacterWrap.querySelector(
    '.character-solo-recommendation[data-boss-id="hard_blackmage"]',
  );
  expect(blackMageSoloRecommendation.textContent).toContain('하드 검은 마법사');
  expect(blackMageSoloRecommendation.textContent).toContain('100.0%');
  expect(blackMageSoloRecommendation.querySelector('.character-recommendation-clear').textContent).toBe('클리어');
  const secondActiveCharacterWrap = screen.getByRole('button', { name: /아잉느/ }).closest('.character-card-wrap');
  const assumedSoloRecommendation = secondActiveCharacterWrap.querySelector('.character-solo-recommendation');
  expect(assumedSoloRecommendation.textContent).toContain('배율 미기록');
  expect(assumedSoloRecommendation.querySelector('.character-recommendation-clear').textContent).toBe('미클리어');

  fireEvent.change(screen.getByRole('combobox', { name: '월드 필터' }), { target: { value: '스카니아' } });
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /아잉느/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));

  fireEvent.click(screen.getByRole('button', { name: /아잉느/ }));
  fireEvent.click(screen.getByTitle('Test group'));
  expect(screen.queryByText('일일 퀘스트')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /인원 관리/ }));
  expect(screen.getByRole('heading', { name: 'Test group 인원 관리' })).toBeDefined();
  expect(screen.getByText('teammate@example.test')).toBeDefined();
  expect(screen.getByText('그룹장')).toBeDefined();
  expect(screen.getByText('내 계정')).toBeDefined();
  const teammateMemberCard = screen.getByText('teammate@example.test').closest('.group-member-card');
  fireEvent.click(within(teammateMemberCard).getByRole('button', { name: '멤버 제거' }));
  expect(within(teammateMemberCard).getByRole('alert').textContent).toContain('파티 편성도 함께 제거');
  fireEvent.click(within(teammateMemberCard).getByRole('button', { name: '취소' }));
  expect(workerCalls.some(({ method, path }) => method === 'DELETE' && path.endsWith('/members'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '← 그룹 메인으로' }));
  fireEvent.click(screen.getByRole('button', { name: '그룹 설정' }));
  expect(screen.queryByRole('heading', { name: '보스를 고르고 파티를 편성하세요' })).toBeNull();
  const settingsSections = [...document.querySelector('.group-management-view').children];
  expect(settingsSections.findIndex((section) => section.classList.contains('group-character-picker')))
    .toBeLessThan(settingsSections.findIndex((section) => section.classList.contains('group-invite-section')));
  expect(settingsSections.at(-1).classList.contains('group-danger-zone')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '칼로스 아이콘으로 설정' }));
  await waitFor(() => expect(groupImageBossId).toBe('extreme_kalos'));
  await waitFor(() => expect(screen.getByTitle('Test group').querySelector('.group-avatar img')).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '그룹 삭제' }));
  expect(screen.getByRole('alert').textContent).toContain('정말 삭제할까요?');
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '취소' }));
  expect(workerCalls.some(({ method, path }) => method === 'DELETE' && path === '/api/groups/group-1')).toBe(false);
  const ownGroupCharacterCard = [...document.querySelectorAll('.group-add-character')]
    .find((card) => card.querySelector('strong').textContent === '오잉느');
  const addOwnCharacterButton = ownGroupCharacterCard.querySelector('button');
  expect(addOwnCharacterButton.textContent).toContain('참여');
  fireEvent.click(addOwnCharacterButton);
  await waitFor(() => expect(ownGroupCharacterCard.querySelector('button').textContent).toContain('제거'));
  fireEvent.click(screen.getByTitle('계정 설정'));
  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' }));
  await waitFor(() => expect(window.localStorage.getItem('maple-scout-active-characters:member@example.test'))
    .toBe(JSON.stringify(['ocid-2'])));
  fireEvent.click(screen.getByTitle('Test group'));
  await screen.findByRole('button', { name: '그룹 설정' });
  fireEvent.click(screen.getByRole('button', { name: '그룹 설정' }));
  const unselectedJoinedCharacter = [...document.querySelectorAll('.group-add-character')]
    .find((card) => card.querySelector('strong').textContent === '오잉느');
  expect(unselectedJoinedCharacter.querySelector('button').textContent).toContain('제거');
  expect([...document.querySelectorAll('.group-add-character')].some((card) => (
    card.querySelector('strong').textContent === '최고레벨'
  ))).toBe(false);
  fireEvent.click(screen.getByTitle('계정 설정'));
  fireEvent.click(screen.getByRole('checkbox', { name: '실사용 캐릭터 오잉느 Lv. 291' }));
  await waitFor(() => expect(window.localStorage.getItem('maple-scout-active-characters:member@example.test'))
    .toBe(JSON.stringify(['ocid-2', 'ocid-1'])));
  fireEvent.click(screen.getByTitle('Test group'));
  await screen.findByRole('button', { name: '그룹 설정' });
  fireEvent.click(screen.getByRole('button', { name: '그룹 설정' }));
  fireEvent.click(screen.getByRole('button', { name: '← 그룹 메인으로' }));
  const groupBossQuickMenu = document.querySelector('.group-boss-quick-menu');
  expect(groupBossQuickMenu).not.toBeNull();
  expect(groupBossQuickMenu.previousElementSibling.classList.contains('server-rail')).toBe(true);
  expect(groupBossQuickMenu.nextElementSibling.classList.contains('app-main')).toBe(true);
  expect(groupBossQuickMenu.closest('.group-quick-party-builder')).toBeNull();
  expect(document.querySelector('.group-quick-party-builder .group-boss-family-list')).toBeNull();
  const bossMenuToggle = screen.getByRole('button', { name: '보스 빠른 메뉴 접기' });
  expect(bossMenuToggle.querySelector('svg').dataset.direction).toBe('left');
  fireEvent.click(bossMenuToggle);
  expect(groupBossQuickMenu.classList.contains('collapsed')).toBe(true);
  const expandBossMenuToggle = screen.getByRole('button', { name: '보스 빠른 메뉴 펼치기' });
  expect(expandBossMenuToggle.querySelector('svg').dataset.direction).toBe('right');
  fireEvent.click(expandBossMenuToggle);
  const groupCharacterQuickMenu = document.querySelector('.group-character-quick-menu');
  expect(groupCharacterQuickMenu).not.toBeNull();
  expect(groupCharacterQuickMenu.previousElementSibling.classList.contains('app-main')).toBe(true);
  expect(groupCharacterQuickMenu.parentElement.classList.contains('app-shell')).toBe(true);
  const characterMenuToggle = screen.getByRole('button', { name: '캐릭터 빠른 메뉴 접기' });
  expect(characterMenuToggle.querySelector('svg').dataset.direction).toBe('right');
  fireEvent.click(characterMenuToggle);
  expect(groupCharacterQuickMenu.classList.contains('collapsed')).toBe(true);
  const expandCharacterMenuToggle = screen.getByRole('button', { name: '캐릭터 빠른 메뉴 펼치기' });
  expect(expandCharacterMenuToggle.querySelector('svg').dataset.direction).toBe('left');
  fireEvent.click(expandCharacterMenuToggle);
  const kalosDifficultyButton = screen.getByRole('button', { name: /카오스 감시자 칼로스 파티 편성/ });
  expect(kalosDifficultyButton.textContent).toContain('C');
  fireEvent.click(kalosDifficultyButton);
  const inlineKalosEditor = document.querySelector('.group-quick-party-editor');
  expect(inlineKalosEditor).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.group-main-party-overview')).not.toBeNull();
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  expect(screen.queryByRole('group', { name: '파티 보기 방식' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '빈 파티' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '빈 파티' }));
  const initialGroupmateQuickCard = [...groupCharacterQuickMenu.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details strong').textContent === '그룹동료');
  expect(initialGroupmateQuickCard.querySelector('.group-character-quick-details b').textContent).toBe('80.0%');
  const groupmateWarningTrigger = within(initialGroupmateQuickCard)
    .getByRole('button', { name: '그룹동료 그룹 파티 편성 필요 안내' });
  expect(groupmateWarningTrigger.title).toBe('그룹 파티 편성 필요');
  fireEvent.click(groupmateWarningTrigger, { clientX: 180, clientY: 220 });
  const groupmateWarningPopup = screen.getByRole('dialog', { name: '그룹동료 그룹 파티 편성 필요' });
  expect(groupmateWarningPopup.textContent)
    .toContain('검은 마법사');
  expect(groupmateWarningPopup.textContent)
    .not.toContain('감시자 칼로스');
  expect(groupmateWarningPopup.style.left).toBe('188px');
  expect(groupmateWarningPopup.style.top).toBe('228px');
  fireEvent.click(groupmateWarningTrigger);
  expect(screen.queryByRole('dialog', { name: '그룹동료 그룹 파티 편성 필요' })).toBeNull();
  const firstEmptyPartyCommitCount = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).length;
  fireEvent.click(screen.getByRole('button', { name: '완료 · 변경 저장' }));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(firstEmptyPartyCommitCount + 1));
  await waitFor(() => expect(document.querySelector('.notice[role="status"]').textContent).toContain('파티 편성 변경을 모두 저장했습니다.'));
  expect(within(initialGroupmateQuickCard)
    .getByRole('button', { name: '그룹동료 그룹 파티 편성 필요 안내' })).toBeDefined();
  expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))[0]
    .request.parties.find(({ bossId }) => bossId === 'chaos_kalos').members).toEqual([]);

  fireEvent.click(kalosDifficultyButton);
  const partyEditor = document.querySelector('.group-quick-party-editor');
  expect(partyEditor).not.toBeNull();
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(2);
  const commitCountBeforeDraft = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).length;
  const groupmateQuickCard = [...groupCharacterQuickMenu.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details strong').textContent === '그룹동료');
  expect(groupmateQuickCard.querySelector('.group-character-quick-details b').textContent).toBe('80.0%');
  const partyMutationCountBeforeDraft = workerCalls.filter(({ method, path }) => (
    ['POST', 'PUT', 'DELETE'].includes(method)
      && (path.endsWith('/parties') || path.includes('/party-characters/'))
  )).length;
  expect(within(groupmateQuickCard).queryByRole('button', { name: '파티에 추가' })).toBeNull();
  expect(assignedCharacters.has('ocid-teammate-roster')).toBe(false);
  const dragData = {
    value: '',
    setData(_type, value) { this.value = value; },
    getData() { return this.value; },
  };
  fireEvent.dragStart(groupmateQuickCard, { dataTransfer: dragData });
  fireEvent.drop(document.querySelector('.group-main-party-card.focused'), { dataTransfer: dragData });
  expect(assignedCharacters.has('ocid-teammate-roster')).toBe(false);
  const ownCharacterQuickCard = [...groupCharacterQuickMenu.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details strong').textContent === '오잉느');
  expect(ownCharacterQuickCard).toBeDefined();
  fireEvent.dragStart(ownCharacterQuickCard, { dataTransfer: dragData });
  fireEvent.drop(document.querySelector('.group-main-party-card.focused'), { dataTransfer: dragData });
  expect(assignedCharacters.has('ocid-1')).toBe(false);
  expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(commitCountBeforeDraft);
  expect(workerCalls.filter(({ method, path }) => (
    ['POST', 'PUT', 'DELETE'].includes(method)
      && (path.endsWith('/parties') || path.includes('/party-characters/'))
  )  )).toHaveLength(partyMutationCountBeforeDraft);
  fireEvent.click(screen.getByRole('button', { name: '완료 · 변경 저장' }));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(commitCountBeforeDraft + 1));
  await waitFor(() => expect(document.querySelector('.notice[role="status"]').textContent).toContain('파티 편성 변경을 모두 저장했습니다.'));
  expect(assignedCharacters.get('ocid-1')).toBeDefined();
  const commitRequest = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).at(-1);
  const committedKalosParties = commitRequest.request.parties.filter(({ bossId }) => bossId === 'chaos_kalos');
  expect(committedKalosParties.flatMap(({ members }) => members)).toEqual(expect.arrayContaining([
    expect.objectContaining({ ocid: 'ocid-teammate-roster' }),
    expect.objectContaining({ ocid: 'ocid-1' }),
  ]));
  await waitFor(() => expect(groupCharacterQuickMenu.querySelectorAll('.group-character-quick-card.already-assigned')).toHaveLength(2));
  const quickCharacterCards = [...groupCharacterQuickMenu.querySelectorAll('.group-character-quick-card')];
  const assignedQuickCharacterCards = quickCharacterCards.filter((card) => card.classList.contains('already-assigned'));
  expect(assignedQuickCharacterCards.every((card) => (
    card.querySelector('.group-character-quick-assignment-note').textContent === '편성됨'
  ))).toBe(true);
  const groupedQuickCards = [...groupCharacterQuickMenu.querySelectorAll('.group-character-owner-grid .group-character-quick-card')];
  expect(groupedQuickCards).toHaveLength(quickCharacterCards.length);
  expect(groupedQuickCards.some((card) => card.querySelector('.group-party-warning-trigger'))).toBe(true);
  const ownerGroups = [...groupCharacterQuickMenu.querySelectorAll('.group-character-owner-group')];
  expect(ownerGroups[0].querySelector('h3').textContent).toBe('Member');
  const ownOwnerCards = [...ownerGroups[0].querySelectorAll('.group-character-quick-card')];
  const ownAssignedCardIndex = ownOwnerCards.findIndex((card) => card.classList.contains('already-assigned'));
  const ownUnassignedCardIndex = ownOwnerCards.findIndex((card) => !card.classList.contains('already-assigned'));
  expect(ownAssignedCardIndex).toBeGreaterThan(ownUnassignedCardIndex);
  const ownAssignedQuickCard = quickCharacterCards.find((card) => (
    card.querySelector('.group-character-quick-details > strong').textContent === '오잉느'
  ));
  expect(ownAssignedQuickCard.draggable).toBe(false);
  expect(within(ownAssignedQuickCard).queryByRole('button', { name: '오잉느 파티 편성 제외' })).toBeNull();
  const ownAssignedPartyMember = [...document.querySelectorAll('.party-overview-member')]
    .find((member) => member.querySelector('span').textContent === '오잉느');
  expect(ownAssignedPartyMember.draggable).toBe(true);
  const removeOwnAssignmentButton = within(ownAssignedPartyMember)
    .getByRole('button', { name: '오잉느 파티 편성 제외' });
  fireEvent.click(removeOwnAssignmentButton);
  expect(screen.getByRole('status').textContent).toContain('편성 변경을 임시 저장했습니다');
  fireEvent.click(screen.getByRole('button', { name: '변경 취소' }));
  const assignedPartyMemberForMenuDrop = [...document.querySelectorAll('.party-overview-member')]
    .find((member) => member.querySelector('span').textContent === '오잉느');
  fireEvent.dragStart(assignedPartyMemberForMenuDrop, { dataTransfer: dragData });
  fireEvent.drop(groupCharacterQuickMenu, { dataTransfer: dragData });
  expect(screen.getByRole('status').textContent).toContain('편성 변경을 임시 저장했습니다');
  fireEvent.click(screen.getByRole('button', { name: '변경 취소' }));
  const assignedPartyMemberForBlankDrop = [...document.querySelectorAll('.party-overview-member')]
    .find((member) => member.querySelector('span').textContent === '오잉느');
  fireEvent.dragStart(assignedPartyMemberForBlankDrop, { dataTransfer: dragData });
  fireEvent.drop(document.querySelector('.group-main-party-overview-heading'), { dataTransfer: dragData });
  expect(screen.getByRole('status').textContent).toContain('편성 변경을 임시 저장했습니다');
  fireEvent.click(screen.getByRole('button', { name: '변경 취소' }));
  const sameAccountCharacterCard = quickCharacterCards.find((card) => (
    card.querySelector('.group-character-quick-details > strong').textContent === '아잉느'
  ));
  const sameAccountStatusRow = sameAccountCharacterCard.querySelector('.group-character-quick-statuses');
  expect(sameAccountStatusRow).not.toBeNull();
  expect(sameAccountStatusRow.querySelector('.group-character-quick-recommendation')).not.toBeNull();
  expect(sameAccountStatusRow.querySelector('.group-character-quick-assignment-note').textContent).toBe('편성됨');
  expect(sameAccountStatusRow.children).toHaveLength(2);
  expect(sameAccountCharacterCard.querySelector('button')).toBeNull();
  await waitFor(() => expect([...document.querySelectorAll('.group-main-party-card')]
    .some((card) => card.textContent.includes('오잉느') && card.querySelector('.party-summary strong'))).toBe(true));
  fireEvent.click(screen.getByTitle('Test group'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByTitle('내 정보'));
  const ownActiveCharacterButton = screen.getAllByRole('button', { name: /오잉느/ })
    .find((button) => button.classList.contains('character-card'));
  const ownActiveCharacterWrapAfterAssignment = ownActiveCharacterButton.closest('.character-card-wrap');
  await waitFor(() => expect(ownActiveCharacterWrapAfterAssignment.querySelector('.unassigned-party-warning').textContent)
    .not.toContain('카오스 감시자 칼로스'));
  expect(ownActiveCharacterWrapAfterAssignment.querySelector('.unassigned-party-warning').textContent).toContain('3인격 가능');
  expect(ownActiveCharacterWrapAfterAssignment.querySelector('.character-party-link').textContent)
    .toContain('Test group · 카오스 감시자 칼로스');
  const partyRecommendationDetails = ownActiveCharacterWrapAfterAssignment.querySelector('.character-party-link-details');
  expect(partyRecommendationDetails.textContent).toContain('50.0%');
  expect(partyRecommendationDetails.textContent).toContain('2인격 가능');
  expect(partyRecommendationDetails.textContent).toContain('미클리어');
  expect(screen.getByRole('button', { name: '실사용 2명 전체 갱신' })).toBeDefined();
  expect(screen.queryByText('보스380 헥사환산 기준으로 정렬')).toBeNull();
  fireEvent.click(screen.getByTitle('Test group'));
  await screen.findByRole('heading', { name: '파티 빠른 편성' });
  expect(document.querySelector('.party-header')).toBeNull();
  expect(document.querySelector('.group-main-actions')).toBeNull();
  expect(screen.queryByRole('button', { name: '실사용 2명 전체 갱신' })).toBeNull();
  expect(document.querySelector('.group-boss-quick-navigation')).not.toBeNull();
  expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '새 파티 보스' })).toBeNull();
  const kalosDifficultyButtons = [...document.querySelectorAll('.group-boss-family-option')]
    .find((family) => family.querySelector('strong').textContent === '칼로스')
    .querySelectorAll('.group-boss-difficulty');
  expect([...kalosDifficultyButtons].map((button) => button.title.split(' ')[0]))
    .toEqual(['익스트림', '카오스', '노말', '이지']);
  expect(kalosDifficultyButtons[0].textContent.trim()).toBe('E');
  expect(kalosDifficultyButtons[0].classList.contains('difficulty-extreme')).toBe(true);
  const populatedKalosParty = [...document.querySelectorAll('.group-main-party-card')]
    .find((card) => card.textContent.includes('그룹동료'));
  expect(populatedKalosParty.classList.contains('boss-cleared')).toBe(true);
  expect(populatedKalosParty.querySelector('.party-clear-status').textContent).toBe('클리어');
  expect(populatedKalosParty.querySelector('.party-overview-member').textContent).toContain('80.0%');
  const defaultPartyCards = [...document.querySelectorAll('.group-main-party-card')];
  expect(defaultPartyCards.at(-1).classList.contains('boss-cleared')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '미클 파티만 보기' }));
  expect(document.querySelectorAll('.group-main-party-card').length).toBeGreaterThan(0);
  expect([...document.querySelectorAll('.group-main-party-card')]
    .every((card) => !card.classList.contains('boss-cleared'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '미클 파티만 보기' }));
  fireEvent.click(screen.getByRole('button', { name: '내 캐릭터 파티' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  expect(document.querySelector('.group-main-party-card').textContent).toContain('오잉느');
  fireEvent.click(screen.getByRole('button', { name: '빈 파티' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(2);
  expect(document.querySelector('.party-overview-filter-hint').textContent).toContain('함께 표시');
  fireEvent.click(screen.getByRole('button', { name: '내 캐릭터 파티' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  expect(document.querySelector('.group-main-party-card').textContent).toContain('빈 파티');
  fireEvent.click(screen.getByRole('button', { name: '빈 파티' }));
  const partySearch = screen.getByRole('searchbox', { name: '보스 또는 캐릭터 검색' });
  fireEvent.change(partySearch, { target: { value: '그룹동료' } });
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  expect(document.querySelector('.group-main-party-card').textContent).toContain('그룹동료');
  fireEvent.change(partySearch, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '배율 100% 미달' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(1);
  expect(document.querySelector('.group-main-party-card').textContent).toContain('빈 파티');
  fireEvent.click(screen.getByRole('button', { name: '배율 100% 미달' }));
  fireEvent.change(screen.getByLabelText('정렬'), { target: { value: 'multiplier-asc' } });
  expect(document.querySelector('.group-main-party-card').textContent).toContain('빈 파티');
  fireEvent.change(screen.getByLabelText('정렬'), { target: { value: 'default' } });
  const populatedKalosPartyAfterFiltering = [...document.querySelectorAll('.group-main-party-card')]
    .find((card) => card.textContent.includes('그룹동료'));
  fireEvent.click(populatedKalosPartyAfterFiltering);
  const inlinePartyEditor = document.querySelector('.group-quick-party-editor');
  expect(inlinePartyEditor).not.toBeNull();
  expect(document.querySelectorAll('.group-character-quick-card').length).toBeGreaterThan(0);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.group-main-party-open')).toBeNull();
  const partyMultiplier = populatedKalosPartyAfterFiltering.querySelector('.party-summary strong').textContent;
  expect(Number(populatedKalosPartyAfterFiltering.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')))
    .toBe(Math.min(100, Math.max(0, Number.parseFloat(partyMultiplier))));
  const updatedGroupCharacterQuickMenu = document.querySelector('.group-character-quick-menu');
  expect(updatedGroupCharacterQuickMenu.querySelector('header h2').textContent).toBe('감시자 칼로스 배율순');
  const kalosQuickCharacter = [...updatedGroupCharacterQuickMenu.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details strong').textContent === '그룹동료');
  expect(kalosQuickCharacter.querySelector('.group-character-quick-details b').textContent).toBe('80.0%');
  expect(kalosQuickCharacter.querySelector('.group-character-quick-recommendation').textContent).toBe('2인격 가능');
  fireEvent.click(kalosQuickCharacter);
  expect(document.querySelector('.group-character-quick-card.selected-for-boss-highlights')).not.toBeNull();
  expect(screen.getByRole('button', { name: /카오스 감시자 칼로스 파티 편성/ })
    .querySelector('.difficulty-star').textContent).toBe('★');
  fireEvent.click([...document.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details strong').textContent === '그룹동료'));
  expect(screen.getByRole('button', { name: /카오스 감시자 칼로스 파티 편성/ })
    .querySelector('.difficulty-star')).toBeNull();
  const partyCountBeforeDelete = document.querySelectorAll('.group-main-party-card').length;
  const partyCommitCountBeforeDelete = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).length;
  fireEvent.click(within(populatedKalosPartyAfterFiltering).getByRole('button', { name: /번째 파티 편성 닫기/ }));
  expect(document.querySelector('.group-quick-party-editor')).toBeNull();
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(partyCountBeforeDelete);
  let partyCardForRemoval = [...document.querySelectorAll('.group-main-party-card')]
    .find((card) => card.textContent.includes('그룹동료'));
  fireEvent.click(within(partyCardForRemoval).getByRole('button', { name: /번째 파티 삭제/ }));
  expect(screen.getByRole('dialog', { name: '파티를 삭제할까요?' })).not.toBeNull();
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(partyCountBeforeDelete);
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  partyCardForRemoval = [...document.querySelectorAll('.group-main-party-card')]
    .find((card) => card.textContent.includes('그룹동료'));
  fireEvent.click(within(partyCardForRemoval).getByRole('button', { name: /번째 파티 삭제/ }));
  fireEvent.click(screen.getByRole('button', { name: '파티 삭제' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(partyCountBeforeDelete - 1);
  expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(partyCommitCountBeforeDelete);
  fireEvent.click(screen.getByRole('button', { name: '변경 취소' }));
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(partyCountBeforeDelete);

  fireEvent.click(screen.getByRole('button', { name: /노말 발드릭스 파티 편성/ }));
  expect(document.querySelector('.group-quick-party-editor')).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  const commitsBeforeEmptyParty = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).length;
  fireEvent.click(screen.getByRole('button', { name: '완료 · 변경 저장' }));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(commitsBeforeEmptyParty + 1));
  await waitFor(() => expect(document.querySelector('.notice[role="status"]').textContent).toContain('파티 편성 변경을 모두 저장했습니다.'));
  const emptyPartyCommit = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).at(-1);
  const emptyBardrixParty = emptyPartyCommit.request.parties.find(({ bossId }) => bossId === 'normal_bardrix');
  expect(emptyBardrixParty.members).toEqual([]);

  const teammateQuickCard = [...document.querySelectorAll('.group-character-quick-card')]
    .find((card) => card.querySelector('.group-character-quick-details > strong').textContent === '그룹동료');
  fireEvent.click(within(teammateQuickCard).getByRole('button', {
    name: '그룹동료 그룹 파티 편성 필요 안내',
  }));
  const blackMageRecommendationButton = screen.getByRole('button', {
    name: '하드 검은 마법사 그룹 파티 추가',
  });
  const partyCardsBeforeQuickAdd = document.querySelectorAll('.group-main-party-card').length;
  fireEvent.click(blackMageRecommendationButton);
  expect(document.querySelectorAll('.group-main-party-card')).toHaveLength(partyCardsBeforeQuickAdd + 1);
  const quickAddedBlackMageParty = [...document.querySelectorAll('.group-main-party-card')].find((card) => (
    card.textContent.includes('검은 마법사')
      && card.querySelector('.party-difficulty-mark')?.title === '하드'
  ));
  expect(quickAddedBlackMageParty).toBeDefined();
  expect(quickAddedBlackMageParty.querySelector('.group-main-party-members').textContent).toContain('그룹동료');
  fireEvent.click(screen.getByRole('button', { name: '변경 취소' }));

  fireEvent.click(screen.getByTitle('내 정보'));
  extensionStatusOverrides.push(false);
  fireEvent.click(await screen.findByRole('button', { name: '실사용 2명 전체 갱신' }));
  expect(window.open).toHaveBeenNthCalledWith(1, 'about:blank', '_blank');
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => (
    method === 'POST' && path === '/api/characters/verify'
  ))).toHaveLength(2));
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 650)));
  expect(screen.getByRole('alert').textContent).toContain('MemoFam Reader 설치');
  expect(screen.getByText(/압축해제된 확장 프로그램을 로드/)).toBeDefined();
  const extensionDownload = screen.getByRole('link', { name: 'MemoFam Reader 다운로드' });
  expect(extensionDownload.getAttribute('href')).toBe('/memofam-maplescouter-reader.zip');
  expect(extensionDownload.hasAttribute('download')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Chrome 확장 프로그램 열기' }));
  expect(await screen.findByText(/브라우저 보안 정책상 웹페이지에서 확장 프로그램 페이지를 직접 열 수 없습니다/)).toBeDefined();
  expect(mapleScouterPopup.close).toHaveBeenCalledTimes(2);

  await act(async () => {
    extensionStatusOverrides.push(true);
    fireEvent.click(screen.getByRole('button', { name: '실사용 2명 전체 갱신' }));
    await Promise.resolve();
  });
  expect(window.open).toHaveBeenNthCalledWith(3, 'about:blank', '_blank');
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
  expect(workerCalls.filter(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-import'))
    .toHaveLength(importCountAfterCharacterLoad);
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
  const refreshNotice = await screen.findByText(/실사용 캐릭터 2\/2명 동기화 완료/);
  expect(refreshNotice.textContent).toContain('스케줄 4개 캐릭터 동기화 완료');
  expect(screen.queryByLabelText('북마클릿 주소')).toBeNull();
  expect(mapleScouterPopup.close).toHaveBeenCalledTimes(3);

  const importCalls = workerCalls.filter(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-import').slice(-2);
  expect(importCalls.map(({ request }) => request)).toEqual([
    { nickname: '오잉느', boss380HexaScore: 67619, multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }] },
    { nickname: '아잉느', boss380HexaScore: 70000, multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }] },
  ]);
  expect(new Headers(importCalls[0].init.headers).get('Authorization')).toBe('Bearer test-access-token');
  expect(workerCalls.some(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-scores')).toBe(false);

  syncedCharacters[0].scheduler.boss_contents.push({
    content_name: '카링',
    difficulty: 'easy',
    complete_flag: 'true',
  });
  includeNormalKalingParty = true;
  fireEvent.click(screen.getByTitle('Test group'));
  await screen.findByRole('heading', { name: '파티 빠른 편성' });
  extensionStatusOverrides.push(false);
  fireEvent.click(screen.getByRole('button', { name: '내 캐릭터 배율 및 스케줄 동기화' }));
  await screen.findByText(/스케줄 4개 캐릭터 동기화 완료/);
  const normalKalingParty = [...document.querySelectorAll('.group-main-party-card')]
    .find((card) => card.id === 'group-party-party-normal-kaling');
  expect(normalKalingParty.classList.contains('boss-cleared')).toBe(true);
  expect(normalKalingParty.querySelector('.party-clear-status').textContent).toBe('클리어');
  expect(workerCalls.filter(({ method, path }) => (
    method === 'POST' && path === '/api/characters/verify'
  ))).toHaveLength(4);
});

test('hides group image and deletion settings from non-admin members', async () => {
  vi.stubGlobal('fetch', async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/auth/google') {
      return Response.json({
        sessionToken: 'member-session-token',
        account: { email: 'member@example.test', name: 'Member', sub: 'member-sub' },
      });
    }
    if (path === '/api/groups') {
      return Response.json({ groups: [{ id: 'group-1', name: 'Member group', role: 'member' }] });
    }
    return Response.json({});
  });
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initCodeClient: ({ callback }) => ({
          requestCode: () => callback({ code: 'one-time-auth-code' }),
        }),
      },
    },
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Google 계정으로 계속/i }));
  await screen.findByText('member@example.test');
  fireEvent.click(screen.getByTitle('Member group'));
  await screen.findByRole('heading', { level: 1, name: 'Member group' });
  fireEvent.click(screen.getByRole('button', { name: '그룹 설정' }));

  expect(screen.queryByRole('heading', { name: '그룹 대표 이미지' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '그룹 삭제' })).toBeNull();
  expect(screen.queryByRole('button', { name: '그룹 삭제' })).toBeNull();
});
