# 스펙: 읽기 가시성 후속 묶음 — 합치기 줄 판정, 원본 목록의 상한, 색인 파일 열기

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D7 포함)
- 관련: 이슈 #302(RSP 후속), #268·#283(탐색 후속의 백엔드 줄), #287(Phase 5 후속의 F2·D2). [RSP spec](2026-11-24-RSP-retrieval-strategy-prereqs.md), [X02F spec](2026-11-24-X02F-explore-followups.md), [X02B spec](2026-11-24-X02B-explore-curation.md), [P5F spec](2026-11-24-P5-followups.md)
- 번호: 요구사항 `RVS-R<n>`, 완료 기준 `RVS-C<n>`, 결정 `RVS-D<n>`, 작업 `RVS-T<n>`. 마이그레이션·계약 변경·새 경로는 없다.

## 배경

네 이슈에 남은 백엔드·엔진 쪽 줄 25건을 지금 코드(`origin/main` `f9058791`)와 하나씩 대조했다. **지금 고칠 결함은 6건**이고, main에서 이미 고쳐진 것은 없으며, 나머지 19건은 시험 보강·문구·구조(9건)이거나 측정·계약 변경·다른 세션의 파일이 필요해(10건) 이슈에 그대로 둔다.

"합치기 줄"은 "항목 A는 항목 B와 같은 것"이라는 기록 한 줄이다. 이 줄도 사실·관계처럼 가시성 판정을 받는 행(`entity-merge`)이고, 그래프 읽기·Wiki·선호 계산은 이미 **보이는 줄만** 따라간다(S02-R24 4항, RSP-R5). 아래 R1·R2의 두 자리는 그 판정을 건너뛰고 있었다.

### 지금 고치는 것

| 이 spec | 이슈 항목 | 종류 | 지금 코드에서의 모습 |
|---|---|---|---|
| R1 | #302 F1 | 결함(가시성) | `conceptQueries`·`temporalIds`가 판정하지 않은 `entityGroups.membersOf`로 묶음을 넓힌다(`knowledge-engine/src/retrieval/strategies.ts:67`·`:157`). `conceptIds`도 같은 묶음의 계보를 쓴다(`strategies.ts:60` → `linking.ts:84-88`). 같은 폴더의 선호 계산은 보이는 줄만 따른다(`preference.ts:36`) |
| R2 | #283 덧붙임(`mergeId`) | 결함(가시성) | 탐색의 가운데 항목 답이 구성원을 항목 가시성만으로 고르고(`backend/src/explore-read.ts:117-119`) `mergeId`도 가리키는 항목만 본다(`:167`). 지식 목록도 같다(`backend/src/read-gate.ts:248-250`). 합치기 줄이 가려져도 "같은 것"이라는 사실과 줄 번호가 나간다 |
| R3 | #283 백엔드 3 | 결함(정확성) | `sourcesPage`가 훑기 상한에서 멈춰도 `next: null`이다(`read-gate.ts:342-353`, 상한은 `filled`의 `:201`). 그 뒤의 보이는 원본에 닿지 못한다 |
| R4 | #302 F4 | 결함(정확성) | `isOtherFile`이 `SQLITE_CORRUPT`만 알아(`storage/src/adapters/sqlite-vector-index.ts:72-79`) `SQLITE_CORRUPT_INDEX` 같은 확장 코드의 색인 파일은 다시 만들지 않고 시작이 실패한다(`:119-122`) |
| R5 | #302 F5 | 결함(정확성) | `openBetterSqlite3`가 연 뒤의 pragma가 던지면 핸들을 닫지 않는다(`storage/src/adapters/better-sqlite3-driver.ts:16-26`). 부르는 쪽은 핸들을 받지 못해 닫을 수 없다(`sqlite-vector-index.ts:100`·`:124`) |
| R6 | #302 F3 | 속도(동작 같음) | 중복 제거가 `findIndex`라 근거 줄 수의 제곱이다(`knowledge-engine/src/retrieval/evidenced.ts:24-26`) |

R1·R2가 실제로 드러나는 조건은 좁다. 합칠 수 없는 범위의 줄은 쓸 때 이미 쉬게 되므로(`active = 0`), **범위 정책이 "합쳐도 된다"(`combinable`)고 답한 범위 집합을 읽기 판정(`allows`)에서는 거절할 때만** 줄이 가려진 채 살아 있다. 공용 저장소의 기본 정책은 아무것도 거절하지 않아 일어나지 않는다. 배포처 정책에서는 일어날 수 있고, 다른 읽기가 이미 지키는 규칙이라 맞춘다.

### 이슈에 두는 것

