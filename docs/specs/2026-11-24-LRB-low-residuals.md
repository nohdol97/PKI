# 스펙: 남은 낮은 지적 묶음(LRB) — 피드백 잠금 문구, API 시간 제한, 잘린 작업 목록, `testIgnore` 해석, 색인 포트 읽기 항목 타입

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 LRB-D1~D5 포함)
- 관련: 이슈 #360(F1·F2), #349(F4·F5), #353(진행 로그의 남은 지적 ①·②). [UIF2 spec](2026-11-24-UIF2-ui-followups.md), [HVT spec](2026-11-24-HVT-h03-verification-tools.md), [FUB spec](2026-11-24-FUB-session-followups.md), [IGF spec](2026-11-24-IGF-igt-followups.md)
- 번호: 요구사항 `LRB-R<n>`, 완료 기준 `LRB-C<n>`, 결정 `LRB-D<n>`. **제품 코드·마이그레이션·계약·e2e 변경 없음.** 고치는 곳은 시험 파일 하나와 문서뿐이다.
- 기준 코드: `origin/main` `736b10a4`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

| 항목 | 분류 | 근거 | 처리 |
|---|---|---|---|
| #360 F1 잠금 중 누름을 버림 | 문구 | `createFeedbackCalls`(`apps/web/src/feedback.tsx:49-70`)의 `createBusy`는 앞 답 전의 누름을 보내지 않고 `undefined`를 준다(UIF2-R4 그대로). UIF2-D2의 "앞 답을 기다린다"만 줄 세우는 것처럼 읽혔다 | **D2 문구를 고침(반영함)**. D1 |
| #360 F2 API 시간 제한 없음 | 결정(닫음) | `createApiClient`(`apps/web/src/api.ts:46-73`)는 `fetch`에 `signal`이 없다. 그러나 `createBackup`·`inspectRestore`·`restoreBackup`은 요청 안에서 일을 끝낸다(`backend/src/backup-api.ts:184`, `:214`, `:250`) — 걸리는 시간이 자료 크기에 따른다 | 고치지 않음. D2 |
| #349 F4 잘린 목록의 가려진 실패 | 닿지 않음(닫음) | 과다 집계는 `failedJobCounts`(`backend/src/system-measure.test-support.ts:595-606`)가 목록이 잘렸을 때만 생긴다. 목록은 100줄(`backend/src/jobs-view.ts:35`)이고, 유실·중복을 세는 kill 단계는 문서 10개(`system-measure.test-support.ts:29`, 다른 호출은 시험의 3개)를 두 번 가져온다 | 고치지 않음. D3 |
| #349 F5 `testIgnore` 첫 목록·큰따옴표만 | 닿지 않음(닫음) | `playwright.config.ts`의 `testIgnore`는 `browser` 프로젝트 하나뿐이고(`:15`), 따옴표는 `pnpm lint`의 `prettier --check`(기본 큰따옴표)가 강제한다 | 고치지 않음. D4 |
| #349 F3 뒷정리 블록 시험 | 범위 밖 | FUB-D3(주입 지점 없음) 그대로. 지금도 쉬운 이음새가 없다 | 다루지 않음 |
| #353 ① 쓰기 인자 말고는 느슨함 | 측정 → 시험 한 줄 | 아래 측정. 반환 항목 타입은 일부만 잡힌다 | R1 |
| #353 ② 필수/선택만 뒤집힘 | 측정(닫음) | 아래 측정. 지금 단언이 이미 잡는다 | D5 |
| #360 `.sub-title` 모양 | 비목표 | 실제 브라우저 확인 | 다루지 않음 |

