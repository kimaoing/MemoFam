# Maple / Scout

앱에서 로그인한 사용자가 배율 새로고침을 요청하면 Cloudflare Worker가 Browser Rendering으로 MapleScouter를 열어 직접 크롤링합니다. Worker는 그룹 권한과 인증 캐릭터를 확인한 뒤 그룹 보스 목록에 해당하는 배율을 Cloudflare D1에 저장합니다. Worker 소스와 자동 배포 설정은 별도 `maple-scout-worker` 프로젝트에 있습니다.

## 로컬 실행

```sh
npm install
cp .env.example .env
npm start
```

`.env`에는 다음 공개 설정만 입력합니다. `VITE_WORKER_API_URL`에는 GitHub 배포가 완료된 Worker의 실제 URL을 설정합니다.

```dotenv
VITE_GOOGLE_CLIENT_ID=your-google-oauth-web-client-id.apps.googleusercontent.com
VITE_WORKER_API_URL=https://your-worker.your-subdomain.workers.dev
```

Google Client ID는 비밀값이 아닙니다. Worker URL도 공개 API 주소입니다. Cloudflare API 토큰, Google Client Secret, Google refresh token은 `VITE_` 변수나 이 앱의 `.env`에 절대로 넣지 마세요.

## Google 및 Worker 설정

1. Google Cloud Console에서 OAuth 웹 클라이언트와 동의 화면을 설정하고, Google Identity Services용 승인된 JavaScript 원본에 앱 Origin(로컬 개발은 `http://localhost:3000`)을 등록합니다. Redirect URI는 사용하지 않습니다.
2. Google 동의 화면이 Testing이면 로그인할 Google 계정을 테스트 사용자로 추가합니다.
3. Worker 프로젝트에서 D1 마이그레이션과 Browser Rendering 바인딩을 설정합니다. GitHub 자동 배포가 성공하면 Worker URL을 확인합니다.
4. Worker의 `APP_ORIGINS`에 프런트엔드 Origin을 등록하고 다시 배포합니다.
5. 실제 Worker URL을 앱의 `VITE_WORKER_API_URL`에 넣고 앱을 다시 시작합니다.

앱에서 Google 로그인 후 Nexon API 키로 캐릭터를 인증하고 그룹을 만든 다음, 관리자가 그룹별 bossId와 구성원을 등록합니다. 배율 새로고침은 인증된 Worker에 `{ "nickname": "캐릭터닉네임" }`만 보내며, 크롤링과 D1 저장은 Worker가 수행합니다. 이 프로젝트의 앱 코드에는 MapleScouter 크롤러가 없습니다.

Nexon API 키는 캐릭터 인증 시 HTTPS로 Worker에 전달되며 저장되지 않습니다. Google Client ID와 Worker URL은 공개 설정이며, Google Client Secret·Cloudflare API 토큰·Nexon API 키를 `VITE_` 환경변수로 설정하지 마세요.

Cloudflare API 토큰은 Worker 배포를 위해 Wrangler CLI가 필요할 때만 사용하고, 프런트엔드 환경변수로 전달하지 마세요. `wrangler login`을 사용하거나 Cloudflare의 Worker secret 입력 명령으로 서버 전용 비밀값을 등록합니다.