| 분류 | 항목 | 까닭 |
|---|---|---|
| 일어나지 않음 | #268 `latestVersion`, Semantic 목록의 `evidenceCount` | 범위는 원본 단위이고 tombstone은 아래 version만 덮어(`storage/src/derivatives.ts:349-370`) 보이는 version보다 새 version이 가려질 수 없다. 사실의 계보는 그 근거 전부라(`storage/src/row-lineage.ts:43-45`) 사실이 보이면 근거도 보인다. 합집합은 허용하고 부분집합은 거절하는 정책에서만 어긋난다 |
| 측정 먼저 | #268 행마다 가시성 조회, POST 읽기의 `afterWrite`(`server.ts`), #283 `semanticPage` 1만 행 훑기, #287 D2(`gate.insights()` 두 번), #302 F2(`vectorIds`가 회차 사이에 취소를 보지 않음 — 취소된 요청의 조회가 최대 3번 더 돌 뿐), #302 미측정 줄 | 틀린 답이 아니라 비용이다. 크기를 재지 않았다 |
| 계약 변경 | #283 상한의 `next`로 가려진 수를 셀 수 있음, 실릴 것이 없으면 `next: null` | `next`를 불투명한 자리 값으로 바꿔야 한다(X02F-D1) |
| 시험 보강·문구·구조 | #302 F6·관계 경로 시험, #268 쪽 시험 80행·`explore.ts`의 enum 복제, #283 C2 부정 시험·`after` 뒤가 정확히 상한일 때의 빈 읽기 한 번·C1 조합·주석 문구, #287 F2(`graphTrace`의 SQL 되풀이) | 동작이 틀리지 않는다(PKI 테스트 간략화 규칙 6항) |

## 목표

1. 검색 전략과 탐색·지식 목록이 가려진 합치기 줄을 따라가지 않는다.
2. 원본 목록의 "더 보기"가 훑기 상한 뒤의 보이는 원본에 닿는다.
3. 벡터 색인 파일이 손상 계열 오류일 때 다시 만들어지고, 열다 실패한 DB 핸들이 남지 않는다.

## 비목표

- **전략·설정을 켜는 것.** `temporal`·개념·`vector`의 기본값은 그대로 꺼 둔다.
- **`next`의 계약 변경**, 마이그레이션, 새 경로·새 응답 칸.
- **가려진 "항목"을 사이에 둔 구성원의 처리 바꾸기.** 가장 가까운 보이는 항목으로 잇고 `mergeId`를 `null`로 싣는 지금 동작(S02 결정 27 ⑥, X02F-D4)은 그대로다.
- **위 "이슈에 두는 것" 전부**와 화면(`apps/web`, `apps/desktop`), 린트·Wiki·Reflection 모듈, `server.ts`·`contracts`.
- **Windows 실행 확인.** R5의 수정은 플랫폼과 무관하지만 Windows에서의 효과는 재지 않는다.

## 요구사항

- **RVS-R1 검색 전략은 보이는 줄로만 묶음을 넓힌다.** `conceptQueries`·`temporalIds`·`conceptIds`가 맞은 항목을 구성원으로 넓힐 때 그 읽기의 판정(`judge`, 목적 `search`)으로 본 묶음(`groupView`의 `membersOfTop(topOf(id))`)을 쓴다. 합치기 줄이나 위 항목이 가려진 구성원, 자신이 가려진 구성원의 표기·사실·원본은 후보가 되지 않는다.
- **RVS-R2 구성원은 합치기 줄이 보일 때만 실린다.** 탐색의 가운데 항목 답(`members`와 구성원의 사실·관계)과 지식 목록(`semantic`·`semanticPage`의 `members`, 상태 거르기)에서, 구성원과 그것이 실리는 항목 사이를 잇는 합치기 줄이 목적 `display`로 **전부** 보일 때만 그 구성원을 싣는다. 실린 구성원의 `mergeId`는 지금처럼 가리키는 항목이 보일 때만 번호다.
- **RVS-R3 원본 목록은 상한에서 멈추면 이어 읽을 자리를 준다.** `sourcesPage`가 훑기 상한에서 멈췄고 저장소에 줄이 더 남았으면, `next`는 그 쪽에 실린 마지막 원본의 번호다. 실린 것이 없으면 `null`이다(X02F-D1과 같은 한계). 가려진 원본의 번호는 `next`가 되지 않는다.
- **RVS-R4 손상 계열 코드는 모두 "다른 파일"이다.** 색인 파일을 열거나 살필 때의 오류 코드가 `SQLITE_CORRUPT`로 시작하면 파일을 지우고 빈 색인으로 시작한다. 잠금 등 그 밖의 오류에서 파일을 그대로 두고 던지는 동작(RSP-R6)은 바뀌지 않는다.
- **RVS-R5 열다 실패하면 핸들을 닫는다.** `openBetterSqlite3`가 연결을 만든 뒤 설정(pragma) 단계에서 오류가 나면 그 연결을 닫고 같은 오류를 던진다.
- **RVS-R6 중복 제거는 한 번 훑기로 한다.** `shownItemsEvidencedBy`의 답(쌍마다 한 줄, 지금의 순서)은 같고 비용만 줄 수에 비례한다.

