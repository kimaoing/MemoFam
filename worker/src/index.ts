interface Env {
  DB: D1Database;
  APP_ORIGINS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_ENCRYPTION_KEY: string;
}

interface GooglePrincipal {
  sub: string;
  email: string;
  name?: string;
}

interface GroupRow {
  id: string;
  name: string;
  created_by_sub: string;
  created_by_email: string;
  role: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

interface AuthSessionRow {
  tokenHash: string;
  sub: string;
  email: string;
  name: string;
  refreshTokenCiphertext: string;
  accessTokenCiphertext: string;
  accessTokenExpiresAt: number;
  expiresAt: number;
  remember: number;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const bossIdPattern = /^[a-z]+_[A-Za-z]+$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value))));
}

async function sessionEncryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_ENCRYPTION_KEY) throw new ApiError(500, 'SESSION_ENCRYPTION_KEY 설정이 필요합니다.');
  const keyBytes = await crypto.subtle.digest('SHA-256', textEncoder.encode(env.SESSION_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function encryptSessionValue(env: Env, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: copyBuffer(iv) },
    await sessionEncryptionKey(env),
    textEncoder.encode(value),
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(encrypted))}`;
}

async function decryptSessionValue(env: Env, value: string): Promise<string> {
  const [encodedIv, encodedCiphertext] = value.split('.');
  if (!encodedIv || !encodedCiphertext) throw new ApiError(401, '로그인 세션을 복호화할 수 없습니다.');
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copyBuffer(decodeBase64(encodedIv)) },
      await sessionEncryptionKey(env),
      copyBuffer(decodeBase64(encodedCiphertext)),
    );
    return textDecoder.decode(decrypted);
  } catch {
    throw new ApiError(401, '로그인 세션을 복호화할 수 없습니다.');
  }
}

function createSessionToken(): string {
  return `ms_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
    headers.set('Access-Control-Max-Age', '600');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));
}

async function refreshSessionAccessToken(env: Env, session: AuthSessionRow): Promise<string> {
  const refreshToken = await decryptSessionValue(env, session.refreshTokenCiphertext);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const tokenError = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 400 && tokenError.error === 'invalid_grant') {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(session.tokenHash).run();
      throw new ApiError(401, 'Google 로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
    }
    throw new ApiError(502, 'Google 로그인 세션을 갱신하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const tokenResult = await response.json() as { access_token?: string; expires_in?: number };
  if (!tokenResult.access_token || !Number.isFinite(Number(tokenResult.expires_in))) {
    throw new ApiError(502, 'Google에서 새 로그인 토큰을 받지 못했습니다.');
  }
  const accessTokenCiphertext = await encryptSessionValue(env, tokenResult.access_token);
  const accessTokenExpiresAt = Date.now() + Number(tokenResult.expires_in) * 1000;
  await env.DB.prepare(`
    UPDATE auth_sessions
    SET access_token_ciphertext = ?, access_token_expires_at = ?
    WHERE token_hash = ?
  `).bind(accessTokenCiphertext, accessTokenExpiresAt, session.tokenHash).run();
  return tokenResult.access_token;
}

async function authenticateSession(env: Env, token: string): Promise<GooglePrincipal> {
  if (!/^ms_[a-f0-9]{64}$/.test(token)) throw new ApiError(401, '로그인 세션이 올바르지 않습니다.');
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(`
    SELECT token_hash AS tokenHash, google_sub AS sub, email, name,
      refresh_token_ciphertext AS refreshTokenCiphertext,
      access_token_ciphertext AS accessTokenCiphertext,
      access_token_expires_at AS accessTokenExpiresAt, expires_at AS expiresAt, remember
    FROM auth_sessions WHERE token_hash = ?
  `).bind(tokenHash).first<AuthSessionRow>();
  if (!session || session.expiresAt <= Date.now()) {
    if (session) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new ApiError(401, '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (session.expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    const renewedExpiry = Date.now() + (session.remember ? sessionLifetimeMs : 12 * 60 * 60 * 1000);
    await env.DB.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(renewedExpiry, tokenHash).run();
    session.expiresAt = renewedExpiry;
  }
  const accessToken = session.accessTokenExpiresAt > Date.now() + 60_000
    ? await decryptSessionValue(env, session.accessTokenCiphertext)
    : await refreshSessionAccessToken(env, session);
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 401) throw new ApiError(401, 'Google 계정을 확인할 수 없습니다. 다시 로그인해 주세요.');
    throw new ApiError(502, 'Google 계정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  }
  const profile = await response.json() as GoogleUserInfo;
  if (profile.sub !== session.sub || profile.email_verified !== true) {
    throw new ApiError(401, '저장된 로그인 세션의 Google 계정이 일치하지 않습니다.');
  }
  return { sub: session.sub, email: session.email, name: session.name };
}

async function authenticate(request: Request, env: Env): Promise<GooglePrincipal> {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new ApiError(401, 'Google 로그인이 필요합니다.');
  if (token.startsWith('ms_')) return authenticateSession(env, token);
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(401, 'Google 로그인 토큰이 만료되었거나 올바르지 않습니다.');
  const profile = await response.json() as GoogleUserInfo;
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new ApiError(401, 'Google 계정의 인증 상태를 확인할 수 없습니다.');
  }
  return { sub: profile.sub, email: profile.email.toLowerCase(), name: profile.name };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new ApiError(413, '요청 데이터가 너무 큽니다.');
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'JSON 요청 본문을 확인해 주세요.');
  }
}

function stringField(body: Record<string, unknown>, name: string, maxLength: number): string {
  const value = typeof body[name] === 'string' ? body[name].trim() : '';
  if (!value || value.length > maxLength) throw new ApiError(400, `${name} 값을 확인해 주세요.`);
  return value;
}

