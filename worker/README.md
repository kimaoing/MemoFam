그리고 (이미지1) 목록 가시성이 너무 떨어져. 
상위 보스부터 차례대로 띄워주고
그리고 src/bossimage에 있는 이미지 파일 이용해줘
그리고 보스 난이도별로 다 적어놓지말고
내가보내준 이미지2 처럼 E H N E 이렇게 표시하면 더 깔끔해질것같아
알아서 가시성좋게 바꿔주고
이미지3에서
미완료목록에서 보이는 캐릭터 이미지 너무 작으니까 좀더 키워주고
그리고 목록선택창에서 굳이 미완료인지 보여줄필요없어. 등록돼있는 컨텐츠에대해 미완료인지 완료인지를 그 아래 칸에 표시를해주면 좋겠지
미완료목록을 먼저 표시해주고 뒤에 완료목록을 초록색계열로 완료했다고 표시를 해주고.
그리고 그룹 관련 기능 대 개편이 필요해
같은 보스라도 여러 파티가 있을수있어
그리고 보스에 파티원들의 배율 합을 표시할수있어야해 100%이상 돼야 잡을수있으니까
드래그앤드롭으로 파티를 조정할수있었으면 좋겠어
그리고 드래그앤드롭으로 파티를 조정하고자할때 캐릭터의 배율을 볼수있어야 파티조정하기가 편할거야
사용자경험 고려해서 UI/UX 잘 배치해줘
그리고 그 파티가 완료됐는지(보스를 클리어했는지)에대한 조회를 파티 중 파티원 한명의 스케쥴API를 통해 완료됐는지 확인해서 클리어됐으면 클리어됐다고 표시하고 안됐으면 안됐다고 표시해줘야해

그리고 그룹에 내 캐릭터가 보스에 편성되어있으면 내 캐릭터 관리하는 메인화면에서 그게 보이면 좋겠지?
어느 그룹에 편성되어있는지 보여주는것도 좋고 그 그룹 파티편성정보로 바로가기하는 버튼도 있으면 좋겠고
그리고 그룹 화면이 아니더라도
내 캐릭터 관리하는 메인화면에 내 캐릭터가 편성된 파티자체를 그냥 보여주는게 굉장히 좋을것같아.
다 되면 push해줘
**남은 작업 순서**

1. Cloudflare D1 콘솔에서 `0008_multiple_boss_parties.sql`의 SQL을 실행하고, 성공한 뒤 `d1_migrations`에 `0008_multiple_boss_parties.sql`을 기록합니다. 콘솔에서는 파일명이 아니라 SQL 내용을 붙여넣어야 합니다.
2. migration 적용 후 Worker를 배포합니다. 그 전에는 새 Worker 코드가 운영 DB 스키마와 맞지 않습니다.
3. 그룹 화면을 party 단위 UI로 마무리합니다. 현재 Worker는 동일 보스의 여러 파티와 party별 멤버·배율·스케줄 조회를 지원하지만, 앱 화면은 아직 보스별 묶음 표시라 파티 구분·드래그 편성·합산 배율·클리어 상태 UI가 남아 있습니다.
4. 내 정보 화면에 내 party 목록과 그룹 이동 버튼을 연결하고, 드래그 편성 및 클리어 상태 테스트를 추가합니다.
5. 전체 검증 후 다시 두 저장소에 커밋·푸시합니다.

# Maple Scout Worker

이 저장소는 MapleStory 그룹 앱의 API를 제공하는 Cloudflare Worker입니다. MapleScouter 크롤링은 사용자 브라우저에 설치한 MemoFam 확장이 결과 페이지 DOM에서 수행하며, 로그인 앱이 보스380 헥사 점수와 배율을 Worker에 전송합니다. Worker는 입력과 권한을 검증한 뒤 Cloudflare D1에 저장합니다. Cloudflare Worker Browser Rendering 바인딩은 사용하지 않습니다.

## 보안 구조