## 인터페이스 / 설계 개요

- **R1**(`strategies.ts`만): `groupView(db, judge)`를 한 번 만들어 세 함수가 쓴다. `conceptIds`는 보이는 구성원 각각의 `registry.lineage`를 합친다. `linking.ts`의 `groupLineage`는 Broker 등급 매기기도 쓰므로(묶음 전체가 더 엄한 쪽) 고치지 않는다.
- **R2**(`read-gate.ts`, `explore-read.ts`): `ReadGate`에 구성원 읽기 하나(예: `semanticMembers(itemId)`)를 더해 판정을 한곳에 둔다. `listSemanticMembers`가 묶음의 줄을 모두 주므로(각 구성원의 `mergeId`·`mergedInto`) 저장소 읽기를 더하지 않고 구성원에서 위로 올라가며 줄(`{ kind: "entity-merge", id: "merge:<id>" }`)을 판정한다. `semanticItem`과 `explore-read.ts`의 `item()`이 이 하나를 부른다.
- **R3**(`read-gate.ts`): `filled`가 "저장소 끝에 닿았는지"를 함께 알려 주거나 `sourcesPage`가 `semanticPage`처럼 직접 돈다. 기존 `sources()`·`searchSources()`의 답은 바뀌지 않는다.
- **R4·R5**: 각각 `isOtherFile`의 조건 한 줄, `openBetterSqlite3`의 pragma 네 줄을 감싸는 `try`.