async function nexonError(response: Response): Promise<string> {
  const result = await response.json().catch(() => ({})) as {
    error?: { name?: unknown; message?: unknown };
  };
  const name = typeof result.error?.name === 'string' ? result.error.name : '';
  const message = typeof result.error?.message === 'string' ? result.error.message : '';
  return [name, message].filter(Boolean).join(': ') || `HTTP ${response.status}`;
}

async function getGroup(env: Env, groupId: string, email: string): Promise<GroupRow> {
  const group = await env.DB.prepare(`
    SELECT g.id, g.name, g.created_by_sub, g.created_by_email, m.role
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE g.id = ? AND lower(m.email) = lower(?)
  `).bind(groupId, email).first<GroupRow>();
  if (!group) throw new ApiError(404, '그룹이 없거나 그룹 구성원이 아닙니다.');
  return group;
}

async function requireGroupAdmin(env: Env, groupId: string, principal: GooglePrincipal): Promise<GroupRow> {
  const group = await getGroup(env, groupId, principal.email);
  if (group.created_by_sub !== principal.sub || group.role !== 'admin') {
    throw new ApiError(403, '그룹 관리자만 이 작업을 할 수 있습니다.');
  }
  return group;
}

async function getBossIds(env: Env, groupId: string): Promise<string[]> {
  const result = await env.DB.prepare(`
    SELECT boss_id FROM bosses WHERE group_id = ? ORDER BY boss_id
  `).bind(groupId).all<{ boss_id: string }>();
  return [...new Set((result.results || [])
    .map(({ boss_id }) => String(boss_id || '').trim())
    .filter((bossId) => bossIdPattern.test(bossId)))];
}

async function verifyCharacter(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some((key) => key !== 'apiKey')) {
    throw new ApiError(400, 'apiKey만 요청할 수 있습니다.');
  }
  const apiKey = stringField(body, 'apiKey', 256);
  const headers = { 'x-nxopen-api-key': apiKey };
  let nextNexonRequestAt = 0;
  const fetchNexon = async (input: URL): Promise<Response> => {
    const now = Date.now();
    const requestAt = Math.max(now, nextNexonRequestAt);
    nextNexonRequestAt = requestAt + 200;
    if (requestAt > now) {
      await new Promise((resolve) => setTimeout(resolve, requestAt - now));
    }
    return fetch(input, { headers });
  };
  const listUrl = new URL('https://open.api.nexon.com/maplestory/v1/character/list');
  const listResponse = await fetchNexon(listUrl);
  if (!listResponse.ok) {
    throw new ApiError(400, `Nexon 캐릭터 목록 조회 실패: ${await nexonError(listResponse)}`);
  }
  const listResult = await listResponse.json().catch(() => ({})) as {
    account_list?: Array<{
      character_list?: Array<{ ocid?: string; character_name?: string; character_level?: number }>;
    }>;
  };
  const listedCharacters = [...new Map((listResult.account_list || [])
    .flatMap((account) => account.character_list || [])
    .flatMap((character) => {
      const nickname = typeof character.character_name === 'string' ? character.character_name.trim() : '';
      const ocid = typeof character.ocid === 'string' ? character.ocid.trim() : '';
      const level = typeof character.character_level === 'number' ? character.character_level : 0;
      return nickname && nickname.length <= 24 && level >= 260
        ? [[nickname.toLowerCase(), { nickname, ocid }]]
        : [];
    })).values()];
  if (!listedCharacters.length) throw new ApiError(400, 'Nexon API 키 계정에서 260레벨 이상 캐릭터를 찾을 수 없습니다.');

  const characters: Array<{
    nickname: string;
    ocid: string;
    worldName: string;
    characterClass: string;
    level: number;
    image: string;
    scheduler: Record<string, unknown>;
  }> = [];
  const skippedCharacters: string[] = [];
  const schedulerUnavailable: string[] = [];
  for (let offset = 0; offset < listedCharacters.length; offset += 3) {
    const batch = await Promise.allSettled(listedCharacters.slice(offset, offset + 3).map(async ({ nickname, ocid: listedOcid }) => {
      let ocid = listedOcid;
      if (!ocid) {
        const idUrl = new URL('https://open.api.nexon.com/maplestory/v1/id');
        idUrl.searchParams.set('character_name', nickname);
        const idResponse = await fetchNexon(idUrl);
        if (!idResponse.ok) {
          throw new ApiError(502, `${nickname} 캐릭터 OCID 조회 실패: ${await nexonError(idResponse)}`);
        }
        const idResult = await idResponse.json() as { ocid?: string };
        ocid = typeof idResult.ocid === 'string' ? idResult.ocid.trim() : '';
      }
      if (!ocid) throw new ApiError(502, `${nickname} 캐릭터 OCID를 Nexon API 응답에서 찾을 수 없습니다.`);

      const basicUrl = new URL('https://open.api.nexon.com/maplestory/v1/character/basic');
      basicUrl.searchParams.set('ocid', ocid);
      const schedulerUrl = new URL('https://open.api.nexon.com/maplestory/v1/scheduler/character-state');
      schedulerUrl.searchParams.set('ocid', ocid);
      const [basicResponse, schedulerResponse] = await Promise.all([
        fetchNexon(basicUrl),
        fetchNexon(schedulerUrl),
      ]);
      if (!basicResponse.ok) {
        throw new ApiError(502, `${nickname} 캐릭터 기본 정보 조회 실패 (OCID: ${ocid}): ${await nexonError(basicResponse)}`);
      }
      const basic = await basicResponse.json() as {
        world_name?: string;
        character_class?: string;
        character_level?: number;
        character_image?: string;
      };
      let scheduler: Record<string, unknown> = {};
      if (schedulerResponse.ok) {
        try {
          scheduler = await schedulerResponse.json() as Record<string, unknown>;
        } catch {
          schedulerUnavailable.push(nickname);
        }
      } else {
        schedulerUnavailable.push(nickname);
      }
      return {
        nickname,
        ocid,
        worldName: typeof basic.world_name === 'string' ? basic.world_name : '',
        characterClass: typeof basic.character_class === 'string' ? basic.character_class : '',
        level: typeof basic.character_level === 'number' ? basic.character_level : 0,
        image: typeof basic.character_image === 'string' ? basic.character_image : '',
        scheduler,
      };
    }));
    for (const [index, result] of batch.entries()) {
      if (result.status === 'fulfilled') {
        characters.push(result.value);
      } else {
        skippedCharacters.push(listedCharacters[offset + index].nickname);
      }
    }
  }

  if (!characters.length) {
    throw new ApiError(502, `Nexon API에서 캐릭터 기본 정보를 가져오지 못했습니다. 건너뛴 캐릭터: ${skippedCharacters.join(', ')}`);
  }

  const verifiedAt = new Date().toISOString();
  const statements = characters.map((character) => env.DB.prepare(`
    INSERT INTO characters (
      google_sub, nickname, ocid, verified_at, world_name, character_class, character_level, character_image,
      scheduler_json, scheduler_date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (google_sub, nickname) DO UPDATE SET
      ocid = excluded.ocid,
      verified_at = excluded.verified_at,
      world_name = excluded.world_name,
      character_class = excluded.character_class,
      character_level = excluded.character_level,
      character_image = excluded.character_image,
      scheduler_json = excluded.scheduler_json,
      scheduler_date = excluded.scheduler_date
  `).bind(
    principal.sub,
    character.nickname,
    character.ocid,
    verifiedAt,
    character.worldName,
    character.characterClass,
    character.level,
    character.image,
    JSON.stringify(character.scheduler),
    typeof character.scheduler.date === 'string' ? character.scheduler.date : new Date().toISOString().slice(0, 10),
  ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }

  return json({ characters, skippedCharacters, schedulerUnavailable, verified: true });
}

