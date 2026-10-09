import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const worker = workerModule.default;
const env = {
  DB: {},
  APP_ORIGINS: 'https://app.example.test,http://localhost:3000',
};

test('health endpoint is public', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('rejects an unlisted browser origin before authentication', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/groups', {
    headers: { Origin: 'https://attacker.example.test' },
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: '허용되지 않은 웹 출처입니다.' });
});

test('allows cross-origin group settings requests through CORS preflight', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.test',
      'Access-Control-Request-Method': 'PATCH',
    },
  }), env);
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /PATCH/);
});

test('requires a Google access token for protected routes', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/groups'), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Google 로그인이 필요합니다.' });
});

test('exchanges Google authorization codes for encrypted, refreshable server sessions', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const storedSessions = new Map();
  const executedQueries = [];
  env.GOOGLE_CLIENT_ID = 'test-client-id';
  env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  env.SESSION_ENCRYPTION_KEY = 'test-encryption-key-long-enough-for-tests';
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => {
        if (query.includes('FROM auth_sessions')) {
          if (query.includes('WHERE google_sub = ?')) return null;
          return storedSessions.get(values[0]) || null;
        }
        return null;
      },
      run: async () => {
        executedQueries.push(query);
        if (query.includes('INSERT INTO auth_sessions')) {
          const [tokenHash, sub, email, name, refreshCipher, accessCipher, accessExpires, expiresAt, createdAt, remember] = values;
          storedSessions.set(tokenHash, {
            tokenHash,
            sub,
            email,
            name,
            refreshTokenCiphertext: refreshCipher,
            accessTokenCiphertext: accessCipher,
            accessTokenExpiresAt: accessExpires,
            expiresAt,
            createdAt,
            remember,
          });
        } else if (query.includes('UPDATE auth_sessions')) {
          const [accessCipher, accessExpires, tokenHash] = values;
          const session = storedSessions.get(tokenHash);
          storedSessions.set(tokenHash, {
            ...session,
            accessTokenCiphertext: accessCipher,
            accessTokenExpiresAt: accessExpires,
          });
        } else if (query.includes('DELETE FROM auth_sessions')) {
          storedSessions.delete(values[0]);
        }
        return { success: true };
      },
    }),
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const requestBody = new URLSearchParams(init.body);
      if (requestBody.get('grant_type') === 'authorization_code') {
        assert.equal(requestBody.get('redirect_uri'), 'https://app.example.test');
        return Response.json({
          access_token: 'refreshed-google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 0,
        });
      }
      assert.equal(requestBody.get('refresh_token'), 'google-refresh-token');
      return Response.json({ access_token: 'refreshed-google-access-token', expires_in: 3600 });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer refreshed-google-access-token');
      return Response.json({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
        name: 'Member',
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  try {
    const loginResponse = await worker.fetch(new Request('https://worker.example.test/api/auth/google', {
      method: 'POST',
      headers: {
        Origin: 'https://app.example.test',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ code: 'one-time-code', remember: true }),
    }), env);
    assert.equal(loginResponse.status, 201, await loginResponse.clone().text());
    const login = await loginResponse.json();
    assert.match(login.sessionToken, /^ms_[a-f0-9]{64}$/);
    assert.deepEqual(login.account, {
      sub: 'google-subject',
      email: 'member@example.test',
      name: 'Member',
    });
    assert.equal(storedSessions.size, 1);
    const [session] = [...storedSessions.values()];
    assert.notEqual(session.refreshTokenCiphertext, 'google-refresh-token');
    assert.equal(session.remember, 1);

    const sessionResponse = await worker.fetch(new Request('https://worker.example.test/api/auth/session', {
      headers: { Authorization: `Bearer ${login.sessionToken}` },
    }), env);
    assert.equal(sessionResponse.status, 200);
    assert.deepEqual((await sessionResponse.json()).account, login.account);
    assert.ok(executedQueries.some((query) => query.includes('UPDATE auth_sessions')));
    assert.notEqual(session.accessTokenCiphertext, 'refreshed-google-access-token');

    const logoutResponse = await worker.fetch(new Request('https://worker.example.test/api/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${login.sessionToken}` },
    }), env);
    assert.equal(logoutResponse.status, 200);
    assert.equal(storedSessions.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    delete env.GOOGLE_CLIENT_ID;
    delete env.GOOGLE_CLIENT_SECRET;
    delete env.SESSION_ENCRYPTION_KEY;
  }
});