그림은 넣지 않는다(서로 독립인 작은 변경이라 순서 있는 교환·상태 전이·네 개 이상 부품의 구조가 없다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 | 변이 검사 |
|---|---|---|---|
| RVS-C1 | 서로 다른 범위의 원본에 선 두 항목이 합쳐져 있고 정책이 두 범위를 함께 보는 것만 거절할 때(줄은 가려지고 두 항목은 보임), 대표로 부른 `temporalIds`의 답에 구성원의 날짜 있는 사실의 원본이 없고 `conceptQueries`의 답에 구성원의 확정 표기가 없다. 거절하지 않는 정책에서는 둘 다 있다(R1) | `knowledge-engine/src/retrieval/strategies.test.ts` | **필요** — 넓히기를 `entityGroups.membersOf`로 되돌리면 빨개져야 한다 |
| RVS-C2 | 같은 배치에서 대표를 가운데로 읽은 탐색 답의 `members`가 비고 구성원의 사실이 `facts`에 없으며, 지식 목록 쪽(`semanticPage`)에서 그 대표의 `members`도 빈다. 거절하지 않는 정책에서는 구성원이 `mergeId`와 함께 실린다(R2) | `backend/src/explore-read.test.ts`, `backend/src/read-gate.test.ts` | **필요** — 줄 판정을 지우면 빨개져야 한다 |
| RVS-C3 | 상한을 낮춘 관문에서 보이는 원본 둘이 상한 안에, 하나가 상한 밖(가려진 원본들 뒤)에 있을 때 첫 답의 `next`가 둘째 원본의 번호이고, 그 `next`로 다시 읽으면 셋째가 실리고 `next`가 `null`이다(R3) | `backend/src/read-gate.test.ts` | 불필요 |
| RVS-C4 | 색인 파일을 살피는 읽기가 코드 `SQLITE_CORRUPT_INDEX`로 던지면 색인이 빈 채로 열린다. `SQLITE_BUSY`의 기존 시험(RSP-C6)은 그대로 통과한다(R4) | `storage/src/adapters/sqlite-vector-index.contract.test.ts` | 불필요(지워도 다시 만들 수 있는 파일) |
| RVS-C5 | 설정 단계가 던지도록 바꾼 연결로 `openBetterSqlite3`를 부르면 같은 오류가 나오고 그 연결의 `close`가 한 번 불린다(R5) | `storage/src/adapters/better-sqlite3-driver.open-failure.test.ts`(새 파일, 라이브러리 대역) | 불필요 |
| RVS-C6 | `shownItemsEvidencedBy`를 쓰는 기존 시험이 고치지 않은 채 통과한다(R6) | `knowledge-engine/src/retrieval/preference.test.ts`, `retrieve.test.ts` | 불필요 |

경계값·조합의 전수 시험은 하지 않는다. 여러 단계 사슬(A→B→C에서 가운데 줄이 가려짐)은 R2의 문장이 정하지만 대표 사례 시험에는 넣지 않는다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **RVS-D1 `conceptIds`도 R1에 넣는다.** 이슈는 두 함수만 적었지만 같은 줄을 판정 없이 넓히는 같은 모양이다. 빼려면 `conceptIds`만 `groupLineage`로 되돌린다.
- **RVS-D2 R1은 `groupView`를 그대로 쓴다.** 그래서 검색 전략에서는 사이의 항목이 가려진 구성원도 빠진다(그래프 읽기·선호와 같음, RSP-D5).
- **RVS-D3 R2는 줄만 더 본다.** 줄은 **양 끝 항목이 모두 보이는 줄에 한해** 판정한다(구현에서 확정: 가려진 항목에 닿는 줄은 그 항목 때문에 가려지므로 판정하면 아래 X02F-C2 기대가 깨진다). 사이의 "항목"이 가려진 구성원은 지금처럼 실린다(X02F-D4: 그 구성원의 사실이 화면에 남는다). 그래프 읽기처럼 통째로 빼려면 R2의 구성원 읽기를 `groupView`로 바꾸고 X02F-C2의 기대를 고친다.
- **RVS-D4 줄이 가려진 구성원은 통째로 뺀다.** `mergeId`만 비우면 "같은 것"이라는 사실이 그대로 나간다. 그 구성원은 자기 번호로 찾아 열면 혼자인 항목으로 보인다.
- **RVS-D5 `sourcesPage`의 `next`는 쪽에 실린 마지막 번호다.** 훑다 멈춘 자리를 주면 가려진 원본의 번호가 나간다(X02F-R1과 같은 선택). 실린 것이 없는 구간이 상한보다 길면 그 뒤에 닿지 못하는 한계는 남는다.
- **RVS-D6 R4는 접두사로 본다.** 손상 계열 확장 코드를 하나씩 적지 않는다. 좁히려면 코드 목록으로 바꾼다.
- **RVS-D7 `heldShown`의 합치기·구별·나누기 수는 고치지 않는다.** 상대 항목만 보고 줄 자체는 보지 않는 같은 모양이지만(`read-gate.ts:456-478`) 이슈에 없던 자리라 후속 이슈로 남긴다.

## 미검증 범위

- 실제 배포처 범위 정책에서 줄이 가려진 채 살아 있는 일이 생기는지. 시험은 "두 범위를 함께 보면 거절"하는 시험용 정책으로만 본다.
- 실제 드라이버가 손상된 파일에서 내는 오류 코드의 모양과, 비DB 파일에서 어느 설정 단계가 던지는지. 시험은 주입한 오류다.
- R5가 Windows에서 색인 파일 지우기 실패를 막는지(열린 핸들이 지우기를 막는다는 추정). 재지 않았다.
- `membersOf`를 판정 없이 쓰는 다른 자리(분석 읽기, Insight 규칙, 린트)는 이번에 살피지 않았다.
- 큰 규모에서의 시간.

## 작업 분해

PR 하나, 구현자 한 명이 순서대로. 자세한 그래프는 설계 보고에 있다.

| 작업 | 산출물 | 기준 | 선행 |
|---|---|---|---|
| RVS-T1 | 엔진·저장소: 전략의 묶음 넓히기, 중복 제거, 색인 파일 판정, 열기 실패 닫기 | C1, C4, C5, C6 | 없음 |
| RVS-T2 | 백엔드: 구성원의 줄 판정, 원본 목록의 상한 `next` | C2, C3 | 없음(T1 뒤에 이어서) |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | 이슈 #302·#268·#283·#287의 남은 백엔드 줄 25건을 코드와 대조해 결함 6건을 한 묶음으로 정함 |
| 2026-11-24 | 확정 | 상태 | 결함 6건과 잠정 결정 D1~D7을 그대로 받아들임. D7(`heldShown`의 줄 판정)은 후속 이슈로 넘김 |
| 2026-11-24 | R2의 줄 판정을 양 끝 항목이 모두 보이는 줄로 한정(D3 보강) | RVS-D3 | 구현 중 발견: 가려진 가운데 항목에 닿는 줄은 항목 때문에 가려져, 전부 판정하면 X02F-C2(가려진 중간을 낀 구성원이 `mergeId: null`로 실림)가 깨짐. D3의 의도(가려진 항목을 낀 구성원은 그대로)에 맞춤 |