async function createGroup(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const name = stringField(body, 'name', 80);
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO groups (id, name, created_by_sub, created_by_email, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(groupId, name, principal.sub, principal.email, now),
    env.DB.prepare(`INSERT INTO group_members (group_id, email, role, joined_at) VALUES (?, ?, 'admin', ?)`)
      .bind(groupId, principal.email, now),
  ]);
  return json({ id: groupId, name, mainImageBossId: null }, 201);
}

async function listGroups(env: Env, principal: GooglePrincipal): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT g.id, g.name, g.main_image_boss_id AS mainImageBossId, m.role
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE lower(m.email) = lower(?) ORDER BY g.created_at DESC
  `).bind(principal.email).all();
  return json({ groups: result.results || [] });
}

async function updateGroup(
  env: Env,
  groupId: string,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  await requireGroupAdmin(env, groupId, principal);
  if (Object.keys(body).some((key) => key !== 'mainImageBossId')) {
    throw new ApiError(400, '그룹 이미지 설정 형식이 올바르지 않습니다.');
  }
  let mainImageBossId: string | null = null;
  if (body.mainImageBossId !== null) {
    mainImageBossId = stringField(body, 'mainImageBossId', 80);
    if (!bossIdPattern.test(mainImageBossId)) throw new ApiError(400, '그룹 이미지 ID 형식이 올바르지 않습니다.');
  }
  await env.DB.prepare('UPDATE groups SET main_image_boss_id = ? WHERE id = ?')
    .bind(mainImageBossId, groupId).run();
  return json({ id: groupId, mainImageBossId });
}

async function deleteGroup(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  await requireGroupAdmin(env, groupId, principal);
  await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run();
  return json({ id: groupId, deleted: true });
}

async function listCharacters(env: Env, principal: GooglePrincipal): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT nickname, ocid, verified_at AS verifiedAt, world_name AS worldName,
      character_class AS characterClass, character_level AS level, character_image AS image,
      scheduler_json AS schedulerJson, scheduler_date AS schedulerDate,
      boss380_hexa_score AS boss380HexaScore
    FROM characters WHERE google_sub = ? ORDER BY verified_at DESC
  `).bind(principal.sub).all<{
    nickname: string;
    ocid: string;
    verifiedAt: string;
    worldName: string;
    characterClass: string;
    level: number;
    image: string;
    schedulerJson: string;
    schedulerDate: string;
    boss380HexaScore: number | null;
  }>();
  const characters = (result.results || []).map(({ schedulerJson, ...character }) => ({
    ...character,
    scheduler: JSON.parse(schedulerJson),
  }));
  return json({ characters });
}

