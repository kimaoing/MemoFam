# MemoFam

MemoFam 프런트엔드와 Maple Scout Cloudflare Worker를 한 저장소에서 함께 관리합니다.

## 프로젝트 구조

- `src/`: React 프런트엔드
- `worker/`: Cloudflare Worker API, D1 마이그레이션 및 테스트
- `browser-extension/`: MapleScouter 결과를 사용자 브라우저에서 읽는 Chrome/Edge 확장

## 캐릭터 설정

앱의 **계정 설정**에서 Nexon API 키를 입력하고 260레벨 이상 캐릭터를 불러온 뒤, 실제 사용할 캐릭터만 체크합니다. 새로 불러온 캐릭터는 자동 선택되지 않습니다. 메인 화면과 그룹 일정에는 체크된 캐릭터만 나타나며, 그룹에 초대된 뒤 사용 캐릭터를 선택하면 해당 캐릭터가 그룹에도 자동 참여합니다. 그룹 설정에서 직접 제거한 캐릭터는 사용 캐릭터로 남아 있어도 자동으로 다시 참여하지 않으며, 원할 때 그룹 설정의 참여 버튼으로 다시 추가할 수 있습니다. 갱신 버튼은 체크된 캐릭터 전원을 차례로 동기화한 뒤 MapleScouter 탭을 닫습니다. 사용 캐릭터 선택은 Google 계정 설정과 현재 브라우저에 저장되어 계정 로그인 후 다른 브라우저에서도 복원됩니다.

## 로컬 실행

프런트엔드는 저장소 루트에서 실행합니다.

```sh
npm install
cp .env.example .env
npm start
```

MapleScouter 결과는 사용자 브라우저에서 확장이 읽습니다. 갱신 버튼을 누르면 확장 설치 여부를 먼저 확인하며, 감지되지 않으면 앱에 ZIP 다운로드와 설치 단계를 표시합니다. ZIP을 내려받아 압축을 푼 뒤 Chrome/Edge의 `chrome://extensions` 또는 `edge://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드**를 선택하세요. 설치된 확장은 결과 탭을 자동으로 읽어 Worker에 저장합니다. Vite 서버, Playwright, 북마클릿은 사용하지 않습니다.

앱을 Codespaces나 Vercel에서 제공해도 확장이 설치된 사용자 브라우저에서 MapleScouter 페이지를 읽습니다. Worker의 `APP_ORIGINS`에는 앱의 실제 Origin을 등록해야 합니다. 확장은 MapleScouter의 차단을 우회하지 않으며, 사이트가 사용자 브라우저 접속도 차단하면 수집할 수 없습니다.

확장 ZIP 재생성:

```sh
zip -j -X -FS public/memofam-maplescouter-reader.zip browser-extension/manifest.json browser-extension/app-bridge.js browser-extension/content.js
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
npm run extension:test
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