**측정(#353 ①·②).** 포트와 같은 모양(메서드 문법 인터페이스, IGT-C1의 `Same<>`)을 `/tmp`의 따로 된 파일로 만들어 저장소의 `tsc` 6.0.3으로 `--strict --exactOptionalPropertyTypes` 검사했다(언어 수준 재현이고, 저장소 파일은 건드리지 않았다).

| 사례 | 결과 |
|---|---|
| 쓰기 인자 필드가 색인 쪽은 필수, 포트 쪽은 선택(또는 그 반대) — ② | `Same<Parameters…>`가 `false`라 **잡힘**(`keyof` 비교는 같아서 잡지 못함) |
| 반환 항목 필드의 타입을 색인 쪽에서 넓힘 | 대입 `port = index`가 **잡음**(반환은 공변) |
| 반환 항목 필드가 색인 쪽은 선택, 포트 쪽은 필수 | 대입이 **잡음** |
| 반환 항목에 색인 쪽만 필드가 더 있음 / 포트 쪽만 선택 필드가 있음 / 색인 쪽은 필수·포트 쪽은 선택 | 대입을 **통과** — 남은 구멍. 포트 쪽만 있는 선택 필드는 커넥터가 늘 `undefined`를 읽는다 |
| 읽기 메서드 인자를 색인 쪽에서 좁힘(`"only"` 대 `string`) | 메서드 쌍변성으로 **통과**. 지금 읽기 메서드 인자는 모두 `string`·`number`라 해당 없음 |

쓰기 결과(`LocalIndexWrite`의 `reason: string` 대 색인의 좁은 합집합)는 포트가 일부러 넓힌 것이라 같게 묶지 않는다.

## 목표 / 비목표

- 목표: 색인 포트의 읽기 항목 타입(`LocalIndexEntry`)이 색인의 `LocalFileEntry`와 어긋나면 컴파일 시점에 잡는다. 나머지 지적은 근거를 적고 닫는다.
- 비목표: 피드백 단추 비활성화·잠금 안내(D1), API 클라이언트 시간 제한(D2), 작업 API 계약 변경(D3), `testIgnore`의 프로젝트별 판정(D4), #349 F3, `.sub-title`, 포트·계약 타입 자체의 변경, e2e 파일.

## 요구사항

- **LRB-R1** IGT-C1 사례(`backend/src/local-files-connector.test.ts` 「the canonical index satisfies the port (compile-time)」)에 `LocalFileEntry`(`@pki/storage`)와 `LocalIndexEntry`(`@pki/contracts`)의 `Same<>`(상호 대입)과 `keyof` 집합의 `Same<>`을 더한다. 기존 `Same`·`expect` 모양을 그대로 쓴다.

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 · 빨개져야 하는 변이 |
|---|---|---|
| LRB-C1 | `pnpm typecheck`이 0으로 끝나고 `pnpm exec vitest run backend/src/local-files-connector.test.ts`가 초록이다. `packages/contracts/src/local-files.ts`의 `LocalIndexEntry`에 선택 필드 하나(예: `note?: string`)를 더하면 `pnpm typecheck`이 R1의 단언 줄에서 실패한다(R1) | `backend/src/local-files-connector.test.ts` IGT-C1 사례 "the write arguments …"에 더한 두 단언. **`736b10a4`에서도 초록**(두 타입의 15개 필드가 지금 같다). 변이: 위 선택 필드 추가 — `736b10a4`에서는 typecheck를 통과하고(측정 표 넷째 줄), R1 뒤에는 실패해야 한다. 보안 가드가 아니지만 이 단언의 유일한 존재 이유라 한 번 확인 |

다른 기준은 두지 않는다(테스트 간략화 규칙 1). 시험 이름 문구(`the write arguments …`)는 읽기 항목도 덮도록 고쳐도 된다.

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| LRB-D1 | #360 F1은 UIF2-D2 문구만 고친다(버린다·안내 없음·비활성화 없음). 단추를 비활성화하지 않는다 | 버려지는 때는 로컬 백엔드 요청 한 번의 길이다. 비활성화하려면 `createBusy`를 React 상태로 드러내 피드백 네 컴포넌트의 단추에 잇는 배선이 필요한데, 웹 단위 시험엔 DOM이 없어(X02F-D5) 그 배선을 시험할 수 없다 | `createBusy`에 상태 알림을 더하고 `useRecord`·두 목록이 `busy` 상태로 단추에 `disabled`를 단다 |
| LRB-D2 | #360 F2는 API 클라이언트에 시간 제한을 두지 않는다 | 백엔드는 같은 기기의 자식 프로세스다. 끝나지 않는 요청은 백엔드 결함이고 시간 제한은 그것을 고치지 않는다. 한 값의 시간 제한은 요청 안에서 끝나는 백업 만들기·복원 확인·복원(자료 크기에 따름)을 깨뜨리고, 경로별 표는 100개 가까운 경로에 새 관리 대상을 만든다. `lint-report`의 busy도 같은 판단 | `createApiClient`에 `AbortSignal.timeout`을 두고 오래 걸리는 경로를 `routes` 표의 표시로 뺀다 |
| LRB-D3 | #349 F4는 고치지 않고 닫는다 | 기본 크기에서 목록이 잘리지 않는다(배경 표). 잘려도 틀리는 쪽은 과다 보고(더 나쁘게 적음)라 HVT-D2가 이미 받아들였다. 바르게 하려면 작업 API에 종류별 수를 더하는 계약 변경이 필요하다 | HVT-D2의 "바꾸려면" 칸 |
| LRB-D4 | #349 F5는 고치지 않고 닫는다. 다른 프로젝트의 `testIgnore`를 합쳐 읽는 것도 하지 않는다 | 지금 목록은 하나이고 작은따옴표는 lint가 막는다. `testIgnore`는 프로젝트마다 따로라, 합쳐 읽으면 다른 프로젝트가 실제로 도는 파일을 "돌지 않음"으로 잘못 적는다. 바르게 하려면 HVT-D5의 대안(설정 모듈과 `testMatch`까지 판정)이 필요하다 | HVT-D5의 "바꾸려면" 칸 |
| LRB-D5 | #353 ②는 시험을 더하지 않고 닫는다 | 측정 표 첫 줄 — 지금 상호 대입 단언이 이미 잡는다 | 해당 사례를 IGT-C1에 주석으로 적는다 |

## 미검증 범위

- 측정은 같은 모양을 따로 만든 언어 수준 재현이다. LRB-C1의 변이 확인이 실제 타입에서 같은 결과를 보여야 한다.
- D2·D3의 오래 걸리는 시간과 잘림은 실행하지 않고 코드 읽기로 판단했다.

## 작업

PR 하나, 구현자 한 명. 시험 파일 하나만 바뀌므로 그 파일의 시험과 `pnpm typecheck`·`pnpm lint`, PR 직전 전체 시험 한 번(e2e 파일·화면 코드 변경 없음). 머지되면 #353을 닫고, #360·#349는 남은 줄(`.sub-title`, F3)을 적은 댓글과 함께 닫거나 남긴다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀. UIF2-D2 문구 정정을 함께 반영 | 전체, UIF2 spec | #360·#349·#353의 남은 낮은 지적을 코드·타입 검사 측정과 대조해 시험 하나·문구 하나·닫는 결정 넷으로 정리 |
