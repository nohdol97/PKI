# 스펙: 결정 대기 묶음 2(PD2) — 기한 지난 업무의 누락, 취소한 Wiki 만들기, 낡은 교정 줄의 취소

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D6 포함)
- 관련: 이슈 #247(둘째 줄), #220(`wiki-build` 취소 줄), #252(여섯째 줄). [K02 spec](2026-11-23-K02-reflection-consolidation.md)(K02-R3·R4), [K01 spec](2026-11-23-K01-wiki-projection.md)(K01-R5·R15), [P03 spec](2026-11-23-P03-feedback-learning.md)(P03-R5), [P4F spec](2026-11-24-P4F-followups.md)(P4F-D5가 첫째 건을, 배경 표가 둘째 건을 넘김), [P5F spec](2026-11-24-P5-followups.md)(84행이 셋째 건을 넘김)
- 번호: 요구사항 `PD2-R<n>`, 완료 기준 `PD2-C<n>`, 결정 `PD2-D<n>`, 작업 `PD2-T<n>`. **마이그레이션과 계약 변경은 없다.**
- 기준 코드: `origin/main` `7d133d0c`. 아래의 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

| 말 | 뜻 |
|---|---|
| dirty 줄 | "이 항목을 다음 재검토가 봐야 한다"는 표시 한 줄(`reflection_dirty`). 본 것만 지워지고 못 본 것은 남아 다음 실행이 잇는다(K02-R4) |
| 기한 창 | 재검토가 "지난 실행 날부터 오늘 전까지 목표일이 지난 업무"를 고르는 날짜 구간 |
| 낡은 교정 줄 | 교정 피드백 줄이 만든 상태 줄 뒤에 다른 사용자 조치가 쌓여, 그 줄의 취소가 더는 상태를 되돌릴 수 없게 된 줄 |

## 배경

앞선 묶음들이 "제품 결정" 또는 "스키마가 필요"라며 넘긴 줄 여섯을 코드와 다시 대조했다. 셋이 남아 있고 셋은 이미 고쳐져 있다.

| 건 | 분류 | 지금 코드에서 확인한 것 |
|---|---|---|
| #247 둘째 줄: 기한 창이 상한에서 멈춰도 앞으로 감 | 고침(R1) | `knowledge-engine/src/reflect-job.ts:121`~`:124`가 상한에 닿으면 창의 나머지를 버리고(`break`), 같은 실행이 `:170`에서 마지막 실행 시각을 지금으로 옮긴다(`storage/src/reflection.ts:213`). 다음 실행의 창은 오늘부터라 버려진 항목은 다시 나오지 않는다. 그 항목은 발견도 dirty 줄도 없어 weekly의 주의 집합(`reflect-job.ts:128`~`:134`: 열린 발견·`disputed`·`CONTRADICTS`)에도 들지 않는다. 지연이 아니라 누락이다 |
| #220: `wiki-build` 취소가 곧 다시 등록됨 | 고침(R2) | 다시 묻지 않는 것은 마지막 작업이 `dead_letter`일 때뿐이다(`storage/src/wiki.ts:396`~`:404`). 사용자가 취소하면(`storage/src/job-actions.ts:42`·`:45`) 작업이 닫히는 자리(`backend/src/composition.ts:553`), 쓰기 뒤(`backend/src/server.ts:1364`), Wiki 읽기(`server.ts:618`), 시작(`backend/src/boot.ts:455`)이 곧 새 작업을 넣는다. 죽은 작업을 버려도(`job-actions.ts:69`, `dead_letter → cancelled`) 같은 입력으로 곧 다시 들어가 실패가 되풀이된다 |
| #252 여섯째 줄: 낡은 교정 줄의 취소가 계속 `not-latest` | 고침(R3) | `storage/src/feedback.ts:219`~`:221`이 거절만 하고 줄을 그대로 둔다. 취소는 이력에 줄을 **더하는** 것이라(`storage/src/semantic-lifecycle.ts:268`~`:273`) 그 줄의 번호가 다시 가장 새 줄이 되는 일은 없다. 다시 기록해 `decide`가 받아들일 때만 치워지고(`feedback.ts:189`), 거부되면(`:178`~`:182`) 남는다. "최근 피드백" 목록은 유효한 줄을 모두 내므로(`feedback.ts:237`) 취소할 수 없는 줄이 계속 보인다 |
| #247 첫째 줄: 원본 삭제가 아닌 길로 지워진 대상의 발견이 남음 | 이미 반영(#282) | `storage/src/reflection.ts:168`, 부르는 자리 `storage/src/semantic-user.ts:261`·`:271`, `reflect-job.ts:152` |
| #220: `afterWrite`가 던지면 성공한 쓰기가 500 | 이미 반영(#236) | `backend/src/server.ts:1329`~`:1335`의 `try`/`catch`(K01-D21) |
| #220: 다시 쓰인 항목 번호에 옛 메모·변경 기록이 붙음 | 이미 반영(#236) | `storage/src/wiki.ts:226`·`:250`, 부르는 자리 `semantic-user.ts:259`, `knowledge-engine/src/canonical-kinds.ts:504` |