async function listCharacterMultipliers(env: Env, principal: GooglePrincipal): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT google_sub AS ownerSub, nickname, boss_id AS bossId,
      CAST(multiplier AS TEXT) AS multiplier, updated_at AS updatedAt, updated_by AS updatedBy
    FROM character_multipliers
    WHERE google_sub = ?
    ORDER BY nickname COLLATE NOCASE, boss_id
  `).bind(principal.sub).all();
  return json({ multipliers: result.results || [] });
}

async function getCharacterSelection(env: Env, principal: GooglePrincipal): Promise<Response> {
  const preference = await env.DB.prepare(`
    SELECT active_character_ocids_json AS ocidsJson
    FROM character_preferences WHERE google_sub = ?
  `).bind(principal.sub).first<{ ocidsJson: string }>();
  let ocids: unknown = [];
  try {
    ocids = JSON.parse(preference?.ocidsJson || '[]');
  } catch {
    ocids = [];
  }
  return json({ ocids: Array.isArray(ocids) ? ocids.filter((ocid) => typeof ocid === 'string') : [] });
}

async function saveCharacterSelection(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some((key) => key !== 'ocids') || !Array.isArray(body.ocids) || body.ocids.length > 200
    || body.ocids.some((ocid) => typeof ocid !== 'string' || ocid.length > 80)) {
    throw new ApiError(400, '캐릭터 선택 목록 형식이 올바르지 않습니다.');
  }
  const ocids = [...new Set(body.ocids as string[])];
  if (ocids.length) {
    const placeholders = ocids.map(() => '?').join(', ');
    const owned = await env.DB.prepare(`
      SELECT ocid FROM characters WHERE google_sub = ? AND ocid IN (${placeholders})
    `).bind(principal.sub, ...ocids).all<{ ocid: string }>();
    const ownedOcids = new Set((owned.results || []).map(({ ocid }) => ocid));
    if (ocids.some((ocid) => !ownedOcids.has(ocid))) {
      throw new ApiError(403, '본인이 인증한 캐릭터만 선택할 수 있습니다.');
    }
  }

  await env.DB.prepare(`
    INSERT INTO character_preferences (google_sub, active_character_ocids_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (google_sub) DO UPDATE SET
      active_character_ocids_json = excluded.active_character_ocids_json,
      updated_at = excluded.updated_at
  `).bind(principal.sub, JSON.stringify(ocids), new Date().toISOString()).run();
  return json({ ocids });
}

async function addGroupMember(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const email = stringField(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Google 이메일 형식을 확인해 주세요.');
  const existing = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND lower(email) = lower(?)')
    .bind(groupId, email).first();
  if (existing) return json({ email, added: false });

  await env.DB.prepare(`INSERT INTO group_members (group_id, email, role, joined_at) VALUES (?, ?, 'member', ?)`)
    .bind(groupId, email, new Date().toISOString()).run();
  return json({ email, added: true }, 201);
}

async function removeGroupMember(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const email = stringField(body, 'email', 254).toLowerCase();
  if (email === group.created_by_email.toLowerCase()) throw new ApiError(400, '그룹 생성자는 그룹에서 제거할 수 없습니다.');
  await env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND lower(email) = lower(?)').bind(groupId, email).run();
  return json({ email, removed: true });
}

async function addBoss(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const bossId = stringField(body, 'bossId', 80);
  if (!bossIdPattern.test(bossId)) throw new ApiError(400, 'bossId 형식이 올바르지 않습니다. 예: hard_kaling');
  const bossIds = await getBossIds(env, group.id);
  if (bossIds.includes(bossId)) return json({ bossId, added: false });
  await env.DB.prepare(`
    INSERT INTO bosses (group_id, boss_id, created_at, created_by)
    VALUES (?, ?, ?, ?)
  `).bind(group.id, bossId, new Date().toISOString(), principal.email).run();
  return json({ bossId, added: true }, 201);
}

async function listBosses(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  return json({ bossIds: await getBossIds(env, group.id) });
}

async function listMultipliers(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const result = await env.DB.prepare(`
    SELECT cm.google_sub AS ownerSub, cm.nickname, cm.boss_id AS bossId,
      CAST(cm.multiplier AS TEXT) AS multiplier, cm.updated_at AS updatedAt, cm.updated_by AS updatedBy
    FROM group_characters gc
    JOIN character_multipliers cm
      ON cm.google_sub = gc.google_sub AND lower(cm.nickname) = lower(gc.nickname)
    WHERE gc.group_id = ? ORDER BY cm.nickname COLLATE NOCASE, cm.boss_id
  `).bind(group.id).all();
  return json({ multipliers: result.results || [] });
}

async function createGroupInvite(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(tokenHash)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO group_invites (token_hash, group_id, created_by_sub, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(hash, group.id, principal.sub, createdAt.toISOString(), expiresAt).run();
  return json({ token, expiresAt }, 201);
}

async function acceptGroupInvite(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some((key) => key !== 'token')) throw new ApiError(400, '초대 토큰만 요청할 수 있습니다.');
  const token = stringField(body, 'token', 128);
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new ApiError(400, '초대 링크가 올바르지 않습니다.');
  const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(tokenHash)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const invite = await env.DB.prepare(`
    SELECT i.group_id AS groupId, i.expires_at AS expiresAt, g.name
    FROM group_invites i JOIN groups g ON g.id = i.group_id
    WHERE i.token_hash = ?
  `).bind(hash).first<{ groupId: string; expiresAt: string; name: string }>();
  if (!invite) throw new ApiError(404, '초대 링크를 찾을 수 없습니다.');
  if (invite.expiresAt <= new Date().toISOString()) throw new ApiError(410, '초대 링크가 만료되었습니다.');
  await env.DB.prepare(`
    INSERT INTO group_members (group_id, email, role, joined_at)
    VALUES (?, ?, 'member', ?)
    ON CONFLICT (group_id, email) DO NOTHING
  `).bind(invite.groupId, principal.email, new Date().toISOString()).run();
  return json({ groupId: invite.groupId, groupName: invite.name, joined: true });
}

async function listGroupCharacters(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const result = await env.DB.prepare(`
    SELECT gc.google_sub AS ownerSub, gc.owner_email AS ownerEmail,
      c.nickname, c.ocid, c.world_name AS worldName, c.character_class AS characterClass,
      c.character_level AS level, c.character_image AS image, c.scheduler_json AS schedulerJson,
      c.boss380_hexa_score AS boss380HexaScore,
      p.party_id AS partyId, bp.boss_id AS bossId, bp.family_id AS familyId
    FROM group_characters gc
    JOIN characters c ON c.google_sub = gc.google_sub AND lower(c.nickname) = lower(gc.nickname)
    LEFT JOIN group_boss_participants p
      ON p.group_id = gc.group_id AND p.google_sub = gc.google_sub AND lower(p.nickname) = lower(gc.nickname)
    LEFT JOIN group_boss_parties bp ON bp.id = p.party_id
    WHERE gc.group_id = ?
    ORDER BY c.character_level DESC, c.nickname COLLATE NOCASE
  `).bind(group.id).all<{
    ownerSub: string;
    ownerEmail: string;
    nickname: string;
    ocid: string;
    worldName: string;
    characterClass: string;
    level: number;
    image: string;
    schedulerJson: string;
    boss380HexaScore: number | null;
    partyId: string | null;
    bossId: string | null;
    familyId: string | null;
  }>();
  const characters = new Map<string, Record<string, unknown> & { bosses: Array<{ partyId: string; bossId: string; familyId: string }> }>();
  for (const row of result.results || []) {
    const key = `${row.ownerSub}:${row.ocid}`;
    let character = characters.get(key);
    if (!character) {
      const { schedulerJson, partyId: _partyId, bossId: _bossId, familyId: _familyId, ...fields } = row;
      character = { ...fields, scheduler: JSON.parse(schedulerJson || '{}'), bosses: [] };
      characters.set(key, character);
    }
    if (row.partyId && row.bossId && row.familyId) {
      character.bosses.push({ partyId: row.partyId, bossId: row.bossId, familyId: row.familyId });
    }
  }
  return json({ characters: [...characters.values()] });
}

async function listGroupParties(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const result = await env.DB.prepare(`
    SELECT bp.id AS partyId, bp.boss_id AS bossId, bp.family_id AS familyId, bp.created_at AS createdAt,
      p.google_sub AS ownerSub, gc.owner_email AS ownerEmail, c.nickname, c.ocid,
      c.world_name AS worldName, c.character_class AS characterClass,
      c.character_level AS level, c.character_image AS image, c.scheduler_json AS schedulerJson,
      CAST(m.multiplier AS TEXT) AS multiplier
    FROM group_boss_parties bp
    LEFT JOIN group_boss_participants p ON p.party_id = bp.id
    LEFT JOIN group_characters gc
      ON gc.group_id = p.group_id AND gc.google_sub = p.google_sub AND lower(gc.nickname) = lower(p.nickname)
    LEFT JOIN characters c ON c.google_sub = p.google_sub AND lower(c.nickname) = lower(p.nickname)
    LEFT JOIN character_multipliers m
      ON m.google_sub = p.google_sub AND lower(m.nickname) = lower(p.nickname) AND m.boss_id = bp.boss_id
    WHERE bp.group_id = ?
    ORDER BY bp.created_at, c.character_level DESC, c.nickname COLLATE NOCASE
  `).bind(group.id).all<{
    partyId: string;
    bossId: string;
    familyId: string;
    createdAt: string;
    ownerSub: string | null;
    ownerEmail: string | null;
    nickname: string | null;
    ocid: string | null;
    worldName: string | null;
    characterClass: string | null;
    level: number | null;
    image: string | null;
    schedulerJson: string | null;
    multiplier: string | null;
  }>();
  const parties = new Map<string, Record<string, unknown> & { members: Array<Record<string, unknown>> }>();
  for (const row of result.results || []) {
    let party = parties.get(row.partyId);
    if (!party) {
      party = {
        partyId: row.partyId,
        bossId: row.bossId,
        familyId: row.familyId,
        createdAt: row.createdAt,
        members: [],
      };
      parties.set(row.partyId, party);
    }
    if (row.ownerSub && row.ownerEmail && row.nickname && row.ocid) {
      const { schedulerJson, ...fields } = row;
      party.members.push({
        ...fields,
        scheduler: JSON.parse(schedulerJson || '{}'),
        multiplier: Number(row.multiplier || 0),
      });
    }
  }
  return json({ parties: [...parties.values()] });
}

async function addGroupCharacter(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'ocid')) throw new ApiError(400, 'ocid만 요청할 수 있습니다.');
  const ocid = stringField(body, 'ocid', 80);
  const character = await env.DB.prepare(`
    SELECT nickname, character_level AS level FROM characters
    WHERE google_sub = ? AND ocid = ?
  `).bind(principal.sub, ocid).first<{ nickname: string; level: number }>();
  if (!character) throw new ApiError(403, '본인이 인증한 캐릭터만 그룹에 추가할 수 있습니다.');
  if (character.level < 260) throw new ApiError(400, '260레벨 이상 캐릭터만 그룹에 추가할 수 있습니다.');
  await env.DB.prepare(`
    INSERT INTO group_characters (group_id, google_sub, owner_email, nickname, added_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (group_id, google_sub, nickname) DO NOTHING
  `).bind(group.id, principal.sub, principal.email, character.nickname, new Date().toISOString()).run();
  return json({ nickname: character.nickname, ocid, added: true }, 201);
}

async function removeGroupCharacter(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'ocid')) throw new ApiError(400, 'ocid만 요청할 수 있습니다.');
  const ocid = stringField(body, 'ocid', 80);
  const character = await env.DB.prepare(`
    SELECT gc.google_sub AS ownerSub, gc.nickname
    FROM group_characters gc JOIN characters c
      ON c.google_sub = gc.google_sub AND lower(c.nickname) = lower(gc.nickname)
    WHERE gc.group_id = ? AND c.ocid = ?
  `).bind(group.id, ocid).first<{ ownerSub: string; nickname: string }>();
  if (!character) return json({ ocid, removed: false });
  if (character.ownerSub !== principal.sub && group.role !== 'admin') {
    throw new ApiError(403, '본인 캐릭터 또는 그룹 관리자만 제거할 수 있습니다.');
  }
  await env.DB.prepare(`
    DELETE FROM group_characters WHERE group_id = ? AND google_sub = ? AND lower(nickname) = lower(?)
  `).bind(group.id, character.ownerSub, character.nickname).run();
  return json({ ocid, removed: true });
}

function bossFamilyId(bossId: string): string {
  const match = bossId.match(/^(?:easy|normal|hard|extreme|chaos)_(.+)$/i);
  if (!match) throw new ApiError(400, '난이도와 보스 ID를 확인해 주세요.');
  return match[1].toLowerCase();
}

async function createGroupParty(
  env: Env,
  groupId: string,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'bossId')) throw new ApiError(400, 'bossId만 요청할 수 있습니다.');
  const bossId = stringField(body, 'bossId', 80);
  if (!bossIdPattern.test(bossId)) throw new ApiError(400, 'bossId 형식이 올바르지 않습니다.');
  const partyId = crypto.randomUUID();
  const familyId = bossFamilyId(bossId);
  await env.DB.prepare(`
    INSERT INTO group_boss_parties (id, group_id, boss_id, family_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(partyId, group.id, bossId, familyId, new Date().toISOString()).run();
  return json({ partyId, bossId, familyId, created: true }, 201);
}

async function addGroupBossParticipant(
  env: Env,
  groupId: string,
  ocid: string,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'bossId' && key !== 'partyId')) {
    throw new ApiError(400, 'bossId와 partyId만 요청할 수 있습니다.');
  }
  const bossId = stringField(body, 'bossId', 80);
  if (!bossIdPattern.test(bossId)) throw new ApiError(400, 'bossId 형식이 올바르지 않습니다.');
  const familyId = bossFamilyId(bossId);
  const requestedPartyId = body.partyId === undefined ? null : stringField(body, 'partyId', 80);
  const character = await env.DB.prepare(`
    SELECT gc.google_sub AS ownerSub, gc.nickname
    FROM group_characters gc JOIN characters c
      ON c.google_sub = gc.google_sub AND lower(c.nickname) = lower(gc.nickname)
    WHERE gc.group_id = ? AND c.ocid = ?
  `).bind(group.id, ocid).first<{ ownerSub: string; nickname: string }>();
  if (!character) throw new ApiError(404, '그룹에 등록된 캐릭터가 아닙니다.');
  if (character.ownerSub !== principal.sub && group.role !== 'admin') {
    throw new ApiError(403, '본인 캐릭터 또는 그룹 관리자만 파티를 편성할 수 있습니다.');
  }
  const existing = await env.DB.prepare(`
    SELECT p.party_id AS partyId, bp.boss_id AS bossId
    FROM group_boss_participants p JOIN group_boss_parties bp ON bp.id = p.party_id
    WHERE p.group_id = ? AND p.google_sub = ? AND lower(p.nickname) = lower(?) AND p.family_id = ?
  `).bind(group.id, character.ownerSub, character.nickname, familyId)
    .first<{ partyId: string; bossId: string }>();
  if (existing && existing.bossId === bossId && (!requestedPartyId || requestedPartyId === existing.partyId)) {
    return json({ partyId: existing.partyId, bossId, familyId, added: false });
  }
  let targetPartyId = requestedPartyId;
  let createTargetParty = !targetPartyId;
  if (targetPartyId) {
    const targetParty = await env.DB.prepare(`
      SELECT boss_id AS bossId, family_id AS familyId
      FROM group_boss_parties WHERE id = ? AND group_id = ?
    `).bind(targetPartyId, group.id).first<{ bossId: string; familyId: string }>();
    if (!targetParty) throw new ApiError(404, '그룹 파티를 찾을 수 없습니다.');
    if (targetParty.bossId !== bossId || targetParty.familyId !== familyId) {
      throw new ApiError(400, '파티의 보스가 요청한 보스와 일치하지 않습니다.');
    }
    createTargetParty = false;
  } else {
    targetPartyId = crypto.randomUUID();
  }
  if (!existing && familyId !== 'blackmage') {
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM group_boss_participants
      WHERE group_id = ? AND google_sub = ? AND lower(nickname) = lower(?)
        AND family_id != 'blackmage'
    `).bind(group.id, character.ownerSub, character.nickname).first<{ count: number }>();
    if ((count?.count || 0) >= 12) throw new ApiError(400, '캐릭터 한 명은 최대 12개 보스 파티에만 참가할 수 있습니다.');
  }
  const statements = [];
  if (createTargetParty) {
    statements.push(env.DB.prepare(`
      INSERT INTO group_boss_parties (id, group_id, boss_id, family_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(targetPartyId, group.id, bossId, familyId, new Date().toISOString()));
  }
  if (existing) {
    statements.push(env.DB.prepare(`
      DELETE FROM group_boss_participants
      WHERE party_id = ? AND google_sub = ? AND lower(nickname) = lower(?)
    `).bind(existing.partyId, character.ownerSub, character.nickname));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO group_boss_participants (party_id, group_id, google_sub, nickname, family_id, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(targetPartyId, group.id, character.ownerSub, character.nickname, familyId, new Date().toISOString()));
  await env.DB.batch(statements);
  return json({
    partyId: targetPartyId,
    bossId,
    familyId,
    replacedBossId: existing?.bossId || null,
    moved: Boolean(existing),
    added: true,
  }, existing ? 200 : 201);
}

async function removeGroupBossParticipant(
  env: Env,
  groupId: string,
  ocid: string,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'bossId' && key !== 'partyId')) {
    throw new ApiError(400, 'bossId와 partyId만 요청할 수 있습니다.');
  }
  const bossId = stringField(body, 'bossId', 80);
  const partyId = body.partyId === undefined ? null : stringField(body, 'partyId', 80);
  const character = await env.DB.prepare(`
    SELECT gc.google_sub AS ownerSub, gc.nickname
    FROM group_characters gc JOIN characters c
      ON c.google_sub = gc.google_sub AND lower(c.nickname) = lower(gc.nickname)
    WHERE gc.group_id = ? AND c.ocid = ?
  `).bind(group.id, ocid).first<{ ownerSub: string; nickname: string }>();
  if (!character) throw new ApiError(404, '그룹에 등록된 캐릭터가 아닙니다.');
  if (character.ownerSub !== principal.sub && group.role !== 'admin') {
    throw new ApiError(403, '본인 캐릭터 또는 그룹 관리자만 파티를 편성할 수 있습니다.');
  }
  await env.DB.prepare(`
    DELETE FROM group_boss_participants
    WHERE group_id = ? AND google_sub = ? AND lower(nickname) = lower(?)
      AND family_id = ? AND (? IS NULL OR party_id = ?)
  `).bind(group.id, character.ownerSub, character.nickname, bossFamilyId(bossId), partyId, partyId).run();
  return json({ bossId, partyId, removed: true });
}

