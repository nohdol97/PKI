# 스펙: Phase 5 후속 묶음 — Insight·알림·피드백의 남은 결함과 넘긴 기능

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D8 포함)
- 관련: 이슈 #221·#232·#238·#257(P01 후속), #251(P02 후속), #252(P03 후속). [P01 spec](2026-11-23-P01-insight-discovery.md), [P02 spec](2026-11-23-P02-notifications-digest-timeline.md), [P03 spec](2026-11-23-P03-feedback-learning.md)
- 번호: 요구사항 `P5F-R<n>`, 완료 기준 `P5F-C<n>`, 결정 `P5F-D<n>`, 작업 `P5F-T<n>`

## 배경

Phase 5의 세 작업(P01 Insight, P02 알림, P03 피드백)은 검토에서 "필수 아님"으로 분류된 지적과 뒤 작업으로 넘긴 기능을 여섯 이슈에 남겼다. 남은 항목을 지금 코드와 대조해 보니, **정확성·보안 결함이 3건**이고 **지금 구현할 수 있는 넘긴 기능이 3건**이다. 나머지는 시험 보강·문구·설계 판단이거나 배포처·실제 환경이 필요해 이슈에 그대로 둔다.

| 이 spec | 이슈 항목 | 종류 | 지금 코드에서의 모습 |
|---|---|---|---|
| R1 | #221 F1 | 결함 | "충돌" Insight가 이미 다른 값으로 대체된 사실의 어긋남도 "확인이 필요"하다고 보인다(`knowledge-engine/src/insight-code-rules.ts:181`) |
| R2 | #257 N-3 | 결함(보안 성격) | 끝 항목이 숨겨진 Insight도 그래프 추적(`graphTrace`)으로는 "있다"는 답이 나온다(`backend/src/read-gate.ts:374`) |
| R3 | #251 FU-B | 결함 | 다른 Insight의 늦은 404가 지금 열어 둔 근거를 닫는다(`apps/web/src/evidence-view.tsx:263`) |
| R4 | #252 첫 항목(P03-D11) | 넘긴 기능 | 선호 신호가 순위 계산에 넘겨지지 않아 "유용함·중요함"을 눌러도 홈의 순서가 그대로다(`backend/src/insight-view.ts:28`) |
| R5 | #252 셋째 항목(P03-D7) | 넘긴 기능 | `feedback.learned`를 바꿀 API·화면이 없고, 유형 단계가 한 Insight의 옛 줄까지 센다(`storage/src/feedback.ts:296`) |
| R6 | #252 둘째 항목(P03-D10) | 넘긴 기능 | 근거 줄에 사실·관계 ID가 없어 화면에서 "잘못된 정보·잘못된 관계·확인 완료"를 누를 수 없다(`packages/contracts/src/index.ts:699`) |

## 목표

1. 위 결함 3건이 사라진다.
2. 사용자가 준 선호가 홈의 Insight 순서에 반영되고, 근거 줄에서 지식을 바로 교정할 수 있으며, 유형 단계 개인화를 설정 화면에서 켜고 끌 수 있다(기본은 계속 꺼짐).

## 비목표