P4F-D5는 첫째 건을 "커서 칸(마이그레이션)이 필요하다"고 적었다. 이 spec은 이미 있는 dirty 줄로 같은 일을 한다(D1).

## 목표

- 상한 때문에 보지 못한 기한 지난 업무가 다음 실행으로 넘어간다.
- 사용자가 취소하거나 버린 Wiki 만들기는 입력이 다시 바뀌거나 사용자가 "다시 만들기"를 누를 때까지 다시 들어가지 않는다.
- 되돌릴 수 없게 된 교정 줄은 취소를 한 번 누르면 목록에서 사라진다. 대상의 상태는 바뀌지 않는다.

## 하지 않는 것

- 마이그레이션, 계약(`packages/contracts`), `backend/src/server.ts`, `apps/web`의 변경. 응답의 모양과 거절 이유 이름이 그대로다.
- 이미 누락된 항목을 찾아 채우는 일(D3), 이미 낡아 있는 교정 줄을 한꺼번에 치우는 일(D5).
- 취소된 만들기를 화면에서 "실패"와 다른 말로 알리는 일(D4의 한계).
- #247·#220·#252의 나머지 줄(시험 보강·문구·측정으로 이미 분류됨. 위 표의 "이미 반영" 셋도 다시 하지 않는다).

## 요구사항

- **PD2-R1 상한 때문에 보지 못한 기한 지난 업무는 dirty 줄로 남긴다.** 기한 창의 항목을 끝까지 훑는다. 그 묶음이 이미 이번 범위에 있거나 상한에 여유가 있으면 지금처럼 범위에 넣는다. 둘 다 아니면 그 항목을 "못 본 것"으로 모아, 실행의 결과 트랜잭션에서 항목마다 dirty 줄을 쓴다: 순번은 그때의 `dirty_seq`, 이미 줄이 있으면 그대로 둔다(더 오래된 순번이 먼저 보이게), 그 사이 지워진 항목에는 쓰지 않는다. `daily`와 `weekly`에 같이 적용한다(같은 고리다).
  - 못 본 것의 줄은 이번 실행이 읽은 줄이 아니므로 `clearDirty`(`reflection.ts:234`)가 지우지 않는다. 결과 수의 `dirtyLeft`에 함께 세어진다.
  - 다음 실행은 그 줄을 기존 dirty 줄과 똑같이 다룬다(K02-R4 그대로). 새 상태 칸은 없다.
- **PD2-R2 취소로 닫힌 만들기는 죽은 만들기와 같이 다시 묻지 않는다.** 가장 새 `wiki-build` 작업의 상태가 `dead_letter` **또는 `cancelled`**이고 그 대상의 순번이 지금 입력 순번 이상이면 `requestWikiBuild`는 `dead`를 답하고 작업을 넣지 않는다. 입력이 다시 바뀌거나 "다시 만들기"(`requestWikiRebuild`가 입력 순번을 올린다, `wiki.ts:443`)를 누르면 지금처럼 넣는다.
  - `isWikiBuildDead`도 같은 판정을 쓰므로 index의 `buildDead`가 참이 되고, 화면은 읽기를 되풀이하지 않는다(`apps/web/src/wiki.tsx:269`~`:275`. 고치지 않는다).
  - `superseded`와 `succeeded`는 지금처럼 다시 묻는다.
- **PD2-R3 낡은 교정 줄의 취소는 거절하되 그 줄을 거둔다.** 이력 줄 번호가 있는 피드백 줄의 취소에서 대상의 가장 새 상태 줄이 그 번호가 아니면, 지금처럼 `not-latest`를 답하고 대상의 상태를 건드리지 않는다. 다만 **같은 호출에서 그 피드백 줄에 취소 시각을 적는다.** 그 뒤 그 줄은 목록에 나오지 않고, 다시 취소하면 `nothing-to-undo`다.
  - `backend/src/feedback-api.ts:141`~`:150`은 거절을 던지지 않고 돌려주므로 트랜잭션이 커밋된다. 고칠 줄이 없다.
  - 낡은 줄에 다시 기록했는데 `decide`가 거부하는 길(`feedback.ts:178`)은 그대로 둔다. 남은 줄은 취소 한 번으로 거둬진다.

### 바꾸는 자리

