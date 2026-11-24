# 스펙: RPF·HVT·NGT 후속 묶음(FUB) — 미완 표시 `null`, 신호 뒷정리, 시험 보강

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 포함)
- 관련: 이슈 #345(F1~F3), #349(F1~F3·F6), #251(NGT F2, 마지막 댓글). [RPF spec](2026-11-24-RPF-restore-pd3-followups.md), [RLD spec](2026-11-24-RLD-restore-lock-decisions.md), [HVT spec](2026-11-24-HVT-h03-verification-tools.md), [NGT spec](2026-11-24-NGT-notify-gate-tests.md)
- 번호: 요구사항 `FUB-R<n>`, 완료 기준 `FUB-C<n>`, 결정 `FUB-D<n>`. 마이그레이션·계약 변경 없음.
- 기준 코드: `origin/main` `cf5c596d`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

| 줄 | 분류 | 처리 |
|---|---|---|
| #345 F1 | 문서(**반영함**) | PD3-D5 제외 글자 목록에 `〼`(U+303C)를 더함. `node`로 다시 세어 53자 확인 |
| #345 F2 | 문서(**반영함**) | `docs/site-setup.md`의 `restore-marker-unreadable` 행을 "이전 사본이 있으면 절차 A / 없으면 …, 이 경우 복원본이면 마무리"의 순서로 고쳐 씀(`adoptUnfinishedRestore`가 이전 사본이 있으면 `restore-state-inconsistent`로 멈추는 것과 맞음, `backend/src/restore-boot.ts:221-222`) |
| #345 F3 | 동작 | `restore.pending`이 JSON `null`이면 `parsed.backupId`(`restore-boot.ts:230`)에서 `TypeError` → 매 시작 실패. 숫자·글·배열은 예외 없이 빈 자리로 간다. R1 |
| #349 F1 | 주석 | `backend/src/system-measure.test-support.ts:91·93·95·97`의 결과 필드 주석이 HVT-R1(`tallyKnowledge`, `:625-630`)과 어긋남. R5 |
| #349 F2 | 시험 | "`testIgnore` 목록 없음" 줄(`tooling/scenarios/final-scenarios.ts:222`)을 지워도 초록. R3 |
| #349 F3 | 시험 | 뒷정리 블록(`system-measure.test-support.ts:958-963`·`:1258-1263`). D3(다루지 않음) |
| #349 F6 | 동작 | 신호 처리기(`system-measure.test-support.ts:668-671`)에서 뒷정리 하나가 던지면 나머지 뒷정리와 `process.exit`를 건너뜀. R2 |
| #251 F2 | 시험 | NGT-C4가 `read` 전에 `readAt`이 `null`인지 보지 않음(`backend/src/notify-flow.test.ts:291-292`). R4 |

## 목표

- 시작을 매번 막는 `null` 미완 표시를 읽을 수 없는 표시와 같은 길로 보낸다.
- 신호로 끝날 때 뒷정리 하나의 예외가 나머지와 종료 코드를 막지 않게 한다.
- 지워도 초록이던 두 줄을 시험으로 묶고, 주석을 코드와 맞춘다.

## 비목표

- #349 F4·F5, #340 F5. `expectedEvidence`의 값(H03C2F-R1대로 문서 수 그대로).
- 다른 세션이 쥔 파일: `backend/src/local-files*`, `local-locations*`, `local-lifecycle*`, 첨부 계약.

## 요구사항