test('rejects expired or invalid Google access tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups', {
      headers: { Authorization: 'Bearer invalid-token' },
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Google 로그인 토큰이 만료되었거나 올바르지 않습니다.' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blocks an authenticated non-member from a group', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = () => ({ bind: () => ({ first: async () => null }) });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/unknown/bosses', {
      headers: { Authorization: 'Bearer valid-token' },
    }), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: '그룹이 없거나 그룹 구성원이 아닙니다.' });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('persists active character selection per Google account and rejects unowned characters', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const ownedOcids = ['ocid-1', 'ocid-2'];
  let savedSelection = '[]';
  let savedValues;
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: 'member@example.test', email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM character_preferences') ? { ocidsJson: savedSelection } : null,
      all: async () => ({ results: values.slice(1).filter((ocid) => ownedOcids.includes(ocid)).map((ocid) => ({ ocid })) }),
      run: async () => {
        savedValues = values;
        savedSelection = values[1];
        return { success: true };
      },
    }),
  });
  const request = (method, body) => worker.fetch(new Request('https://worker.example.test/api/characters/selection', {
    method,
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  try {
    const saveResponse = await request('PUT', { ocids: ['ocid-1', 'ocid-2', 'ocid-1'] });
    assert.equal(saveResponse.status, 200);
    assert.deepEqual(await saveResponse.json(), { ocids: ['ocid-1', 'ocid-2'] });
    assert.equal(savedValues[0], 'google-subject');
    assert.equal(savedValues[1], '["ocid-1","ocid-2"]');

    const getResponse = await request('GET');
    assert.deepEqual(await getResponse.json(), { ocids: ['ocid-1', 'ocid-2'] });

    const unownedResponse = await request('PUT', { ocids: ['ocid-foreign'] });
    assert.equal(unownedResponse.status, 403);
    assert.deepEqual(await unownedResponse.json(), { error: '본인이 인증한 캐릭터만 선택할 수 있습니다.' });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('imports browser-captured scores and boss multipliers to the owned character', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const batches = [];
  let characterRow = { nickname: '오잉느' };
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      query,
      values,
      first: async () => query.includes('FROM characters')
        ? characterRow
        : {
          id: 'group-1',
          name: 'Test group',
          created_by_sub: 'google-subject',
          created_by_email: 'member@example.test',
          role: 'admin',
        },
      all: async () => ({ results: [{ boss_id: 'hard_kaling' }] }),
      run: async () => ({ success: true }),
    }),
  });
  env.DB.batch = async (statements) => { batches.push(statements); };

  const importRequest = (body) => worker.fetch(new Request('https://worker.example.test/api/characters/maplescouter-import', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  try {
    const response = await importRequest({
      nickname: '오잉느',
      boss380HexaScore: 67619,
      multipliers: [
        { bossId: 'hard_kaling', multiplier: 25.5 },
        { bossId: 'normal_kaling', multiplier: 40 },
      ],
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual({
      nickname: result.nickname,
      boss380HexaScore: result.boss380HexaScore,
      updatedMultipliers: result.updatedMultipliers,
      ignoredMultipliers: result.ignoredMultipliers,
    }, {
      nickname: '오잉느',
      boss380HexaScore: 67619,
      updatedMultipliers: 2,
      ignoredMultipliers: 0,
    });
    assert.equal(typeof result.updatedAt, 'string');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 3);
    assert.equal(batches[0][0].query.includes('UPDATE characters'), true);
    assert.deepEqual(batches[0][0].values, [67619, 'google-subject', '오잉느']);
    assert.equal(batches[0][1].query.includes('INSERT INTO character_multipliers'), true);
    assert.deepEqual(batches[0][1].values.slice(0, 4), ['google-subject', '오잉느', 'hard_kaling', 25.5]);
    assert.deepEqual(batches[0][2].values.slice(0, 4), ['google-subject', '오잉느', 'normal_kaling', 40]);

    const groupScopedResponse = await importRequest({
      nickname: '오잉느',
      boss380HexaScore: 67619,
      groupId: 'group-1',
      multipliers: [{ bossId: 'hard_kaling', multiplier: 25.5 }],
    });
    assert.equal(groupScopedResponse.status, 400);

    characterRow = null;
    const unownedResponse = await importRequest({ nickname: '타인캐릭터', boss380HexaScore: 67619 });
    assert.equal(unownedResponse.status, 403);
    assert.equal(batches.length, 1);

    const invalidResponse = await importRequest({
      nickname: '오잉느',
      boss380HexaScore: 67619,
      multipliers: [{ bossId: 'hard_kaling', multiplier: 1001 }],
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(batches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('lists multipliers owned by the authenticated character account', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  let query;
  let boundValues;
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  });
  env.DB.prepare = (statement) => ({
    bind: (...values) => {
      query = statement;
      boundValues = values;
      return {
        all: async () => ({ results: [{
          ownerSub: 'google-subject',
          nickname: '오잉느',
          bossId: 'hard_kaling',
          multiplier: '25.5',
        }] }),
      };
    },
  });

  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/multipliers', {
      headers: { Authorization: 'Bearer test-token' },
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      multipliers: [{
        ownerSub: 'google-subject',
        nickname: '오잉느',
        bossId: 'hard_kaling',
        multiplier: '25.5',
      }],
    });
    assert.match(query, /FROM character_multipliers/);
    assert.deepEqual(boundValues, ['google-subject']);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('retires server-side multiplier scraping in favor of browser import', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/multipliers', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '오잉느', multipliers: [{ bossId: 'hard_kaling', multiplier: 30.67 }] }),
    }), env);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: '보스 배율은 로그인 앱의 브라우저 가져오기로 저장해 주세요.' });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('allows only group admins to change the sidebar image or delete the group', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const statements = [];
  let role = 'admin';
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM groups g JOIN group_members')
        ? {
          id: 'group-1',
          name: 'Test group',
          created_by_sub: 'google-subject',
          created_by_email: 'member@example.test',
          role,
        }
        : null,
      run: async () => {
        statements.push({ query, values });
        return { success: true };
      },
    }),
  });

  try {
    const patchResponse = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mainImageBossId: 'extreme_kalos' }),
    }), env);
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(await patchResponse.json(), { id: 'group-1', mainImageBossId: 'extreme_kalos' });
    assert.deepEqual(statements[0].values, ['extreme_kalos', 'group-1']);

    const deleteResponse = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    }), env);
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { id: 'group-1', deleted: true });
    assert.equal(statements[1].query, 'DELETE FROM groups WHERE id = ?');

    role = 'member';
    const forbiddenResponse = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    }), env);
    assert.equal(forbiddenResponse.status, 403);
    assert.equal(statements.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('lists group members and removes a member with their roster and party assignments', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  let batches = [];
  let principalEmail = 'owner@example.test';
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: principalEmail, email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM groups g JOIN group_members')
        ? {
          id: 'group-1', name: 'Test group', created_by_sub: 'google-subject',
          created_by_email: 'owner@example.test', role: 'admin',
        }
        : null,
      all: async () => query.includes('FROM group_members gm')
        ? { results: [
          { email: 'owner@example.test', name: 'Owner', role: 'admin', joinedAt: '2026-10-01T00:00:00.000Z', characterCount: 2, isOwner: 1 },
          { email: 'member@example.test', name: 'Member', role: 'member', joinedAt: '2026-10-02T00:00:00.000Z', characterCount: 1, isOwner: 0 },
        ] }
        : { results: [] },
      run: async () => ({ success: true }),
      query,
      values,
    }),
  });
  env.DB.batch = async (statements) => { batches.push(statements); };
  try {
    const listResponse = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/members', {
      headers: { Authorization: 'Bearer valid-token' },
    }), env);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), {
      members: [
        { email: 'owner@example.test', name: 'Owner', role: 'admin', joinedAt: '2026-10-01T00:00:00.000Z', characterCount: 2, isOwner: true },
        { email: 'member@example.test', name: 'Member', role: 'member', joinedAt: '2026-10-02T00:00:00.000Z', characterCount: 1, isOwner: false },
      ],
    });

    const removeMember = (email) => worker.fetch(new Request('https://worker.example.test/api/groups/group-1/members', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }), env);
    const removeResponse = await removeMember('member@example.test');
    assert.equal(removeResponse.status, 200);
    assert.deepEqual(await removeResponse.json(), { email: 'member@example.test', removed: true });
    assert.equal(batches.length, 1);
    assert.equal(batches[0][0].query.includes('DELETE FROM group_boss_participants'), true);
    assert.equal(batches[0][1].query.includes('DELETE FROM group_characters'), true);
    assert.equal(batches[0][2].query.includes('DELETE FROM group_members'), true);

    const ownerResponse = await removeMember('owner@example.test');
    assert.equal(ownerResponse.status, 400);
    assert.equal(batches.length, 1);

    principalEmail = 'moderator@example.test';
    const selfResponse = await removeMember('moderator@example.test');
    assert.equal(selfResponse.status, 400);
    assert.equal(batches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('adds a group boss to D1', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const statements = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = (query) => ({
    bind: (...values) => {
      statements.push({ query, values });
      return {
        first: async () => ({
          id: 'group-1',
          name: 'Test group',
          created_by_sub: 'google-subject',
          created_by_email: 'member@example.test',
          role: 'admin',
        }),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      };
    },
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/bosses', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bossId: 'normal_kaling' }),
    }), env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { bossId: 'normal_kaling', added: true });
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO bosses')), true);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('creates hashed seven-day group invites and accepts them for authenticated users', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  let insertedInvite;
  let insertedMember;
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      query,
      values,
      first: async () => {
        if (query.includes('FROM groups g JOIN group_members')) {
          return {
            id: 'group-1', name: 'Test group', created_by_sub: 'google-subject',
            created_by_email: 'member@example.test', role: 'admin',
          };
        }
        if (query.includes('FROM group_invites')) {
          return { groupId: 'group-1', name: 'Test group', expiresAt: insertedInvite[4] };
        }
        return null;
      },
      run: async () => {
        if (query.includes('INSERT INTO group_invites')) insertedInvite = values;
        if (query.includes('INSERT INTO group_members')) insertedMember = values;
        return { success: true };
      },
    }),
  });
  try {
    const createResponse = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/invites', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    }), env);
    assert.equal(createResponse.status, 201);
    const invite = await createResponse.json();
    assert.match(invite.token, /^[a-f0-9]{64}$/);
    assert.notEqual(insertedInvite[0], invite.token);
    assert.equal(new Date(invite.expiresAt).getTime() - new Date(insertedInvite[3]).getTime(), 7 * 24 * 60 * 60 * 1000);

    const acceptResponse = await worker.fetch(new Request('https://worker.example.test/api/group-invites/accept', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invite.token }),
    }), env);
    assert.equal(acceptResponse.status, 200);
    assert.deepEqual(await acceptResponse.json(), { groupId: 'group-1', groupName: 'Test group', joined: true });
    assert.deepEqual(insertedMember.slice(0, 2), ['group-1', 'member@example.test']);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('adds only owned level-260-or-higher characters to a group roster', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const statements = [];
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: 'member@example.test', email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM groups g JOIN group_members')
        ? { id: 'group-1', name: 'Test group', created_by_sub: 'google-subject', created_by_email: 'member@example.test', role: 'admin' }
        : query.includes('FROM characters') ? { nickname: '오잉느', level: 280 } : null,
      run: async () => { statements.push({ query, values }); return { success: true }; },
    }),
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/characters', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ocid: 'ocid-1' }),
    }), env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { nickname: '오잉느', ocid: 'ocid-1', added: true });
    assert.equal(statements[0].query.includes('INSERT INTO group_characters'), true);
    assert.deepEqual(statements[0].values.slice(0, 4), ['group-1', 'google-subject', 'member@example.test', '오잉느']);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('creates multiple parties for one boss and returns member multipliers and scheduler data', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const createdParties = [];
  const listedRows = [
    {
      partyId: 'party-1', bossId: 'chaos_kalos', familyId: 'kalos', createdAt: '2026-10-09T00:00:00.000Z',
      ownerSub: 'google-subject', ownerEmail: 'member@example.test', nickname: '오잉느', ocid: 'ocid-1',
      worldName: '스카니아', characterClass: '아델', level: 291, image: 'image-1',
      schedulerJson: JSON.stringify({ boss_contents: [{ content_name: '감시자 칼로스', difficulty: 'chaos', complete_flag: 'true' }] }),
      multiplier: '55',
    },
    {
      partyId: 'party-2', bossId: 'chaos_kalos', familyId: 'kalos', createdAt: '2026-10-09T00:01:00.000Z',
      ownerSub: 'other-subject', ownerEmail: 'other@example.test', nickname: '아잉느', ocid: 'ocid-2',
      worldName: '루나', characterClass: '비숍', level: 280, image: 'image-2',
      schedulerJson: JSON.stringify({ boss_contents: [{ content_name: '감시자 칼로스', difficulty: 'chaos', complete_flag: 'false' }] }),
      multiplier: '50',
    },
  ];
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: 'member@example.test', email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM groups g JOIN group_members')
        ? { id: 'group-1', name: 'Test group', created_by_sub: 'google-subject', created_by_email: 'member@example.test', role: 'admin' }
        : null,
      run: async () => { createdParties.push(values); return { success: true }; },
      all: async () => ({ results: listedRows }),
    }),
  });
  try {
    const createParty = () => worker.fetch(new Request('https://worker.example.test/api/groups/group-1/parties', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bossId: 'chaos_kalos' }),
    }), env);
    const first = await createParty();
    const second = await createParty();
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual((await first.json()).partyId, (await second.json()).partyId);
    assert.equal(createdParties.length, 2);

    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/parties', {
      headers: { Authorization: 'Bearer valid-token' },
    }), env);
    assert.equal(response.status, 200);
    const { parties } = await response.json();
    assert.equal(parties.length, 2);
    assert.deepEqual(parties.map(({ partyId }) => partyId), ['party-1', 'party-2']);
    assert.equal(parties[0].members[0].multiplier, 55);
    assert.equal(parties[0].members[0].scheduler.boss_contents[0].complete_flag, 'true');
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('commits a group party draft in one batch and protects duplicate and foreign assignments', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  let role = 'admin';
  let participants = [{ partyId: 'party-1', ownerSub: 'google-subject', nickname: '오잉느' }];
  const batches = [];
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: 'member@example.test', email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      first: async () => query.includes('FROM groups g JOIN group_members')
        ? { id: 'group-1', name: 'Test group', created_by_sub: 'google-subject', created_by_email: 'member@example.test', role }
        : null,
      all: async () => {
        if (query.includes('FROM group_boss_parties WHERE group_id')) {
          return { results: [{ partyId: 'party-1', bossId: 'chaos_kalos', familyId: 'kalos' }] };
        }
        if (query.includes('FROM group_characters gc JOIN characters')) {
          return { results: [
            { ownerSub: 'google-subject', nickname: '오잉느', ocid: 'ocid-1' },
            { ownerSub: 'google-subject', nickname: '부캐', ocid: 'ocid-2' },
          ] };
        }
        if (query.includes('FROM group_boss_participants WHERE group_id')) return { results: participants };
        return { results: [] };
      },
      query,
      values,
    }),
  });
  env.DB.batch = async (statements) => { batches.push(statements); };
  const commit = (parties) => worker.fetch(new Request('https://worker.example.test/api/groups/group-1/parties/commit', {
    method: 'PUT',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parties }),
  }), env);
  try {
    const validResponse = await commit([{ partyId: 'party-1', bossId: 'chaos_kalos', members: [{ ocid: 'ocid-2' }] }]);
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), { saved: true, partyCount: 1 });
    assert.equal(batches.length, 1);
    assert.equal(batches[0][0].query, 'DELETE FROM group_boss_participants WHERE group_id = ?');
    assert.equal(batches[0].some(({ query }) => query.includes('INSERT INTO group_boss_participants')), true);

    const duplicateResponse = await commit([{
      partyId: 'party-1',
      bossId: 'chaos_kalos',
      members: [{ ocid: 'ocid-1' }, { ocid: 'ocid-2' }],
    }]);
    assert.equal(duplicateResponse.status, 400);
    assert.equal(batches.length, 1);

    const deletePartyResponse = await commit([]);
    assert.equal(deletePartyResponse.status, 200);
    assert.deepEqual(await deletePartyResponse.json(), { saved: true, partyCount: 0 });
    assert.equal(batches.length, 2);
    assert.equal(batches[1].some(({ query }) => query.includes('DELETE FROM group_boss_parties WHERE group_id = ? AND id = ?')), true);

    role = 'member';
    participants = [{ partyId: 'party-1', ownerSub: 'other-subject', nickname: '팀원' }];
    const foreignEditResponse = await commit([{
      partyId: 'party-1',
      bossId: 'chaos_kalos',
      members: [{ ocid: 'ocid-1' }],
    }]);
    assert.equal(foreignEditResponse.status, 403);
    assert.equal(batches.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('caps weekly bosses at twelve, excludes monthly bosses, and allows family difficulty changes', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const assignments = [];
  const parties = new Map();
  globalThis.fetch = async () => Response.json({
    sub: 'google-subject', email: 'member@example.test', email_verified: true,
  });
  env.DB.prepare = (query) => ({
    bind: (...values) => ({
      query,
      values,
      first: async () => {
        if (query.includes('FROM groups g JOIN group_members')) {
          return { id: 'group-1', name: 'Test group', created_by_sub: 'google-subject', created_by_email: 'member@example.test', role: 'admin' };
        }
        if (query.includes('FROM group_characters gc JOIN characters')) return { ownerSub: 'google-subject', nickname: '오잉느' };
        if (query.includes('SELECT p.party_id AS partyId')) return assignments.find((assignment) => assignment.familyId === values[3]) || null;
        if (query.includes('COUNT(*)')) return { count: assignments.filter(({ familyId }) => familyId !== 'blackmage').length };
        return null;
      },
    }),
  });
  env.DB.batch = async (statements) => {
    const partyStatement = statements.find(({ query }) => query.includes('INSERT INTO group_boss_parties'));
    if (partyStatement) {
      parties.set(partyStatement.values[0], {
        bossId: partyStatement.values[2],
        familyId: partyStatement.values[3],
      });
    }
    const remove = statements.find(({ query }) => query.includes('DELETE FROM group_boss_participants'));
    if (remove) {
      const current = assignments.findIndex((assignment) => assignment.partyId === remove.values[0]);
      if (current >= 0) assignments.splice(current, 1);
    }
    const add = statements.find(({ query }) => query.includes('INSERT INTO group_boss_participants'));
    const party = parties.get(add.values[0]);
    assignments.push({ partyId: add.values[0], bossId: party.bossId, familyId: party.familyId });
  };
  const assign = (bossId) => worker.fetch(new Request('https://worker.example.test/api/groups/group-1/party-characters/ocid-1', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ bossId }),
  }), env);
  try {
    assert.equal((await assign('normal_kalos')).status, 201);
    const replace = await assign('chaos_kalos');
    assert.equal(replace.status, 200);
    assert.equal((await replace.json()).replacedBossId, 'normal_kalos');
    const changeBack = await assign('normal_kalos');
    assert.equal(changeBack.status, 200);
    assert.equal((await changeBack.json()).replacedBossId, 'chaos_kalos');
    for (const family of 'abcdefghijk') assert.equal((await assign(`normal_boss${family}`)).status, 201);
    assert.equal(assignments.length, 12);
    assert.equal((await assign('hard_blackmage')).status, 201);
    assert.equal(assignments.length, 13);
    const overLimit = await assign('normal_bossm');
    assert.equal(overLimit.status, 400);
    assert.match((await overLimit.json()).error, /최대 12개/);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('rejects an invalid Nexon API key before database writes', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const requestedPaths = [];
  let databaseWrites = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return new Response(JSON.stringify({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    requestedPaths.push(url.pathname);
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 403 });
  };
  env.DB.prepare = () => {
    databaseWrites += 1;
    throw new Error('Unexpected database access');
  };
  env.DB.batch = async () => {
    databaseWrites += 1;
    throw new Error('Unexpected database access');
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'invalid-key' }),
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Nexon 캐릭터 목록 조회 실패: Invalid API key' });
    assert.deepEqual(requestedPaths, ['/maplestory/v1/character/list']);
    assert.equal(databaseWrites, 0);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('associates every character from the Nexon API key with the Google account', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const requestedPaths = [];
  const requestTimes = [];
  let insertedStatements;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return new Response(JSON.stringify({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    requestedPaths.push(url.pathname);
    requestTimes.push(performance.now());
    assert.equal(new Headers(options.headers).get('x-nxopen-api-key'), 'nexon-key');
    if (url.pathname.endsWith('/character/list')) {
      return new Response(JSON.stringify({
        account_list: [
          { account_id: 'account-1', character_list: [{ ocid: 'ocid-1', character_name: 'first-character', character_level: 280 }] },
          {
            account_id: 'account-2',
            character_list: [
              { character_name: 'second-character', character_level: 260 },
              { ocid: 'ocid-low-level', character_name: 'low-level-character', character_level: 259 },
            ],
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/id')) {
      const nickname = url.searchParams.get('character_name');
      assert.equal(nickname, 'second-character');
      return Response.json({ ocid: `resolved-${nickname}` });
    }
    if (url.pathname.endsWith('/character/basic')) {
      assert.equal(url.searchParams.has('date'), false);
      assert.ok(['ocid-1', 'resolved-second-character'].includes(url.searchParams.get('ocid')));
      return Response.json({
        world_name: 'Scania',
        character_class: 'Hero',
        character_level: url.searchParams.get('ocid') === 'ocid-1' ? 280 : 260,
        character_image: `https://image.example.test/${url.searchParams.get('ocid')}.png`,
      });
    }
    if (url.pathname.endsWith('/scheduler/character-state')) {
      return Response.json({
        date: '2026-10-08',
        daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
        weekly_contents: [],
        boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
      });
    }
    throw new Error(`Unexpected Nexon API request: ${url.pathname}`);
  };
  env.DB.prepare = (query) => ({ bind: (...values) => ({ query, values }) });
  env.DB.batch = async (statements) => { insertedStatements = statements; };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nexon-key' }),
    }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.characters, [
      {
        nickname: 'first-character',
        ocid: 'ocid-1',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/ocid-1.png',
        scheduler: {
          date: '2026-10-08',
          daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
          weekly_contents: [],
          boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
        },
      },
      {
        nickname: 'second-character',
        ocid: 'resolved-second-character',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 260,
        image: 'https://image.example.test/resolved-second-character.png',
        scheduler: {
          date: '2026-10-08',
          daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
          weekly_contents: [],
          boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
        },
      },
    ]);
    assert.equal(result.verified, true);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/character/list').length, 1);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/id').length, 1);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/character/basic').length, 2);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/scheduler/character-state').length, 2);
    assert.equal(requestTimes.length, 6);
    assert.ok(requestTimes.slice(1).every((time, index) => time - requestTimes[index] >= 190));
    assert.deepEqual(insertedStatements.map(({ values }) => values.slice(0, 3)), [
      ['google-subject', 'first-character', 'ocid-1'],
      ['google-subject', 'second-character', 'resolved-second-character'],
    ]);
    assert.equal(JSON.parse(insertedStatements[0].values[8]).date, '2026-10-08');
    assert.equal(insertedStatements.some(({ values }) => values.includes('nexon-key')), false);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('skips characters with unavailable basic info and continues syncing the rest', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const statements = [];
  const batches = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return Response.json({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      });
    }
    if (url.pathname.endsWith('/character/list')) {
      return Response.json({
        account_list: [{
          character_list: [
            { ocid: 'ocid-CeH1O1', character_name: 'CeH1O1', character_level: 280 },
            { ocid: 'ocid-WorkingCharacter', character_name: 'WorkingCharacter', character_level: 280 },
            { ocid: 'ocid-LowLevelCharacter', character_name: 'LowLevelCharacter', character_level: 259 },
          ],
        }],
      });
    }
    if (url.pathname.endsWith('/id')) {
      throw new Error('Unexpected OCID lookup when the character list already contains OCIDs');
    }
    if (url.pathname.endsWith('/character/basic')) {
      if (url.searchParams.get('ocid') === 'ocid-CeH1O1') {
        return Response.json({
          error: { name: 'OPENAPI00004', message: 'Invalid Parameter' },
        }, { status: 400 });
      }
      return Response.json({
        world_name: 'Scania',
        character_class: 'Hero',
        character_level: 280,
        character_image: 'https://image.example.test/working.png',
      });
    }
    if (url.pathname.endsWith('/scheduler/character-state')) {
      return new Response('{}', { status: 429 });
    }
    throw new Error(`Unexpected Nexon API request: ${url.pathname}`);
  };
  env.DB.prepare = (query) => ({
    bind: (...values) => {
      const statement = { query, values };
      statements.push(statement);
      return statement;
    },
  });
  env.DB.batch = async (batch) => { batches.push(batch); };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nexon-key' }),
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      characters: [{
        nickname: 'WorkingCharacter',
        ocid: 'ocid-WorkingCharacter',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/working.png',
        scheduler: {},
      }],
      skippedCharacters: ['CeH1O1'],
      schedulerUnavailable: ['WorkingCharacter'],
      verified: true,
    });
    assert.equal(statements.some(({ query, values }) => (
      query.includes('DELETE FROM characters') && values[1] === 'CeH1O1'
    )), false);
    assert.equal(statements.some(({ query, values }) => (
      query.includes('INSERT INTO characters') && values[1] === 'WorkingCharacter'
    )), true);
    assert.equal(statements.some(({ values }) => values.includes('LowLevelCharacter')), false);
    assert.equal(batches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('returns saved character profiles and scheduler data after sign-in', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = () => ({
    bind: () => ({
      all: async () => ({
        results: [{
          nickname: 'first-character',
          ocid: 'ocid-1',
          verifiedAt: '2026-10-08T00:00:00.000Z',
          worldName: 'Scania',
          characterClass: 'Hero',
          level: 280,
          image: 'https://image.example.test/ocid-1.png',
          schedulerJson: JSON.stringify({ date: '2026-10-08', daily_contents: [] }),
          schedulerDate: '2026-10-08',
        }],
      }),
    }),
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters', {
      headers: { Authorization: 'Bearer test-access-token' },
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      characters: [{
        nickname: 'first-character',
        ocid: 'ocid-1',
        verifiedAt: '2026-10-08T00:00:00.000Z',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/ocid-1.png',
        schedulerDate: '2026-10-08',
        scheduler: { date: '2026-10-08', daily_contents: [] },
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});