| 파일 | 바꾸는 것 |
|---|---|
| `storage/src/reflection.ts`, `storage/src/index.ts` | 항목 번호들에 dirty 줄을 쓰는 함수 하나(R1의 세 조건)와 내보내기 한 줄 |
| `knowledge-engine/src/reflect-job.ts` | `:121`~`:124`의 고리를 "건너뛰고 모으기"로 바꾸고, `write`에서 `clearDirty` 옆에 위 함수를 부른다. 머리 주석 한 줄 |
| `storage/src/wiki.ts` | `isDeadAt`(`:396`)의 상태 조건에 `cancelled`를 더하고 주석 세 곳(`:391`, `:406`, `:413`)을 맞춘다 |
| `storage/src/feedback.ts` | `undoFeedback`의 `:219`~`:221`에서 거절 전에 취소 시각을 적는다. 머리 주석(`:198`~`:202`)을 맞춘다 |
| `knowledge-engine/src/wiki-build-job.test.ts` | `:73`이 열린 작업을 치우려고 상태를 `cancelled`로 적는다. R2 뒤에는 다시 묻지 않게 되므로 `superseded`로 바꾼다(시험의 뜻은 그대로) |

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| PD2-C1 | 목표일이 같은 날인 `Task` 셋(근거 있음, 완료일 없음)이 있고 그 목표일 전날의 `daily` 실행이 dirty 줄을 모두 지웠을 때, 목표일 이틀 뒤에 상한 1로 `daily`를 돌리면 결과 수가 `bundles: 1`, `dirtyLeft: 2`다. 같은 시각으로 두 번 더 돌리면 `dirtyLeft`가 1, 0이 되고 세 항목 모두에 열린 `overdue-work` 발견이 있다(R1) | `knowledge-engine/src/reflect-job.test.ts`(K02-C2b 묶음 옆) |
| PD2-C2 | Wiki가 낡아 등록된 `wiki-build`를 `cancelJob`으로 취소하면 `requestWikiBuild`가 `dead`를 답하고 `wiki-build` 작업 수가 그대로이며 `isWikiBuildDead`가 참이다. 항목을 하나 더해 입력이 바뀌면 `registered`다(R2) | `storage/src/wiki.test.ts`(`wiki.request` 묶음) |
| PD2-C3 | `wrong_info`로 `disputed`가 된 사실을 다른 경로로 승인한 뒤 그 피드백 줄을 취소하면 답이 `not-latest`이고 상태는 `verified` 그대로이며, 그 줄의 취소 시각이 적혀 있고 `listFeedback`에 나오지 않는다. 다시 취소하면 `nothing-to-undo`다(R3) | `storage/src/feedback.test.ts`(P03-C1b의 `not-latest` 건을 고쳐 쓴다) |

경계값·조합의 전수 시험은 하지 않는다(`daily` 하나, 사용자 취소 하나, 사실 하나로 대표한다). 변이 확인은 요구하지 않는다(보안·자료 보호의 허용·차단 가드가 아니다). 기존 시험은 위 표의 `wiki-build-job.test.ts:73` 한 줄과 `feedback.test.ts:169`~`:176`의 기대값 말고는 고치지 않고 통과해야 한다.

## 앞선 spec에 고치는 문장

같은 PR이 함께 고친다(문서만).

