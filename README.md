# MemoFam

MemoFam 프런트엔드와 Maple Scout Cloudflare Worker를 한 저장소에서 함께 관리합니다.

## 프로젝트 구조

- `src/`: React 프런트엔드
- `worker/`: Cloudflare Worker API, D1 마이그레이션 및 테스트

## 로컬 실행

프런트엔드는 저장소 루트에서 실행합니다.

```sh
npm install
cp .env.example .env
npm start
```

Worker 의존성은 별도로 설치하고 다른 터미널에서 실행합니다.

```sh
npm --prefix worker ci
npm run worker:dev
```

로컬 프런트엔드 설정 예시:

```dotenv
VITE_GOOGLE_CLIENT_ID=your-google-oauth-web-client-id.apps.googleusercontent.com
VITE_WORKER_API_URL=http://localhost:8787
```

`worker/wrangler.jsonc`의 `APP_ORIGINS`에 프런트엔드 Origin을 등록해야 합니다. 배포 Worker를 사용할 때는 `VITE_WORKER_API_URL`을 실제 Worker URL로 설정합니다.

## 확인 및 배포

```sh
npm test
npm run build
npm run worker:test
npm run worker:typecheck
npm run worker:deploy
```

Worker 전용 설정, D1 마이그레이션 및 Cloudflare 배포 절차는 [worker/README.md](worker/README.md)를 참고하세요.

## 보안

Google Client ID와 Worker URL은 공개 설정입니다. Google Client Secret, Cloudflare API 토큰, Google refresh token, Nexon API 키는 프런트엔드 환경 변수에 넣지 마세요. Nexon API 키는 캐릭터 인증 요청에 사용되며 Worker에 저장되지 않습니다.