- **FUB-R1** 마무리되지 않은 복원본의 `restore.pending` 값이 JSON으로 읽혀도 객체가 아니면(`null` 포함) 읽을 수 없는 값과 같다: 요약의 빈 자리는 빈 문자열·`0`·`null`이고, 이전 사본이 없으면 그 시작이 마무리한다(RLD-R3 마지막 문장의 확장). D1
- **FUB-R2** 측정 실행기의 신호 처리기는 등록된 뒷정리를 모두 부르고, 그중 하나가 던져도 나머지를 부른 뒤 `SIGINT` 130·`SIGTERM` 143으로 끝난다. 던진 예외는 stderr에 한 줄 남긴다. D2
- **FUB-R3** 시나리오 검사기는 `playwright.config.ts`에 `testIgnore` 목록이 없으면 `map:`으로 시작하는 그 줄을 낸다(지금 동작을 시험으로 묶음).
- **FUB-R4** NGT-C4는 `read` 전에 그 요약 줄의 `readAt`이 `null`임을 단언한다.
- **FUB-R5** `KillRecoverValue`의 `lostDocs`·`failedJobs`·`duplicateItems`·`knowledge` 주석은 HVT-R1을 따른다: `dead_letter`·`cancelled`는 유실에 더하고 기대 근거 줄에서 빼며, `superseded`만 설명이다. `expectedEvidence`는 실패를 빼지 않은 문서 수다.

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| FUB-C1 | 마무리되지 않은 복원본의 `restore.pending`을 `null`로 바꾸고 확인되지 않은 되돌림 뒤 이전 사본을 지우고 시작하면: 시작이 성공하고 동의 0건, 위치 `paused`, `restore.pending`이 없다. `{not json`도 그대로 통과(R1) | `backend/src/restore-boot.adopt.test.ts` C2b를 두 값으로 돌림. **`null`은 `cf5c596d`에서 빨강** |
| FUB-C2 | 뒷정리 둘을 건 뒤 첫째가 던지는 상태로 `SIGTERM` 처리기를 부르면 둘째가 불리고 `process.exit(143)`이 불린다(R2) | `backend/src/system-measure.test.ts` 「HVT」 묶음 새 사례 "FUB-C2". **`cf5c596d`에서 빨강** |
| FUB-C3 | `testIgnore`가 없는 설정 글을 주면 `checkScenarioMap`이 `map: playwright.config.ts has no testIgnore list`를 낸다(R3) | `tooling/scenarios/final-scenarios.test.ts` 「HVT」 묶음 새 사례 "FUB-C3". 처음부터 초록, `:222`를 지우면 빨강을 한 번 확인 |
| FUB-C4 | daily 요약 줄은 `read` 전 `readAt`이 `null`이고 뒤에는 `null`이 아니다(R4) | `backend/src/notify-flow.test.ts` NGT-C4 사례에 단언 한 줄 |

FUB-R5는 주석이라 시험이 없다(검토로 확인). tdd-gate 때문에 FUB-C2와 같은 커밋에 싣는다.

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| FUB-D1 | 객체가 아닌 JSON 값(`null`·숫자·글·배열)은 읽을 수 없는 값처럼 빈 요약으로 마무리한다 | RLD-R3이 "읽히지 않아도 표시는 표시"로 이미 정했고, 시작을 막으면 사용자가 DB를 고치기 전엔 앱이 뜨지 않는다. 마무리는 동의를 지우고 폴더를 멈출 뿐 자료를 지우지 않는다 | `adoptUnfinishedRestore`가 객체가 아닌 값에 `RestoreStateError`를 던지게 하고 `docs/site-setup.md`에 그 코드를 더한다 |
| FUB-D2 | 신호 처리기에서 뒷정리마다 예외를 잡아 stderr에 쓰고 계속한 뒤 종료한다 | 신호로 끝나는 프로세스가 남은 자식 프로세스(`killGroup`)를 못 죽이고 종료 코드도 잃는 쪽이 더 나쁘다. 평소 끝(`cleanOnSignal`이 돌려주는 함수)은 HVT-R4대로 예외를 그대로 던진다 | 처리기의 `try/catch`를 빼면 옛 동작 |
| FUB-D3 | #349 F3(뒷정리 블록 시험)은 **다루지 않는다** | 옛 순서와 새 순서의 차이는 `stopBackend`가 던질 때만 보이는데, 그 함수는 실제 백엔드 자식 프로세스를 멈추는 것이라 끼울 자리가 없다. 시험하려면 시험만을 위한 주입 자리를 두 실행에 더해야 한다(규칙 1·YAGNI). 뒷정리 자체(`killGroup`·`rmSync`)는 두 번 불려도 해가 없다 | 두 실행에 `stop` 주입 옵션을 더하고 던지는 `stop`으로 작업 폴더가 지워졌는지 보는 시험을 쓴다 |

## 미검증 범위

Windows. 신호 처리기를 실제 신호로 부르는 경로(FUB-C2는 등록된 처리기 함수를 직접 부른다; 실제 `SIGTERM` 종료 코드는 H03C2F-C7·HVT-C5가 본다).

## 작업

PR 하나, 구현자 한 명. 시험 파일·검증 명령은 작업 지도(`_workspace/pki-fub/phase2_architect_taskmap.md`)에 있다. 머지되면 #345는 닫는다. #349는 F1·F2·F3(결정으로 닫음)·F6을 체크하고 F4·F5가 남아 열어 둔다. #251은 NGT F2를 반영했다는 댓글을 단다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #345·#349·#251의 남은 지적을 코드와 대조해 동작 둘·시험 둘·주석 하나·문서 둘·결정 셋으로 정리 |
