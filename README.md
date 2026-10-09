# MemoFam

MemoFam 프런트엔드와 Maple Scout Cloudflare Worker를 한 저장소에서 함께 관리합니다.

## 프로젝트 구조

- `src/`: React 프런트엔드
- `worker/`: Cloudflare Worker API, D1 마이그레이션 및 테스트

## 로컬 실행

프런트엔드는 저장소 루트에서 실행합니다.

```sh
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

MapleScouter는 Cloudflare Worker가 아니라 Vite 개발 서버가 실행되는 컴퓨터의 Playwright 브라우저에서 자동으로 읽습니다. 버튼을 누르면 수집한 점수와 배율을 Worker로 보내 저장합니다. Codespaces 포트 포워딩을 사용해도 크롤링은 Codespaces에서 실행되므로, 그 네트워크가 MapleScouter에 차단되면 저장소를 사용자 PC에 받아 로컬에서 실행해야 합니다. 정적 배포본에는 이 로컬 크롤러가 포함되지 않습니다.

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

## GitHub 저장소 동기화

통합 저장소는 [MemoFam-Maple-Scout](https://github.com/Kimoing/MemoFam-Maple-Scout)이며, Worker는 [maple-scout-worker](https://github.com/Kimoing/maple-scout-worker)에도 별도로 유지합니다.

- 프런트엔드만 변경한 경우 통합 저장소에 push합니다.
- `worker/` 코드나 설정을 변경한 경우 같은 Worker 변경을 두 저장소 모두에 반영하고 push합니다. 각 저장소는 별도 Git 이력을 가지므로 Worker 저장소에서는 독립적으로 커밋해야 합니다. 모노레포의 `main`을 Worker 저장소에 직접 push하거나 강제 push하지 마세요.
- 두 저장소 중 하나라도 push에 실패하면 어느 저장소가 갱신되지 않았는지 알립니다.

## 보안

Google Client ID와 Worker URL은 공개 설정입니다. Google Client Secret, Cloudflare API 토큰, Google refresh token, Nexon API 키는 프런트엔드 환경 변수에 넣지 마세요. Nexon API 키는 캐릭터 인증 요청에 사용되며 Worker에 저장되지 않습니다.