| 자리 | 고친 것 |
|---|---|
| K02-R4 | "상한 때문에 못 본 기한 지난 업무에도 dirty 줄을 써서 다음 실행이 잇는다"는 문장과 이 spec 가리킴 |
| K01-R5, K01-R15의 `buildDead` 문장 | "죽은 작업 뒤"를 "죽었거나 취소된 작업 뒤"로 |
| P03-R5, P03-C1b | "거절하고 아무것도 바꾸지 않는다"를 "대상의 상태는 바꾸지 않고 그 피드백 줄만 거둔다"로 |
| P4F-D5 | 이 spec이 커서 칸 없이 고쳤다는 가리킴 한 문장 |
| 위 네 spec의 변경 이력 | 한 줄씩 |

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| PD2-D1 | 커서 칸을 더하지 않고 못 본 항목을 dirty 줄로 남긴다 | "상한 때문에 못 본 것은 dirty로 남아 다음 실행이 잇는다"는 약속(K02-R4·D4)이 이미 있고 표도 있다. 커서는 날짜 하나라 같은 날의 항목을 가르지 못하고 마이그레이션이 든다 | `reflection_state`에 창의 끝 날짜 칸을 더하고 R1의 함수 호출을 지운다 |
| PD2-D2 | 못 본 항목의 줄은 이미 있는 줄을 덮지 않는다 | 순번이 오래된 줄이 먼저 보인다(`reflection.ts:227`). 덮으면 오래 기다린 항목이 뒤로 밀린다 | 함수의 `ON CONFLICT`를 `DO UPDATE`로 |
| PD2-D3 | 이 수정 전에 이미 누락된 항목은 찾지 않는다 | 누락은 하루에 묶음 200개를 넘긴 날에만 생긴다. 그 항목은 다음에 바뀔 때 dirty가 되어 `overdue-work`가 열린다 | 시작할 때 한 번, 완료일 없는 지난 업무 전부에 dirty 줄을 쓴다 |
| PD2-D4 | 사용자의 취소를 존중한다: 취소된 만들기는 죽은 만들기와 같은 규칙 | 취소가 몇 초 뒤 뒤집히면 취소 단추가 뜻이 없고, 버린 죽은 작업은 같은 실패를 되풀이한다. 입력이 바뀌면 다시 만들므로 Wiki가 영영 멈추지는 않는다. **한계**: 화면 문구(`apps/web/src/wiki-text.ts:68`)는 "실패해 멈췄습니다"라고 말한다. 안내하는 길(지식이 바뀌거나 '다시 만들기')은 맞다 | `isDeadAt`의 상태 하나를 뺀다. 문구를 가르려면 계약에 칸을 더한다 |
| PD2-D5 | 낡은 줄의 취소는 `not-latest`를 유지하고 줄만 거둔다 | 상태를 되돌리지 않았다는 답이 사실이고 화면 문구("그 뒤에 다른 조치가 있어 되돌리지 않았습니다")와 맞는다. `applied`로 답하면 되돌린 것처럼 읽히고 `not-latest`가 닿지 않는 값이 된다. 이미 낡아 있는 줄은 사용자가 누를 때 거둬진다 | `undoFeedback`의 한 줄을 지우면 전으로, 답을 `applied`로 바꾸려면 그 가지의 반환을 고치고 P03-R5를 다시 쓴다 |
| PD2-D6 | 다시 기록이 거부될 때는 낡은 줄을 건드리지 않는다 | 거부는 "아무것도 하지 않았다"로 남기는 편이 단순하다(`feedback.ts:150`~`:151`의 약속). R3이 그 줄을 치울 길을 준다 | `feedback.ts:189`의 한 줄을 거부 반환 앞으로 옮긴다 |

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다. 완료 기준의 시험은 구현 작업이 쓴다.
- **R1의 비용.** 기한 창을 끝까지 훑으면 오래 쉰 뒤의 첫 실행에서 창의 항목 수만큼 묶음 대표를 묻는다. 재지 않았다.
- **R1의 `weekly`와 `Commitment`.** 같은 고리라 `daily`·`Task` 하나로 대표한다.
- **R2와 작업 보존 기간·복원.** 취소된 작업 줄이 보존 정리로 지워지면 만들기가 다시 들어간다. 복원된 DB의 마지막 작업이 취소 상태면 입력이 바뀔 때까지 만들지 않는다. 둘 다 시험하지 않는다.
- **R2의 실행 중 취소**(취소 요청 뒤 실행기가 닫는 길)와 **죽은 작업 버리기**는 같은 상태로 닫히므로 대기 중 취소 하나로 대표한다.
- **R3의 화면.** 거절 뒤 목록을 다시 읽는 것은 `apps/web/src/feedback.tsx:160`~`:164`를 읽어 확인했고 e2e는 더하지 않는다.
- Windows·Electron 설치본.

## 작업 분해

PR 하나, 한 worktree, 구현자 한 명이 차례로 한다. 전체 시험은 PR 직전에 한 번만 돈다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 명령 |
|---|---|---|---|---|---|
| PD2-T1 | 못 본 기한 지난 업무의 dirty 줄과 시험 | C1 | 없음 | `storage/src/reflection.ts`, `storage/src/index.ts`, `knowledge-engine/src/reflect-job.ts`, `knowledge-engine/src/reflect-job.test.ts` | `pnpm exec vitest run knowledge-engine/src/reflect-job.test.ts storage/src/reflection.test.ts` |
| PD2-T2 | 취소된 만들기를 다시 묻지 않는 판정과 시험 | C2 | 없음 | `storage/src/wiki.ts`, `storage/src/wiki.test.ts`, `knowledge-engine/src/wiki-build-job.test.ts` | `pnpm exec vitest run storage/src/wiki.test.ts knowledge-engine/src/wiki-build-job.test.ts` |
| PD2-T3 | 낡은 교정 줄을 거두는 취소와 시험 | C3 | 없음 | `storage/src/feedback.ts`, `storage/src/feedback.test.ts` | `pnpm exec vitest run storage/src/feedback.test.ts backend/src/feedback-api.test.ts` |
| PD2-T4 | 앞선 spec 네 건의 문장과 `docs/README.md` 색인 한 줄 | — | T1~T3 | `docs/specs/`의 K02·K01·P03·P4F, `docs/README.md` | `pnpm exec vitest run tooling/docs` |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #247·#220·#252의 세 줄이 "제품 결정" 또는 "스키마 필요"로 미뤄져 있었음. 사용자가 잠정 결정을 위임 |