async function importMapleScouterData(
  env: Env,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  const allowedFields = new Set(['nickname', 'boss380HexaScore', 'multipliers']);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw new ApiError(400, 'MapleScouter 가져오기 요청 항목을 확인해 주세요.');
  }

  const nickname = stringField(body, 'nickname', 24);
  const boss380HexaScore = body.boss380HexaScore;
  if (typeof boss380HexaScore !== 'number' || !Number.isSafeInteger(boss380HexaScore)
    || boss380HexaScore < 0 || boss380HexaScore > 100_000_000) {
    throw new ApiError(400, '보스380 헥사환산 점수 형식이 올바르지 않습니다.');
  }

  const rawMultipliers = body.multipliers === undefined ? [] : body.multipliers;
  if (!Array.isArray(rawMultipliers) || rawMultipliers.length > 100) {
    throw new ApiError(400, '보스 배율 목록 형식이 올바르지 않습니다.');
  }
  const seenBossIds = new Set<string>();
  const importedMultipliers = rawMultipliers.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ApiError(400, '보스 배율 항목 형식이 올바르지 않습니다.');
    }
    const multiplierEntry = entry as Record<string, unknown>;
    if (Object.keys(multiplierEntry).some((key) => key !== 'bossId' && key !== 'multiplier')) {
      throw new ApiError(400, '보스 배율 항목은 bossId와 multiplier만 포함할 수 있습니다.');
    }
    const bossId = stringField(multiplierEntry, 'bossId', 80).toLowerCase();
    const multiplier = multiplierEntry.multiplier;
    if (!bossIdPattern.test(bossId) || typeof multiplier !== 'number'
      || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1000) {
      throw new ApiError(400, '보스 ID 또는 배율 값이 올바르지 않습니다.');
    }
    if (seenBossIds.has(bossId)) throw new ApiError(400, '중복된 보스 배율이 있습니다.');
    seenBossIds.add(bossId);
    return { bossId, multiplier };
  });

  const character = await env.DB.prepare(`
    SELECT nickname FROM characters WHERE google_sub = ? AND lower(nickname) = lower(?)
  `).bind(principal.sub, nickname).first<{ nickname: string }>();
  if (!character) throw new ApiError(403, '이 Google 계정으로 인증한 캐릭터가 아닙니다.');

  const acceptedMultipliers = importedMultipliers;

  const updatedAt = new Date().toISOString();
  const statements = [env.DB.prepare(`
    UPDATE characters SET boss380_hexa_score = ?
    WHERE google_sub = ? AND lower(nickname) = lower(?)
  `).bind(boss380HexaScore, principal.sub, character.nickname)];
  if (acceptedMultipliers.length) {
    statements.push(...acceptedMultipliers.map(({ bossId, multiplier }) => env.DB.prepare(`
      INSERT INTO character_multipliers (google_sub, nickname, boss_id, multiplier, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (google_sub, nickname, boss_id) DO UPDATE SET
        multiplier = excluded.multiplier,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).bind(principal.sub, character.nickname, bossId, multiplier, updatedAt, principal.email)));
  }
  await env.DB.batch(statements);

  return json({
    nickname: character.nickname,
    boss380HexaScore,
    updatedMultipliers: acceptedMultipliers.length,
    ignoredMultipliers: importedMultipliers.length - acceptedMultipliers.length,
    updatedAt,
  });
}

async function createGoogleSession(env: Env, origin: string, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some((key) => !['code', 'remember'].includes(key))
    || typeof body.remember !== 'boolean') {
    throw new ApiError(400, 'code와 remember 값을 확인해 주세요.');
  }
  const code = stringField(body, 'code', 4096);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError(500, 'Google OAuth Worker 설정이 필요합니다.');
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: origin,
    }),
  });
  if (!tokenResponse.ok) throw new ApiError(401, 'Google 로그인 코드를 확인할 수 없습니다. 다시 로그인해 주세요.');
  const tokens = await tokenResponse.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token || !Number.isFinite(Number(tokens.expires_in))) {
    throw new ApiError(502, 'Google에서 로그인 토큰을 받지 못했습니다.');
  }
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) throw new ApiError(401, 'Google 계정 정보를 확인할 수 없습니다.');
  const profile = await profileResponse.json() as GoogleUserInfo;
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new ApiError(401, 'Google 계정의 인증 상태를 확인할 수 없습니다.');
  }
  let refreshToken = tokens.refresh_token || '';
  if (!refreshToken) {
    const previousSession = await env.DB.prepare(`
      SELECT refresh_token_ciphertext AS refreshTokenCiphertext
      FROM auth_sessions WHERE google_sub = ? ORDER BY created_at DESC LIMIT 1
    `).bind(profile.sub).first<{ refreshTokenCiphertext: string }>();
    if (previousSession) refreshToken = await decryptSessionValue(env, previousSession.refreshTokenCiphertext);
  }
  if (!refreshToken) {
    throw new ApiError(401, 'Google이 장기 로그인 권한을 제공하지 않았습니다. 다시 로그인해 주세요.');
  }

  const sessionToken = createSessionToken();
  const tokenHash = await sha256(sessionToken);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare(`
    INSERT INTO auth_sessions (
      token_hash, google_sub, email, name, refresh_token_ciphertext,
      access_token_ciphertext, access_token_expires_at, expires_at, created_at, remember
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tokenHash,
    profile.sub,
    profile.email.toLowerCase(),
    profile.name || '',
    await encryptSessionValue(env, refreshToken),
    await encryptSessionValue(env, tokens.access_token),
    now + Number(tokens.expires_in) * 1000,
    now + (body.remember ? sessionLifetimeMs : 12 * 60 * 60 * 1000),
    now,
    body.remember ? 1 : 0,
  ).run();
  return json({
    sessionToken,
    account: { sub: profile.sub, email: profile.email.toLowerCase(), name: profile.name || '' },
  }, 201);
}

async function revokeGoogleSession(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!/^ms_[a-f0-9]{64}$/.test(token)) throw new ApiError(401, '로그인 세션이 필요합니다.');
  await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ loggedOut: true });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
  if (path[0] !== 'api') throw new ApiError(404, '요청한 API를 찾을 수 없습니다.');
  if (request.method === 'POST' && path.length === 3 && path[1] === 'auth' && path[2] === 'google') {
    const origin = request.headers.get('Origin');
    if (!origin || request.headers.get('X-Requested-With') !== 'XMLHttpRequest') {
      throw new ApiError(403, 'Google 로그인 요청 출처를 확인할 수 없습니다.');
    }
    return createGoogleSession(env, origin, await readBody(request));
  }
  if (request.method === 'DELETE' && path.length === 3 && path[1] === 'auth' && path[2] === 'session') {
    return revokeGoogleSession(request, env);
  }

  const principal = await authenticate(request, env);
  if (request.method === 'GET' && path.length === 3 && path[1] === 'auth' && path[2] === 'session') {
    return json({ account: principal });
  }
  if (request.method === 'POST' && path.length === 3 && path[1] === 'group-invites' && path[2] === 'accept') {
    return acceptGroupInvite(env, principal, await readBody(request));
  }
  if (request.method === 'GET' && path.length === 2 && path[1] === 'groups') return listGroups(env, principal);
  if (request.method === 'GET' && path.length === 2 && path[1] === 'characters') return listCharacters(env, principal);
  if (request.method === 'GET' && path.length === 3 && path[1] === 'characters' && path[2] === 'multipliers') {
    return listCharacterMultipliers(env, principal);
  }
  if (request.method === 'GET' && path.length === 3 && path[1] === 'characters' && path[2] === 'selection') {
    return getCharacterSelection(env, principal);
  }
  if (request.method === 'PUT' && path.length === 3 && path[1] === 'characters' && path[2] === 'selection') {
    return saveCharacterSelection(env, principal, await readBody(request));
  }
  if (request.method === 'POST' && path.length === 3 && path[1] === 'characters' && path[2] === 'maplescouter-scores') {
    throw new ApiError(410, 'MapleScouter 점수는 로그인 앱의 브라우저 가져오기로 저장해 주세요.');
  }
  if (request.method === 'POST' && path.length === 3 && path[1] === 'characters' && path[2] === 'maplescouter-import') {
    return importMapleScouterData(env, principal, await readBody(request));
  }
  if (request.method === 'POST' && path.length === 2 && path[1] === 'groups') {
    return createGroup(env, principal, await readBody(request));
  }
  if (request.method === 'POST' && path.length === 3 && path[1] === 'characters' && path[2] === 'verify') {
    return verifyCharacter(env, principal, await readBody(request));
  }
  if (path.length >= 3 && path[1] === 'groups') {
    const groupId = path[2];
    if (path.length === 3 && request.method === 'PATCH') {
      return updateGroup(env, groupId, principal, await readBody(request));
    }
    if (path.length === 3 && request.method === 'DELETE') {
      return deleteGroup(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'invites' && request.method === 'POST') {
      return createGroupInvite(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'parties' && request.method === 'GET') {
      return listGroupParties(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'parties' && request.method === 'POST') {
      return createGroupParty(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'parties' && request.method === 'GET') {
      return listGroupParties(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'parties' && request.method === 'POST') {
      return createGroupParty(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'characters' && request.method === 'GET') {
      return listGroupCharacters(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'characters' && request.method === 'POST') {
      return addGroupCharacter(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'characters' && request.method === 'DELETE') {
      return removeGroupCharacter(env, groupId, principal, await readBody(request));
    }
    if (path.length === 5 && path[3] === 'party-characters' && request.method === 'POST') {
      return addGroupBossParticipant(env, groupId, path[4], principal, await readBody(request));
    }
    if (path.length === 5 && path[3] === 'party-characters' && request.method === 'DELETE') {
      return removeGroupBossParticipant(env, groupId, path[4], principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'members' && request.method === 'POST') {
      return addGroupMember(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'members' && request.method === 'DELETE') {
      return removeGroupMember(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'bosses' && request.method === 'GET') {
      return listBosses(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'bosses' && request.method === 'POST') {
      return addBoss(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'multipliers' && request.method === 'GET') {
      return listMultipliers(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'multipliers' && request.method === 'POST') {
      throw new ApiError(410, '보스 배율은 로그인 앱의 브라우저 가져오기로 저장해 주세요.');
    }
  }
  throw new ApiError(404, '요청한 API를 찾을 수 없습니다.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const origins = allowedOrigins(env);
    if (origin && !origins.has(origin)) return json({ error: '허용되지 않은 웹 출처입니다.' }, 403);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);

    try {
      return withCors(await route(request, env), origin);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, '요청을 처리하지 못했습니다.');
      return withCors(json({ error: apiError.message }, apiError.status), origin);
    }
  },
};