- 브라우저는 Google Identity Services의 일회용 authorization code를 Worker로 보냅니다. Worker는 code를 교환해 Google 계정을 확인하고, refresh token은 AES-GCM으로 암호화해 D1에 저장합니다. Google client secret과 암호화 키는 Worker secret으로만 보관합니다.
- 로그인 유지 선택 시 브라우저에는 Google 토큰이 아닌 무작위 세션 키만 저장하며, 세션 키의 해시만 D1에 보관합니다. Worker 세션은 30일간 미사용 시 만료되고 활동 중에는 연장됩니다. 로그인 유지 미선택 시 12시간 미사용하면 만료됩니다. 로그아웃하면 현재 세션 키를 폐기합니다.
- Cloudflare D1에는 Google 계정 subject, 인증 캐릭터, 그룹 소유자, 그룹 멤버십, 보스 목록, 배율을 저장합니다.
- Nexon API 키를 입력하면 해당 키의 전체 캐릭터 목록을 동기화하고 캐릭터 기본 정보와 스케줄러 수행 현황을 함께 저장합니다. API 키는 요청 처리 중에만 사용하며 저장하지 않습니다.
- MapleScouter 데이터는 사용자 브라우저의 확장이 수집하고, Google 로그인 상태인 앱이 Worker로 전달합니다. Worker는 캐릭터 소유권과 점수·배율 범위를 검증합니다. 배율은 그룹이 아닌 캐릭터에 귀속됩니다.
- Nexon API 키는 캐릭터 인증 요청을 위해 HTTPS로 Worker에 전달되지만 저장하거나 로그에 남기지 않습니다. 키가 사용자 컴퓨터 밖으로 절대 나가면 안 된다면 Worker가 인증을 독립적으로 검증할 수 없습니다.

## 앱 구조

- **프런트엔드**: Google 로그인, 캐릭터 인증, 그룹/멤버 관리, 보스 배율 새로고침 UI를 담당합니다. 프런트엔드 코드는 이 저장소에 포함되어 있지 않습니다.
- **Cloudflare Worker (`src/index.ts`)**: CORS와 서버 로그인 세션을 확인하고 API 요청을 처리합니다. 캐릭터 인증은 Nexon Open API에 요청하고, 앱이 전달한 확장 수집 MapleScouter 데이터는 검증 후 D1에 저장합니다.
- **Cloudflare D1 (`migrations/`)**: 그룹별 설정과 파티, 캐릭터, 캐릭터 소유 배율 및 로그인 세션 데이터를 보관합니다.

로그인된 사용자는 본인이 속한 그룹만 조회할 수 있습니다. 관리자는 그룹 멤버·대표 이미지·삭제를 관리하고, 사용자는 자기 Google 계정에 인증된 캐릭터의 배율을 갱신합니다.

## Google 로그인 준비

1. Google Cloud 프로젝트에서 OAuth 동의 화면을 설정합니다. 외부 사용자가 로그인하는 운영 앱은 Google의 게시/검증 요구사항을 확인합니다.
2. **웹 애플리케이션** OAuth Client ID를 만들고, 프런트엔드 주소(예: `http://localhost:3000`)를 승인된 JavaScript 원본에 추가합니다.
3. 프런트엔드 Google Identity Services 설정에 Client ID를 넣고 `openid email profile` 범위로 로그인합니다. Google OAuth Client ID의 승인된 JavaScript 원본에는 프런트엔드 주소를 등록합니다.

Worker에도 같은 OAuth Client ID와 Client Secret을 secret으로 등록합니다. Google Cloud Console에서 같은 OAuth Client ID에 프런트엔드 origin을 승인된 JavaScript 원본으로 추가해야 합니다. Popup code flow는 authorization code를 받은 브라우저 origin을 token 교환에 사용합니다.

## Cloudflare 배포

```sh
npm install
npx wrangler login
npm run db:create
```

Google code-flow login을 위해 Worker secrets를 설정합니다.

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_ENCRYPTION_KEY
```

`GOOGLE_CLIENT_ID`는 프런트엔드의 `VITE_GOOGLE_CLIENT_ID`와 같은 값입니다. `SESSION_ENCRYPTION_KEY`에는 충분히 긴 임의의 비밀 값을 사용하고 안전한 비밀 저장소에 별도로 보관하세요. 키를 잃거나 교체하면 기존 D1 refresh token을 복호화할 수 없어 사용자가 다시 로그인해야 합니다.
로컬 Worker 개발에서는 같은 항목을 `worker/.dev.vars`에 설정합니다. 이 파일은 Git에서 제외됩니다.

`npm run db:create` 출력에 있는 D1 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_D1_DATABASE_ID` 자리에 입력한 다음 스키마를 적용합니다.