- **`feedback.learned`를 켜는 것.** 스위치만 만든다. 켜는 것은 실제 사용 기록으로 잰 뒤의 배포 단계다(site-setup S36).
- **가중 값·순위 식의 변경.** P03-D6의 상수는 그대로다.
- **충돌 화면(`conflicts()`)과 Wiki·탐색·지식 검토 화면.** 다른 세션이 쥐고 있다. 항목에 선호를 기록하는 화면(#252 덧붙임)도 그래서 뺀다.
- **해석의 재시도 기준 바꾸기(#232 D1-U7).** Provider 호출 수가 달라지는 일이라 실제 Provider로 잰 뒤에 정한다.
- **시험 보강·문구·성능만 다루는 항목**(여섯 이슈의 나머지). 이슈에 남긴다.
- **새 테이블·마이그레이션.** 없다.

## 요구사항

- **P5F-R1 충돌 Insight는 유효한 값끼리의 어긋남만 든다.** `conflict` 규칙은 `CONTRADICTS` 연결의 두 끝 가운데 하나라도 **서 있는 `SUPERSEDES` 연결로 대체된 사실**이면 그 연결을 세지 않는다(`validDates`가 쓰는 `supersededAmong`과 같은 판정). 남는 연결이 없으면 Insight는 철회된다.
- **P5F-R2 그래프 추적도 끝 항목을 묻는다.** `graphTrace`의 시작이 Insight이고 그 끝 항목(X·Y) 가운데 하나라도 보이지 않으면, 없는 Insight와 같은 `not-found`다(P01-R15, `ReadGate.insightEndsShown`).
- **P5F-R3 늦은 404는 자기 Insight만 닫는다.** Insight 조회가 404로 끝나면 그 Insight를 목록에서 빼고, **열려 있는 근거가 그 Insight의 것일 때만** 근거와 원본을 닫는다.
- **P5F-R4 선호가 순위에 들어간다.** Insight를 API가 보일 때(목록, 근거 조회, 알림 줄) 그 Insight의 선호 신호 `weight`를 `rankInsight`의 `preference`로 넘긴다. 응답의 순위에 쓴 `preference`를 싣는다. 관련성 축은 정수로 반올림한다(유형 단계의 홀수 가중이 반 점을 만들어 응답 검증에 걸리지 않게).
- **P5F-R5 유형 단계 스위치.** `GET /api/feedback/settings` → `{ learned }`, `POST /api/feedback/settings` `{ learned }` → `{ learned }`가 설정 `feedback.learned`를 읽고 쓴다. 설정 화면에 체크박스 하나를 둔다. 유형 단계는 Insight마다 **가장 새 호오 줄 하나**만 센다(P03-D9와 같은 기준).
- **P5F-R6 근거 줄에서 교정.** Insight 근거 줄이 가리키는 사실·관계의 ID(`targetId`)를 응답에 싣고, 홈의 근거 목록은 줄마다 그 대상에 허용된 교정 버튼(사실: 잘못된 정보·확인 완료, 관계: 잘못된 관계·확인 완료)을 낸다. 누르면 기존 `POST /api/feedback`을 그대로 부르고, 결과는 "최근 피드백"에서 취소할 수 있다. 대상이 보이는지의 판정은 기존 피드백 경로의 것을 그대로 쓴다(P03-R10).

## 인터페이스 / 설계 개요

- **R1**: `conflictRule.evaluate` 안에서 묶음의 사실 ID로 `supersededAmong`을 한 번 부르고, 대체된 끝을 가진 연결을 건너뛴다. Insight가 남을 때는 그 판정에 쓴 `SUPERSEDES` 연결 ID도 `linkIds`에 넣는다(`validDates`와 같은 방식: 범위 판정이 그 연결의 계보도 보게).
- **R2**: `read-gate.ts`의 `graphTrace` 한 줄. `graph-read.ts`는 고치지 않는다.
- **R4**: `FeedbackApi`에 `preferences(insights)`(Insight ID → `weight`)를 더하고, `insightView`·`rankedInsightViews`가 선택 인자로 받는다. `server.ts`는 `insights`·`insightEvidence` 처리기의 호출 두 줄만 바뀐다(D7).
- **R5**: 경로 둘은 `feedback-api.ts`의 `settings()`·`writeSettings()`가 맡고 `server.ts`에는 처리기 두 줄만 더한다. 화면은 새 파일 `apps/web/src/feedback-settings.tsx`.
- **R6**: `EvidenceSummary`에 `targetId`(더하기), `storage/src/evidence-view.ts`가 채운다. `EvidencePanel`은 선택 prop 하나(줄마다 그릴 것)를 받고, 홈만 그것을 넘긴다.

그림은 넣지 않는다(서로 독립인 작은 변경이라 순서 있는 교환·상태 전이·네 개 이상 부품의 구조가 없다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| P5F-C1 | 한 자리에 세 값이 있어 A↔B는 `CONTRADICTS`, C가 B를 대체할 때 `conflict` Insight의 사실 줄에 A↔B가 없고, 남는 어긋남이 없으면 Insight가 없다. 대체가 없을 때는 지금처럼 나온다(R1) | `knowledge-engine/src/insight-code-rules.test.ts` |
| P5F-C2 | 끝 항목에 숨은 원본의 사실이 있는 Insight로 `graphTrace`를 부르면 `undefined`(`not-found`)이고, 같은 자리의 보이는 Insight는 추적이 나온다(R2) | `backend/src/read-gate.test.ts` |
| P5F-C3 | Insight 1의 근거가 열린 상태에서 Insight 2의 404가 오면 Insight 2만 목록에서 빠지고 열린 근거는 그대로다. Insight 1의 404면 근거도 닫힌다(R3) | `apps/web/src/evidence-view.test.tsx` |
| P5F-C4 | 점수가 같은 두 Insight 가운데 하나에 `important`를 기록하면 `GET /api/insights`에서 그것이 앞에 오고 `ranking.preference`가 100이며, 취소하면 원래 순서다. 홀수 `preference`를 준 `rankInsight`의 관련성은 정수다(R4) | `backend/src/feedback-api.test.ts`, `knowledge-engine/src/insight-ranking.test.ts` |
| P5F-C5 | 설정 경로로 `learned`를 켜면 읽기가 `true`를 답하고 저장 값이 `on`이며, 끄면 `off`다. 한 Insight에 `useful` 뒤 `irrelevant`가 유효하게 남아 있을 때 같은 유형의 다른 Insight의 유형 가중은 부정 한 건으로 계산된다(R5) | `backend/src/feedback-api.test.ts`, `storage/src/feedback.test.ts` |
| P5F-C6 | 근거 조회 응답의 줄마다 `targetId`가 그 사실·관계의 ID다. 홈에서 근거 줄의 "잘못된 정보"를 누르면 "최근 피드백"에 그 줄이 생기고, 취소하면 사라진다(R6) | `backend/src/evidence-api.test.ts`, `apps/web/e2e/feedback.e2e.ts` |

설정 체크박스와 줄 버튼의 렌더링은 각 컴포넌트 시험 한 건씩(`apps/web/src/feedback-settings.test.tsx`, `apps/web/src/feedback.test.tsx`)으로 본다. 새 경로 둘은 `backend/src/api.contract.test.ts`의 경로 표에 올린다. 경계값·조합의 전수 시험은 하지 않는다. 변이 검사는 **R2의 끝 항목 검사 한 줄**에만 한다(지우면 C2가 빨개져야 한다). 나머지는 허용·차단을 정하는 검사가 아니다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **P5F-D1 충돌 Insight는 "유효한 값" 기준을 따른다(#221 F1).** 일정 판정(`validDates`)·`otherValidValues`와 같고, 모든 연결을 나열하는 충돌 화면과는 다르다. Insight는 "지금 확인이 필요한 것"이고 충돌 화면은 기록이기 때문이다. 화면과 맞추려면 R1의 건너뛰기를 지운다.
- **P5F-D2 R2의 검사는 `read-gate.ts`에 둔다.** 끝 항목 판정(`insightEndsShown`)이 거기 있고 `graph-read.ts`는 탐색 쪽 세션과 겹칠 수 있다. 엔진으로 내리려면 `traceChains`의 시작 검사에 같은 조건을 넣는다.
- **P5F-D3 선호는 Insight가 보이는 세 자리 모두에 넣고, 관련성은 `Math.round`로 맞춘다.** 직접·항목 단계의 가중(±50·±100)은 반으로 나눠도 정수라 지금 값이 바뀌지 않는다. 화면의 순위 문장은 고치지 않는다(`preference`는 응답에만 싣는다).
- **P5F-D4 `feedback.learned`는 새 경로 한 쌍으로 연다.** 기존 `semanticSettings`를 넓히면 다른 세션이 고치는 처리기의 줄을 바꿔야 하고, 화면이 `autoVerify`를 되보내는 문제(#257 F2)를 물려받는다. 알림 설정의 선례와 같다. 한 경로로 합치려면 스키마에 필드를 더하고 이 경로 둘을 지운다.
- **P5F-D5 유형 단계는 Insight마다 가장 새 호오 줄 하나를 센다.** P03-R7의 "줄을 세어"를 P03-D9("가장 새 줄이 이긴다")에 맞춘 것이다. 줄 전부를 세려면 `ofType`의 고르기를 지운다.
- **P5F-D6 교정 버튼은 홈의 원본 근거 줄에만 낸다.** 알림 화면의 근거와 "사용자 입력" 줄에는 내지 않는다. `targetId`는 늘 싣고, 대상이 숨겨졌으면 기존 판정이 `not-found`로 답한다. 다른 자리에도 내려면 `EvidencePanel`에 같은 prop을 넘긴다.
- **P5F-D7 `server.ts`의 기존 줄 둘을 고친다.** `insights`·`insightEvidence` 처리기의 `insightView` 호출이다. 그 밖의 공유 파일(`contracts/index.ts`·`evidence-view.tsx`·`App.tsx`)에는 줄을 더하기만 한다(R3의 줄 하나는 예외). 합칠 때 그 줄이 움직였으면 다시 끼운다.
- **P5F-D8 마이그레이션은 없다.** 쓰는 지금 main의 스키마는 v33이다. 합칠 때 다른 작업이 번호를 올렸어도 이 묶음은 영향이 없다.

## 미검증 범위

- 개인화가 실제로 쓸모 있는 순서를 만드는지, `feedback.learned`를 켰을 때의 효과(실제 사용 기록 필요, S36).
- 배포처 범위 정책 아래에서의 동작. R2는 시험용 정책(한 범위 거부)으로만 본다.
- 새 화면 부분의 Electron·Windows 실행. E2E는 브라우저 한 흐름이다.
- 줄 버튼으로 생긴 교정이 뒤에 다른 조치로 덮였을 때 "최근 피드백"의 취소가 `not-latest`로 계속 거절되는 것은 P03-R5의 동작 그대로 둔다(#252 여섯째 항목, R5를 다시 정할 때 함께).

## 작업 분해

PR 하나. 묶음 셋의 파일은 서로 겹치지 않는다. 자세한 그래프는 작업 폴더의 설계 보고에 있다.

| 작업 | 산출물 | 기준 | 선행 |
|---|---|---|---|
| P5F-T1 | 충돌 규칙의 대체된 끝 건너뛰기 | C1 | 없음 |
| P5F-T2 | `graphTrace`의 끝 항목 검사 | C2 | 없음 |
| P5F-T3 | 유형 단계의 줄 세기, 관련성 반올림 | C4(반올림), C5(가중) | 없음 |
| P5F-T4 | 선호를 순위에 넘기기(계약·API) | C4 | 없음 |
| P5F-T5 | 설정 경로 둘 | C5(경로) | 없음 |
| P5F-T6 | 근거 줄의 `targetId` | C6(응답) | 없음 |
| P5F-T7 | 화면: 404 처리, 줄 버튼, 설정 체크박스, E2E | C3, C6(화면) | T5, T6 |
| P5F-T8 | 문서: P01·P03 spec의 가리키는 줄과 이력 | (문서) | T1~T7 |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | 이슈 #221·#232·#238·#251·#252·#257의 남은 항목을 코드와 대조해 결함 3건과 넘긴 기능 3건을 한 묶음으로 정함 |
| 2026-11-24 | 상태 초안 → 확정 | 머리말 | 구현 착수 전 확정(잠정 결정 D1~D8은 그대로) |
