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
    ...Array.from({ length: 12 }, (_, index) => ({
      content_name: `테스트 보스 ${index + 1}`,
      difficulty: 'normal',
      complete_flag: 'false',
    })),
  ];
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
  }))).map((party) => ({
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
  const groupRoster = () => (groupCharacterAdded ? [{
    ...syncedCharacters[0],
    ownerSub: 'member-sub',
    ownerEmail: 'member@example.test',
    bosses: assignedCharacters.has('ocid-1')
      ? [{ bossId: 'chaos_kalos', familyId: 'kalos', partyId: assignedCharacters.get('ocid-1') }]
      : [],
  }, {
    nickname: '그룹동료',
    ocid: 'ocid-teammate-roster',
    worldName: '스카니아',
    characterClass: '비숍',
    level: 293,
    image: 'https://image.example.test/teammate.png',
    boss380HexaScore: 78000,
    ownerSub: 'teammate-sub',
    ownerEmail: 'teammate@example.test',
    scheduler: {},
    bosses: assignedCharacters.has('ocid-teammate-roster')
      ? [{ bossId: 'chaos_kalos', familyId: 'kalos', partyId: assignedCharacters.get('ocid-teammate-roster') }]
      : [],
  }] : []);
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
  expect(screen.queryByRole('heading', { name: '실사용 캐릭터 2' })).toBeNull();
  expect(screen.queryByRole('searchbox', { name: '캐릭터 검색' })).toBeNull();
  expect([...document.querySelectorAll('.my-schedule-character-heading strong')]
    .map(({ textContent }) => textContent))
    .toEqual(['오잉느', '아잉느']);
  expect(document.querySelector('.my-schedule-character-art img')).not.toBeNull();
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.getByRole('button', { name: /아잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /최고레벨/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /세번째/ })).toBeNull();
  expect(screen.getByText('72,807')).toBeDefined();
  const ownActiveCharacterWrap = screen.getByRole('button', { name: /오잉느/ }).closest('.character-card-wrap');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .toContain('카오스 감시자 칼로스');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .toContain('2인 추천');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning').textContent)
    .not.toContain('검은 마법사');
  expect(ownActiveCharacterWrap.querySelector('.unassigned-party-warning img')).not.toBeNull();

  fireEvent.change(screen.getByRole('combobox', { name: '월드 필터' }), { target: { value: '스카니아' } });
  expect(screen.getByRole('button', { name: /오잉느/ })).toBeDefined();
  expect(screen.queryByRole('button', { name: /아잉느/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));

  fireEvent.click(screen.getAllByText(/^주간 보스 0\/12/)[0]);
  fireEvent.click(screen.getByRole('checkbox', { name: '오잉느 보스 일정 하드 검은 마법사 표시' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '오잉느 보스 일정 카오스 감시자 칼로스 표시' }));
  const normalKalosSchedule = screen.getByRole('checkbox', { name: '오잉느 보스 일정 노말 감시자 칼로스 표시' });
  expect(normalKalosSchedule.disabled).toBe(false);
  fireEvent.click(normalKalosSchedule);
  expect(normalKalosSchedule.checked).toBe(true);
  expect(screen.getByRole('checkbox', { name: '오잉느 보스 일정 카오스 감시자 칼로스 표시' }).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: '오잉느 보스 일정 카오스 감시자 칼로스 표시' }));
  for (let index = 1; index <= 11; index += 1) {
    fireEvent.click(screen.getByRole('checkbox', { name: `오잉느 보스 일정 노말 테스트 보스 ${index} 표시` }));
  }
  expect(JSON.parse(window.localStorage.getItem('maple-scout-schedule-preferences:member@example.test')))
    .toEqual({ 'ocid-1': { bosses: expect.arrayContaining(['blackmage::hard', 'kalos::chaos']) } });
  expect([...document.querySelectorAll('.schedule-boss-picker summary')]
    .map(({ textContent }) => textContent)
    .filter((text) => text.startsWith('주간 보스')))
    .toEqual(['주간 보스 12/12 · 월간 1종', '주간 보스 0/12 · 월간 0종']);
  expect(screen.getByRole('checkbox', { name: '오잉느 보스 일정 노말 테스트 보스 12 표시' }).disabled).toBe(true);
  const completedBossCard = screen.getByText('검은 마법사', { selector: '.boss-card.completed strong' }).closest('.boss-card');
  expect(completedBossCard.textContent).toContain('하드');
  expect(completedBossCard.textContent).not.toContain('완료');
  expect(screen.getByText('감시자 칼로스', { selector: '.boss-card.pending strong' }).closest('.boss-card').textContent).toContain('카오스');

  fireEvent.click(screen.getByRole('button', { name: /아잉느/ }));
  fireEvent.click(screen.getByTitle('Test group'));
  await waitFor(() => expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull());
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
  fireEvent.click(screen.getByRole('button', { name: '← 그룹 메인으로' }));
  const kalosDifficultyButton = screen.getByRole('button', { name: /카오스 감시자 칼로스 파티 편성/ });
  expect(kalosDifficultyButton.textContent).toContain('C');
  const partyMutationCountBeforeDraft = workerCalls.filter(({ method, path }) => (
    ['POST', 'PUT', 'DELETE'].includes(method)
      && (path.endsWith('/parties') || path.includes('/party-characters/'))
  )).length;
  fireEvent.click(kalosDifficultyButton);
  const partyDialog = screen.getByRole('dialog', { name: '감시자 칼로스 파티 편성' });
  expect(partyDialog).toBeDefined();
  expect(document.querySelector('.group-main-party-overview')).not.toBeNull();
  const groupmateQuickCard = [...partyDialog.querySelectorAll('.group-quick-roster-card')]
    .find((card) => card.querySelector('.group-quick-roster-details strong').textContent === '그룹동료');
  expect(groupmateQuickCard.querySelector('.group-quick-roster-details b').textContent).toBe('보스 배율 80.0%');
  fireEvent.click(within(partyDialog).getByRole('button', { name: '+ 같은 보스 파티 추가' }));
  expect(partyDialog.querySelectorAll('.group-quick-party-card')).toHaveLength(1);
  fireEvent.click(within(partyDialog).getByRole('button', { name: '+ 같은 보스 파티 추가' }));
  expect(partyDialog.querySelectorAll('.group-quick-party-card')).toHaveLength(2);
  fireEvent.click(within(groupmateQuickCard).getByRole('button', { name: '파티에 추가' }));
  expect(assignedCharacters.has('ocid-teammate-roster')).toBe(false);
  const ownCharacterQuickCard = [...partyDialog.querySelectorAll('.group-quick-roster-card')]
    .find((card) => card.querySelector('.group-quick-roster-details strong').textContent === '오잉느');
  expect(ownCharacterQuickCard).toBeDefined();
  const dragData = {
    value: '',
    setData(_type, value) { this.value = value; },
    getData() { return this.value; },
  };
  const ownInitialPartyId = partyDialog.querySelectorAll('.group-quick-party-card')[0].id.replace('group-party-', '');
  fireEvent.dragStart(ownCharacterQuickCard, { dataTransfer: dragData });
  fireEvent.drop(partyDialog.querySelectorAll('.group-quick-party-card')[0], { dataTransfer: dragData });
  expect(assignedCharacters.has('ocid-1')).toBe(false);
  const ownAssignedCard = [...partyDialog.querySelectorAll('.group-quick-party-member')]
    .find((card) => card.querySelector('strong').textContent === '오잉느');
  const ownTargetPartyId = partyDialog.querySelectorAll('.group-quick-party-card')[1].id.replace('group-party-', '');
  fireEvent.dragStart(ownAssignedCard, { dataTransfer: dragData });
  fireEvent.drop(partyDialog.querySelectorAll('.group-quick-party-card')[1], { dataTransfer: dragData });
  expect(assignedCharacters.has('ocid-1')).toBe(false);
  expect(workerCalls.some(({ path }) => path.endsWith('/parties/commit'))).toBe(false);
  expect(workerCalls.filter(({ method, path }) => (
    ['POST', 'PUT', 'DELETE'].includes(method)
      && (path.endsWith('/parties') || path.includes('/party-characters/'))
  ))).toHaveLength(partyMutationCountBeforeDraft);
  fireEvent.click(within(partyDialog).getByRole('button', { name: '완료' }));
  await waitFor(() => expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(1));
  expect(assignedCharacters.get('ocid-1')).toBe(ownTargetPartyId);
  expect(assignedCharacters.get('ocid-1')).not.toBe(ownInitialPartyId);
  const commitRequest = workerCalls.find(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'));
  const committedKalosParties = commitRequest.request.parties.filter(({ bossId }) => bossId === 'chaos_kalos');
  expect(committedKalosParties.length).toBeGreaterThanOrEqual(2);
  expect(committedKalosParties.find(({ partyId }) => partyId === ownTargetPartyId).members).toEqual([{ ocid: 'ocid-1' }]);
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
  expect(ownActiveCharacterWrapAfterAssignment.querySelector('.unassigned-party-warning').textContent).toContain('3인 추천');
  expect(ownActiveCharacterWrapAfterAssignment.querySelector('.character-party-link').textContent)
    .toContain('Test group · 카오스 감시자 칼로스');
  expect(screen.getByRole('button', { name: '실사용 2명 전체 갱신' })).toBeDefined();
  expect(screen.queryByText('보스380 헥사환산 기준으로 정렬')).toBeNull();
  fireEvent.click(screen.getByTitle('Test group'));
  await screen.findByRole('heading', { name: '파티 빠른 편성' });
  expect(screen.queryByRole('heading', { name: '내 캐릭터 미완료 일정' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '새 파티 보스' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /카오스 감시자 칼로스 파티 편성/ }));
  const partyDialogAfterReopen = screen.getByRole('dialog', { name: '감시자 칼로스 파티 편성' });
  expect(partyDialogAfterReopen.querySelectorAll('.group-quick-roster-card')).toHaveLength(0);
  expect(partyDialogAfterReopen.querySelectorAll('.group-quick-party-member').length).toBeGreaterThan(0);
  const partyCountBeforeDelete = partyDialogAfterReopen.querySelectorAll('.group-quick-party-card').length;
  const partyCommitCountBeforeDelete = workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit')).length;
  fireEvent.click(within(partyDialogAfterReopen).getAllByRole('button', { name: /번째 파티 삭제/ })[0]);
  expect(partyDialogAfterReopen.querySelectorAll('.group-quick-party-card')).toHaveLength(partyCountBeforeDelete - 1);
  expect(workerCalls.filter(({ method, path }) => method === 'PUT' && path.endsWith('/parties/commit'))).toHaveLength(partyCommitCountBeforeDelete);
  fireEvent.click(within(partyDialogAfterReopen).getByRole('button', { name: '변경 취소' }));
  expect(partyDialogAfterReopen.querySelectorAll('.group-quick-party-card')).toHaveLength(partyCountBeforeDelete);
  fireEvent.click(within(partyDialogAfterReopen).getByRole('button', { name: '취소' }));
  expect(screen.queryByRole('dialog')).toBeNull();
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
    { nickname: '오잉느', boss380HexaScore: 67619, multipliers: [{ bossId: 'normal_kaling', multiplier: 26.5 }] },
    { nickname: '아잉느', boss380HexaScore: 70000, multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }] },
  ]);
  expect(new Headers(importCalls[0].init.headers).get('Authorization')).toBe('Bearer test-access-token');
  expect(workerCalls.some(({ method, path }) => method === 'POST' && path === '/api/characters/maplescouter-scores')).toBe(false);
});