```sh
npm run db:migrate:remote
```

새 D1 데이터베이스에는 모든 migration을 적용한 뒤 Worker를 배포하세요. `wrangler.jsonc`의 `APP_ORIGINS`에 실제 프런트엔드 주소를 쉼표로 구분해 등록합니다. 주소 끝에 `/`는 붙이지 않습니다.

기존 Google Sheet에 보스 목록이나 배율 데이터가 있다면 자동 이전되지는 않습니다. 새 D1 배포 후 그룹 관리자가 보스를 다시 등록해야 하고, 각 캐릭터의 배율도 새로고침해야 합니다.

배포 및 상태 확인:

```sh
npm run deploy
curl https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/api/health
```

## GitHub에 push

변경사항을 커밋한 뒤 `main` 브랜치에 push합니다.

```sh
git add <파일>
git commit -m "변경 내용"
git push origin main
```

Codespaces에서 `Write access to repository not granted` 오류가 나면, 환경의 제한된 `GITHUB_TOKEN` 대신 저장된 GitHub 인증을 사용해 push합니다.

```sh
env -u GITHUB_TOKEN git push origin main
```

이 명령은 해당 push에만 `GITHUB_TOKEN`을 제외합니다. 그래도 거부되면 현재 GitHub 계정에 저장소 쓰기 권한이 있는지 확인합니다.

## API

GET /api/health와 POST /api/auth/google 외 보호된 요청에는 Worker가 발급한 서버 세션 키를 Authorization 요청 헤더로 보내야 합니다. 최초 로그인 요청에는 허용된 Origin과 X-Requested-With: XMLHttpRequest 헤더가 필요합니다. 프런트엔드는 openid email profile 범위로 authorization code를 요청합니다. 요청 본문은 64 KiB 이하이며, Worker의 APP_ORIGINS에 실제 웹 앱 Origin을 등록해야 합니다.

| Method | Route | 기능 |
| --- | --- | --- |
| `GET` | `/api/health` | 공개 상태 확인 |
| `POST` | `/api/auth/google` | Google authorization code를 서버 세션으로 교환 |
| `GET` | `/api/auth/session` | 현재 서버 세션 계정 조회 |
| `DELETE` | `/api/auth/session` | 현재 서버 세션 폐기 |
| `POST` | `/api/characters/verify` | API 키 계정의 전체 캐릭터, 기본 정보, 스케줄러 현황 동기화 |
| `GET` | `/api/characters` | 로그인 사용자의 캐릭터 및 저장된 스케줄러 현황 조회 |
| `POST` | `/api/characters/maplescouter-import` | 보스380 헥사 점수와 캐릭터 소유 보스 배율을 검증해 저장 |
| `GET` | `/api/characters/multipliers` | 로그인 계정의 캐릭터 소유 배율 전체 조회 |
| `GET` | `/api/groups` | 로그인 사용자가 속한 그룹 목록 |
| `POST` | `/api/groups` | D1에 그룹 생성, 요청 사용자를 관리자 지정 |
| `PATCH` | `/api/groups/:id` | 그룹 관리자의 대표 이미지 설정 |
| `DELETE` | `/api/groups/:id` | 그룹과 종속 파티/참여 데이터 삭제 |
| `POST` | `/api/groups/:id/members` | 그룹 관리자가 이메일 멤버 추가 |
| `DELETE` | `/api/groups/:id/members` | 그룹 관리자가 멤버 제거 |
| `GET` | `/api/groups/:id/bosses` | 그룹의 bossId 목록 조회 |
| `POST` | `/api/groups/:id/bosses` | 관리자가 D1에 bossId 추가 |
| `GET` | `/api/groups/:id/multipliers` | 그룹 캐릭터의 캐릭터 소유 배율 조회 |
| `GET` | `/api/groups/:id/parties` | 그룹 파티와 파티원별 캐릭터 배율 조회 |
| `PUT` | `/api/groups/:id/parties/commit` | 파티 편성 초안 전체를 검증한 뒤 D1 batch로 한 번에 저장 |

