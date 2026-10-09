# 작업 계획: 그룹 파티 UX 및 설정 개편

## 목표

- 보스 배율을 그룹 복사본이 아니라 캐릭터 소유 계정의 데이터로 관리해, 그룹마다 별도로 동기화하지 않도록 한다.
- 그룹 메인 화면에서 보스 아이콘과 난이도 아이콘으로 파티 편성 과정을 쉽게 찾고, 편성/취소 진행 상태를 명확히 보여준다.
- 그룹 관리에서는 그룹/로스터 설정에 집중하고, 파티 편성은 그룹 메인 화면 한 곳으로 모은다.
- 그룹 삭제와 그룹 메인 이미지 설정, 사이드바 폭·세로 정렬 및 설정 아이콘을 정리한다.
- 검증 후 관련 변경을 커밋하고 push한다.

## 구현 순서

1. [완료] 현재 브랜치와 기존 변경사항, 보스·배율 스키마/API, 그룹/파티 UI와 CSS를 조사한다. 다른 작업의 변경은 보존한다.
2. [완료] [worker/migrations/0010_character_multipliers_and_group_settings.sql](./worker/migrations/0010_character_multipliers_and_group_settings.sql)을 추가한다. 기존 그룹 배율은 그룹 참여 캐릭터 및 저장된 Google 세션 이메일로 소유자를 식별해 최신 값 하나로 옮기고, 기존 테이블은 그룹 삭제의 영향을 받지 않는 `legacy_group_multipliers` archive에 보존한다. 소유자를 안전하게 식별할 정보가 없는 이전 행도 archive에 남는다.
3. [완료] MapleScouter 배율 저장을 `google_sub + nickname + boss_id` 기준으로 변경한다. 계정 전체 조회 API와 그룹 캐릭터별 조회 및 파티 합산이 같은 소유 배율을 사용한다. 그룹을 바꿔 가며 별도로 동기화할 필요가 없다.
4. [완료] 그룹 메인 화면에서 보스별 아이콘과 난이도 배지로 편성 창을 연다. 창에서 후보 배율, 기존 파티, 합산 배율, 새 파티 추가, 드래그앤드롭 및 취소 동작을 제공한다.
5. [완료] 관리자 설정에 보스 아이콘 라이브러리에서 그룹 대표 이미지를 선택·저장하고, 확인 절차를 거쳐 그룹을 삭제하는 기능을 추가한다. 선택한 이미지는 그룹 사이드바 아이콘으로 표시한다.
6. [완료] 그룹 설정 화면에 그룹 메인 복귀 버튼을 추가하고, 화면에서 별도 파티 편성 UI를 노출하지 않는다.
7. [완료] 사이드바가 화면 높이를 채우도록 조정하고 가로 폭과 아이콘 크기를 정리한다. 계정 설정은 톱니바퀴만 표시한다.
8. [완료] 로그인 화면에서 서버 세션 내부 구현 설명 문구를 제거한다.
9. [완료] 프런트엔드/Worker 테스트, 타입검사, 빌드, D1 migration SQL 검증을 마쳤다. README 첫 줄은 기존 사용자 작성 내용이므로 trailing whitespace도 보존한다.
10. [완료] 변경 파일을 검토
하고 커밋해 `origin/main`에 push한다. 이 계획 문서는 push 후에도 삭제하지 않는다.

## 완료 기준

- 같은 캐릭터의 배율은 한 번만 저장·동기화되며, 그룹 미참여 캐릭터도 계정에서 배율을 조회할 수 있고, 그룹에 참여한 경우에도 동일 값으로 표시된다.
- 보스와 난이도 선택이 아이콘 중심으로 동작하고, 편성 과정을 취소하거나 다른 보스로 바꿀 수 있다.
- 복수 파티, 파티원 배율 합산, 드래그앤드롭이 유지된다.
- 관리자 그룹 삭제는 확인 후 동작하고, 그룹 이미지 선택 결과가 새로고침 뒤에도 유지된다.
- 그룹 관리 화면에 파티 편성 UI가 없고, 그룹 메인 화면 복귀 경로가 있다.
- 앱/Worker 검증을 통과하고 작업을 push한다.
- `PLAN.md`와 직접 해야 하는 Cloudflare 작업 절차가 저장소에 남아 있다.

## 사용자가 직접 수행할 Cloudflare 작업

Cloudflare 인증은 이 개발 환경에 연결되어 있지 않으므로 아래 운영 작업은 코드 push 후 사용자가 직접 수행해야 한다. Wrangler 인증이 가능한 로컬 환경에서는 `cd worker && npm run db:migrate:remote`를 우선 사용하면 migration 기록도 함께 관리된다. Cloudflare 대시보드에서 직접 실행한다면 `worker/migrations/` SQL 내용을 붙여넣는다.

1. D1 Database `maple-scout-db`에서 `d1_migrations`를 확인한다. 아직 적용되지 않았다면 `0009_persistent_auth_sessions.sql`을 먼저 적용하고, 그 다음 `0010_character_multipliers_and_group_settings.sql`을 적용한다. 0010은 0006/0009의 `group_characters`, `auth_sessions`를 사용하므로 순서가 중요하다. migration 전체가 성공한 뒤에만 해당 파일명을 `d1_migrations`에 기록한다. `npm run db:migrate:remote`를 쓰면 Wrangler가 이를 자동으로 처리한다.
2. 0010은 기존 `multipliers` 테이블을 `legacy_group_multipliers`로 이름을 바꾼 뒤 새 소유 캐릭터 테이블을 만든다. 캐릭터 소유자를 확인할 수 있는 예전 값은 최신 `updated_at` 기준으로 옮긴다. 소유자를 판별할 수 없는 행은 archive에 보존되므로, 필요하면 배포 전에 D1에서 legacy 데이터와 그룹 참여 관계를 확인한다.
3. Worker secrets가 아직 없으면 다음을 설정한다: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`. `SESSION_ENCRYPTION_KEY`는 안전하게 보관하고 임의로 바꾸지 않는다.
4. DB migration 성공 후 Worker를 배포한다. push된 프런트엔드도 정적 호스팅에서 배포됐는지 확인한다.
5. 로그인 유지, 그룹 목록/대표 아이콘, 캐릭터 배율 조회, 같은 보스 다중 파티, 그룹 삭제를 운영에서 확인한다. 그룹 삭제는 되돌릴 수 없다.

## 작업 메모

- 사용자가 이전에 직접 추가한 `worker/README.md` 첫 줄과 그 trailing whitespace를 임의로 삭제하거나 고치지 않는다.
- Cloudflare D1/Worker 운영 migration·배포는 이 환경에서 인증이 가능하다고 가정하지 않는다.
- 기존 미커밋 변경은 현재 작업에 필요한 부분만 검토·커밋하고, 무관한 변경을 되돌리지 않는다.