캐릭터 동기화 요청에는 Nexon API 키만 전달합니다. Worker는 캐릭터 목록에서 260레벨 이상인 캐릭터만 기본 정보와 스케줄러 현황을 조회해 Google 계정에 연결하고, API 키는 저장하지 않습니다. Nexon API 요청은 동기화 요청 안에서 초당 최대 5회가 되도록 간격을 두고 전송합니다. 기본 정보 조회에 실패한 캐릭터는 해당 동기화에서 건너뛰지만, 이미 저장된 캐릭터 정보는 삭제하지 않습니다. 스케줄러 조회에 실패해도 기본 정보가 있는 캐릭터는 등록하며, 스케줄 정보만 비워 둡니다. 캐릭터 기본 정보는 별도 조회 기준일 없이 가져오며, 스케줄러는 Nexon API의 `/maplestory/v1/scheduler/character-state` 응답을 사용합니다. 최신 현황이 필요하면 API 키를 다시 입력해 동기화합니다.

캐릭터 화면에서 MapleScouter 자동 갱신을 실행하면 사용자 브라우저의 확장이 결과를 읽고 앱이 이를 `POST /api/characters/maplescouter-import`로 전송합니다. 점수는 `/api/characters` 응답에 포함되며, 배율은 `/api/characters/multipliers`에서 조회할 수 있습니다. 로그인 사용자가 소유한 캐릭터라면 그룹 가입 여부와 관계없이 보스 배율을 저장합니다.

```json
{
  "nickname": "오잉느",
  "boss380HexaScore": 67619,
  "multipliers": [
    { "bossId": "hard_kaling", "multiplier": 25.5 }
  ]
}
```

```json
{
  "apiKey": "NEXON_OPEN_API_KEY"
}
```

배율 새로고침 요청 예시:

```json
{
  "nickname": "오잉느"
}
```

닉네임은 현재 로그인한 Google 계정으로 인증된 캐릭터와 일치해야 합니다. 각 `bossId`는 고유해야 하며 배율은 0~1000 사이의 숫자여야 합니다.

## 검증

```sh
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

## 캐릭터 배율 및 그룹 설정 migration (최신)

`0010_character_multipliers_and_group_settings.sql`부터 보스 배율은 그룹이 아닌 인증 캐릭터에 귀속됩니다. 이 migration은 기존 `multipliers` 전체를 그룹 삭제에 영향받지 않는 `legacy_group_multipliers` archive로 복사하고, 그룹 캐릭터 또는 저장된 로그인 세션 이메일로 소유자를 식별할 수 있는 값만 `character_multipliers`로 옮깁니다. 같은 캐릭터/보스에 여러 그룹 값이 있으면 가장 최근 `updated_at`을 사용합니다. 소유자를 확인하지 못한 기존 값은 legacy 테이블에 남으므로 필요 시 확인할 수 있습니다.

새 배율 가져오기 요청에는 그룹 ID를 보내지 않습니다.

```json
{
  "nickname": "오잉느",
  "boss380HexaScore": 67619,
  "multipliers": [
    { "bossId": "hard_kaling", "multiplier": 25.5 }
  ]
}
```

그룹 이미지 설정은 앱에 포함된 보스 아이콘 중 하나를 `main_image_boss_id`에 저장합니다. 별도 이미지 업로드 버킷은 필요하지 않습니다. 그룹 삭제는 관리자만 가능하며 그룹의 파티/참여 데이터도 cascade 삭제됩니다.

`GET /api/characters/multipliers`는 현재 로그인 계정이 소유한 전체 캐릭터 배율을 돌려줍니다. `GET /api/groups/:id/multipliers`는 그룹 참여 캐릭터의 소유 배율만 조회하며, 그룹별 저장/동기화 API는 제공하지 않습니다.
`PATCH /api/groups/:id`는 관리자 전용 대표 이미지 설정, `DELETE /api/groups/:id`는 관리자 전용 그룹 삭제입니다. 그룹 이미지 값은 이미지 자산을 매칭할 보스 ID입니다.

운영 DB에 수동 적용할 경우 현재 적용된 migration을 확인하고 `0009_persistent_auth_sessions.sql` 다음에 `0010_character_multipliers_and_group_settings.sql` 내용을 실행합니다. 실행이 완전히 성공한 후에만 migration 파일명을 `d1_migrations`에 기록하세요. Wrangler 인증이 되는 개발 환경에서는 `npm run db:migrate:remote`를 이용하면 순서와 기록을 Wrangler가 처리합니다. 이 작업 후 Worker를 배포합니다.
