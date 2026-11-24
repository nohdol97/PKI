# 스펙: DPF — 보류된 기능 묶음("다른 것" 표시의 목록·풀기, 바꿔 저장된 JSONL 파일 위치)

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D10 포함)
- 관련: 이슈 #283("spec이 넘긴 것" 첫 줄), #258(F5). [X02B spec](2026-11-24-X02B-explore-curation.md)(X02B-R7 ④, 비목표 "구별 표시 목록"), [S02 spec](2026-11-22-S02-entity-resolution-temporal-graph.md)(구별 R16, 읽기 문 R25), [MGV spec](2026-11-24-MGV-member-visibility-followups.md), [I02 spec](2026-11-22-I02-local-file-import.md)(I02B-R7·R9·R37·R41·C33, 결정 D33), [I02F spec](2026-11-24-I02F-followups.md)(F5를 넘긴 줄)
- 번호: 요구사항 `DPF-R<n>`, 완료 기준 `DPF-C<n>`, 결정 `DPF-D<n>`, 작업 `DPF-T<n>`. **마이그레이션, 새 테이블, 새 의존(패키지)은 없다.** 계약은 경로 하나를 더한다(`entityDistinctMarks`). 기존 경로의 요청·응답 모양은 그대로다.

| 말 | 뜻 |
|---|---|
| "다른 것" 표시 | 두 항목이 같은 것이 아니라는 표시(`item_distinct`의 한 줄, S02-R16). 남긴 쪽은 사용자(`user`) 또는 연결 검사(`link-check`) |
| 가려진 것, 읽기 문 | X02 spec의 뜻 그대로. 가려진 항목은 없는 번호와 똑같이 답한다 |
| 바꿔 저장 | 편집기가 새 파일을 쓰고 그 이름을 원래 이름으로 바꿔 덮는 저장 방식. 경로는 같지만 파일의 정체(`ino`)가 달라진다 |
| 다시 연결 | 사용자가 위치를 다시 골라 승인 검사를 새로 받는 것(I02B-R9, 경로 `relinkLocalLocation`) |

## 배경

두 항목 모두 앞선 spec이 범위를 지키려고 넘긴 것이다. main(`76622395`)을 확인한 결과다.

### ① "다른 것" 표시는 만들 수 있지만 읽을 수 없다

- 만드는 길과 푸는 길은 이미 있다. `POST /api/entities/distinct`(`packages/contracts/src/index.ts:2181`)의 요청은 `{ a, b, on }`이고 `on: false`가 풀기다(`:1188-1196`). 저장 쪽 `setDistinct`는 `on`이 거짓이면 그 줄을 지우고 합치기 후보를 다시 계산한다(`storage/src/entity-decisions.ts:295-309`). 서버는 두 항목과 그 묶음의 대표가 모두 보일 때만 받는다(`backend/src/server.ts:812-816`, `:1174-1179`).
- **읽는 길이 없다.** `item_distinct`를 읽는 곳은 지우기 거절의 "걸린 것" 개수(`backend/src/read-gate.ts:539-543`)와 저장 쪽 개수(`storage/src/semantic-user.ts:228`)뿐이다. 어느 응답도 표시된 상대를 답하지 않는다.
- 그래서 화면은 **방금 한 표시 하나**만 기억했다가 풀 수 있다(`apps/web/src/entity-curation.tsx:114`의 `marked`, `:245-256`). 화면을 떠나면 그 표시를 찾을 방법도 풀 방법도 없다. 합치기 되돌리기의 "다른 것으로 남기기"(`:185-188`)와 연결 검사가 남긴 표시는 처음부터 보이지 않는다.
- X02B는 이것을 비목표("구별 표시 목록. 표시된 쌍을 읽는 경로가 없다")로 적고 넘겼다.

### ② 바꿔 저장된 JSONL 파일 위치는 계속 실패하고 화면은 "읽는 중"이다

- 승인한 JSONL 파일의 수집기는 승인 때 적은 정체(`dev`, `ino`)를 기대값으로 넘겨 파일을 연다(`backend/src/adapters/jsonl-connector.ts:109`). 경로 경계는 열린 핸들의 정체가 다르면 `redirected`로 거절한다(`packages/connector-sdk/src/local-path.ts:669-674`). 바꿔 저장은 같은 경로에 다른 `ino`를 만들므로 여기에 걸린다.
- 수집기는 그 거절을 다시 시도하지 않는 오류로 던지고(`jsonl-connector.ts:111-115`), 동기화는 `connector-failed`로 멈춘다(`backend/src/connectors.ts:198-199`). 주기마다 같은 실패가 쌓인다.
- **이 거절은 의도된 보호다.** I02B-C33은 "승인 뒤 다른 파일로 갈아 끼우면 그 내용을 읽지 않는다"를 기준으로 고정했고 시험이 있다(`backend/src/jsonl-file-location.test.ts:202-221`). 파일 시스템에서 바꿔 저장과 갈아 끼우기는 구별되지 않는다. JSONL의 줄은 삭제(`delete`)도 실을 수 있어, 갈아 끼운 파일을 조용히 읽으면 원본이 지워질 수 있다.
- **위치 상태는 아무도 바꾸지 않는다.** 폴더·파일 위치의 훑기는 `jsonl-file`을 건너뛰고(`backend/src/adapters/local-files-connector.ts:707`), JSONL 수집기는 위치가 `active`인지만 읽는다(`backend/src/composition.ts:894-901`). 그래서 목록은 계속 "읽는 중"이다(`apps/web/src/local-locations-text.ts:31`).
- **다시 연결이 막혀 있다.** `relinkOne`은 `jsonl-file`이면 `bad-request`다(`backend/src/local-locations.ts:341-342`, 결정 D33). 남은 길은 철회(그 위치의 원본을 모두 지움) 뒤 재승인뿐이다.
- 덧붙여 화면의 "다시 연결"은 위치 종류와 상관없이 폴더 선택 창을 연다(`apps/web/src/local-locations.tsx:226`의 `pick("folder")`).
- 참고: 문서 파일 위치(`file`)는 바꿔 저장을 받아들인다(`local-files-connector.ts:268-285`, 정체를 비교하지 않고 볼륨만 비교). 문서 파일은 삭제 줄을 실을 수 없어 사정이 다르다.

## 목표

1. 사용자가 한 항목에 걸린 "다른 것" 표시를 모두 보고, 하나씩 풀 수 있다.
2. 그 목록은 읽기 문을 지난다. 가려진 항목의 이름·번호·개수가 어디에도 나오지 않는다.
3. 읽을 수 없게 된 JSONL 파일 위치는 화면에 "찾을 수 없음"으로 보이고, 사용자가 "다시 연결"로 그 자리에서 되살린다. 원본을 지우지 않는다.
4. 승인 때의 보호는 그대로다. 사용자가 다시 고르기 전에는 바뀐 파일의 내용을 한 줄도 읽지 않는다.

## 하지 않는 것

- **바뀐 파일을 자동으로 받아들이기.** 같은 경로·같은 볼륨이면 다음 동기화가 알아서 읽게 하는 방식은 I02B-C33을 뒤집는다(DPF-D6).
- **구성원에 걸린 표시를 대표에서 보기, 표시 전체 목록(항목을 고르지 않은), 표시 이력.**
- **#283의 나머지 줄**(측정, 시험 보강, 그림 요약의 개수, 구성원 이름으로 찾기, 이어 읽기)과 **#258의 F4·F7·"JSONL 파일 추가" e2e**.
- **탐색 화면 본체(`apps/web/src/explore.tsx`)와 그 시험·e2e 고치기.** 다른 세션이 쥐고 있다. 목록은 항목 정리 컴포넌트가 스스로 읽는다.
- **파일이 너무 큼·잠김 같은 다른 읽기 실패의 표시.** 지금처럼 `connector-failed`다(DPF-D9).
- **Windows 확인, Electron 전용 e2e.** 경로 검사의 Windows 확인은 site-setup S23 그대로다.

## 요구사항

### ① "다른 것" 표시의 목록과 풀기

- **DPF-R1 목록 읽기 `POST /api/entities/distinct/marks`(경로 이름 `entityDistinctMarks`).** 요청 `{ itemId }`, 응답 `{ marks: [{ id, type, name, by, at }], truncated }`. 한 줄은 그 항목과 "다른 것"으로 표시된 **상대 항목**이다(`by`는 `user` 또는 `link-check`, `at`은 표시한 때). 최근 표시부터, 같은 때면 번호 오름차순, 100줄까지다. 저장하는 것은 없다.
- **DPF-R2 읽기 문.** ① `itemId`가 없거나 가려졌거나, 그 묶음의 대표가 가려졌으면 없는 번호와 같은 `not-found`(404)다. ② 줄은 **표시 줄 자체가 보이고**(지우기 거절의 개수와 같은 판정, `read-gate.ts:511-543`), 상대 항목이 보이고, 상대의 묶음 대표도 보일 때만 싣는다. 이 세 조건은 풀기 경로가 받는 조건과 같으므로 실린 줄은 모두 풀 수 있다. ③ 가려진 줄은 응답에 흔적이 없다. 거른 뒤에 100줄을 자르고, `truncated`는 **보이는 줄**이 100을 넘을 때만 참이다. ④ 응답과 로그에 가려진 것의 이름·번호가 없다.
- **DPF-R3 화면.** 항목 정리(`EntityCuration`) 안에 "다른 것으로 표시한 항목" 목록을 보인다. ① 줄마다 이름·종류·남긴 쪽(사용자/연결 검사)·때와 "다른 것 표시 풀기: ‹이름›" 버튼. ② 풀기는 기존 `entityDistinct`(`on: false`)를 부르고 목록을 다시 읽는다. ③ 검색 결과에서 "다른 것 표시"를 하면 목록을 다시 읽는다. 방금 한 표시만 기억하던 안내 줄(`marked`)은 목록이 대신하므로 지운다. ④ 없으면 "다른 것으로 표시한 항목이 없습니다", 읽기·풀기 실패는 기존 안내 자리에 우리말로, `truncated`면 "처음 100개만 보입니다". ⑤ 요청 중에는 두 번째 누름을 보내지 않고(기존 `createBusy`), 늦게 온 답이 다른 항목의 목록을 덮지 않는다.

### ② 바꿔 저장된 JSONL 파일 위치

- **DPF-R4 실패를 위치 상태로 적는다.** `active`인 `jsonl-file` 위치의 읽기가 자리나 정체 때문에 거절되면, 그 동기화는 지금처럼 아무것도 읽지 않고 `connector-failed`로 끝나며(I02B-C33 그대로), 위치를 `unavailable`로 옮긴다. 사유는 기존 낱말을 쓴다: `redirected`·`symlink`·`not-regular-file`은 `root-changed`, `not-readable`은 `root-missing`. 상태는 그때도 `active`일 때만 옮긴다(사이에 사용자가 일시 중지했으면 그대로 둔다).
- **DPF-R5 `unavailable`인 동안.** 동기화마다 **승인 때 적은 정체로** 다시 열어 본다. 맞으면 위치를 `active`로 되돌리고 읽는다(뺐던 디스크가 돌아온 경우, 폴더 위치의 I02B-R7과 같은 규칙). 맞지 않으면 빈 페이지를 돌려주고 cursor를 그대로 둔다. 실패 작업은 더 쌓이지 않는다.
- **DPF-R6 다시 연결.** `relinkLocalLocation`이 `jsonl-file` 위치를 받는다. ① 승인과 **같은 검사**(`checkApproval`, 종류 `jsonl-file`: 실제 경로로 풀기(심볼릭 링크는 가리키는 파일로 풀려 그 파일이 승인 대상이 된다), 일반 파일, `.jsonl`, 데이터 폴더 밖, 다른 위치와 겹치지 않음. 겹침 검사에서 자기 자신만 뺀다)를 지난다. ② 경로는 I02B-R37 그대로 선택 창의 표(ticket)로만 받는다(개발·시험 빌드만 글로 적은 경로). ③ 상태가 `unavailable`일 때만 받는다. ④ 통과하면 경로와 정체를 새로 적고 `active`가 되며, 위치 ID·인스턴스 ID·이미 들어온 원본은 그대로이고 그 인스턴스의 동기화를 지금 등록한다. ⑤ 거절이면 아무것도 바뀌지 않는다. 다시 연결 뒤 첫 동기화는 파일 해시가 달라 전체 다시 읽기다(I01-R23, `deletionsMayBeMissed`).
- **DPF-R7 화면.** ① `unavailable`인 `jsonl-file` 줄에 안내를 보인다: "파일이 승인한 때와 달라졌습니다. 같은 파일이 맞으면 '다시 연결'로 다시 골라 주세요. 원본은 지워지지 않습니다." ② "다시 연결"은 그 위치의 **종류**에 맞는 선택 창을 연다(`jsonl-file`이면 JSONL 파일 선택). 폴더 선택으로 고정돼 있던 것을 고친다.

### 바꾸는 자리

| 요구사항 | 파일 |
|---|---|
| R1 | `packages/contracts/src/index.ts`(스키마 둘, `routes` 한 줄), `backend/src/server.ts`(처리기 한 줄), `backend/src/api.contract.test.ts`(요청 표) |
| R2 | `backend/src/read-gate.ts`(읽기 문의 새 읽기 하나. 기존 `heldShown`의 판정을 함께 쓴다), 새 시험 `backend/src/entity-distinct-marks.test.ts` |
| R3 | 새 `apps/web/src/entity-distinct.tsx`, 새 `apps/web/src/entity-distinct.test.tsx`, `apps/web/src/entity-curation.tsx`(목록을 그리고 `marked`를 지움), `apps/web/src/entity-text.ts` |
| R4, R5 | `backend/src/adapters/jsonl-connector.ts`(포트에 상태 읽기·옮기기), `backend/src/composition.ts`(포트 잇기), `backend/src/jsonl-file-location.test.ts` |
| R6 | `backend/src/local-locations.ts`(`relinkOne`), `backend/src/jsonl-file-instances.ts`(동기화를 지금 등록하는 훅), `backend/src/local-locations.relink.test.ts`, `backend/src/jsonl-file-location.test.ts` |
| R7 | `apps/web/src/local-locations.tsx`, `apps/web/src/local-locations-text.ts`, `apps/web/src/local-locations.test.tsx` |
| 문서 | `docs/connector-sdk.md`(9장 "승인한 JSONL 파일 위치"), I02 spec의 D33 행과 변경 이력, X02B spec의 변경 이력, `docs/README.md` |

건드리지 않는 것: `apps/web/src/explore.tsx`와 그 시험, `apps/web/e2e/*`, `storage/`(저장 쪽 풀기와 `relinkLocation`은 이미 있다), 경로 경계 모듈(`packages/connector-sdk/src/local-path.ts`).

## 완료 기준 (테스트 가능한 형태)

단위·계약 시험이 중심이고 e2e는 더하지 않는다(DPF-D10). 대표 경우 한두 개씩만 본다.

- [ ] **DPF-C1** (R1, R2): 항목 A를 B·C와 "다른 것"으로 표시하고 C를 가리면, `entityDistinctMarks({ itemId: A })`의 `marks`에 B만 있고(`by`가 `user`, `at`이 있다) `truncated`는 거짓이며, 그 응답은 C와 표시한 적이 없을 때의 응답과 같다. A를 가리거나 없는 번호를 물으면 둘 다 같은 404다. — `backend/src/entity-distinct-marks.test.ts`
- [ ] **DPF-C2** (R1): 계약 시험의 경로 표에 `entityDistinctMarks`가 있고 실제 응답이 그 스키마를 지난다. — `backend/src/api.contract.test.ts`
- [ ] **DPF-C3** (R3): 목록이 줄마다 이름 붙은 풀기 버튼을 그리고, 풀기를 하면 `entityDistinct`가 `{ a, b, on: false }`로 불린 뒤 목록을 다시 읽는다. 빈 목록이면 "없습니다" 글이 보인다. — `apps/web/src/entity-distinct.test.tsx`
- [ ] **DPF-C4** (R4, R5): 승인한 JSONL 파일을 새 파일로 이름 바꿔 덮으면 ① 그 동기화는 `connector-failed`이고 새 내용의 원본이 0건이며 ② 위치 목록에서 그 위치가 `unavailable`·`root-changed`다 ③ 다음 동기화는 실패가 아니고 원본 수가 그대로다. 파일을 다른 이름으로 치웠다가 **같은 파일을** 제자리에 돌려놓으면 다음 동기화 뒤 위치가 `active`다. — `backend/src/jsonl-file-location.test.ts`
- [ ] **DPF-C5** (R6): C4의 `unavailable` 위치를 같은 경로로 다시 연결하면 `active`가 되고 적힌 `ino`가 새 파일의 것이며, 같은 인스턴스 ID로 새 내용이 들어오고 앞서 들어온 원본이 남아 있다. `.jsonl`이 아닌 파일이나 폴더로 다시 연결하면 거절되고 위치는 `unavailable` 그대로이며 아무것도 읽지 않는다. `active`인 위치의 다시 연결은 `bad-request`다. — `backend/src/local-locations.relink.test.ts`, `backend/src/jsonl-file-location.test.ts`
- [ ] **DPF-C6** (R7): `unavailable`인 `jsonl-file` 줄에 안내 글과 "다시 연결" 버튼이 보이고, 누르면 선택 창이 종류 `jsonl-file`로 열려 그 표로 `relinkLocalLocation`이 불린다. — `apps/web/src/local-locations.test.tsx`

**변이 확인**(허용·차단을 정하는 가드만): ① R2의 상대 항목 가림 판정은 두 겹이다: 표시 행 검사 `rowOk`는 표시 줄 두 항목의 원본을, 상대 항목 검사 `itemOk`는 상대 항목 하나의 원본을 본다. 기본 범위 정책에서는 상대 원본이 가려지면 두 겹이 함께 거절하므로 한 겹만 빼면 초록이고, 두 겹을 함께 빼면 빨개지는 것은 LCF-C4(보이는 대표 밑 가려진 구성원)뿐이다. C1의 가린 항목 C는 자기 묶음 대표라 묶음 대표 검사(`read-gate.ts:287`)가 계속 걸러 내므로 두 겹을 함께 빼도 C1은 초록이다. 부분집합 판정을 함의하지 않는 배포처 정책(빈 범위 목록 거절 등)에서는 `itemOk`만이 가드인 경우가 있으나 그 시험은 두지 않는다(UIF-D3). ② R6의 승인 검사를 건너뛰면 C5의 거절 단언이 빨개진다. 결과를 PR 본문에 적는다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **DPF-D1 목록은 `exploreItem`의 칸이 아니라 따로 둔 경로다.** `exploreItem`에 칸을 더하면 탐색 화면의 시험 대역(`explore.test.tsx`, 다른 세션이 쥠)을 모두 고쳐야 하고, 풀기 뒤에 중심 항목 전체를 다시 읽게 된다. 따로 두면 항목 정리 컴포넌트가 혼자 읽고 다시 읽는다. 합치려면 `ExploreItemResponseSchema`의 `center`에 `distinct`를 더하고 이 경로를 지운다.
- **DPF-D2 풀 수 있는 줄만 싣는다.** 상대의 묶음 대표가 가려진 줄을 실으면 풀기가 늘 `not-found`로 끝난다(X02F에서 `mergeId`로 겪은 모양). 넓히려면 R2 ②의 세 번째 조건을 빼고 화면에서 버튼을 숨긴다.
- **DPF-D3 그 항목 자신에게 걸린 표시만 보인다.** 구성원에 걸린 표시는 그 구성원을 열어야 보인다. 대표에서 함께 보려면 읽는 대상을 "항목과 보이는 구성원"으로 넓히고 줄에 어느 구성원의 것인지를 싣는다(계약 변경).
- **DPF-D4 100줄에서 자르고 이어 읽기는 없다.** 한 항목의 표시는 사람이 손으로 남기는 수다. 넘으면 `truncated`로 알린다. 이어 읽으려면 요청에 `after`를 더한다.
- **DPF-D5 연결 검사가 남긴 표시도 보이고 풀 수 있다.** 저장 쪽 풀기는 남긴 쪽을 가리지 않고 지우며 후보를 다시 계산한다. 화면이 남긴 쪽을 글로 보여 주므로 사용자가 알고 푼다. 막으려면 화면에서 `link-check` 줄의 버튼을 뺀다.
- **DPF-D6 (D33과의 관계) 바뀐 파일은 자동으로 받아들이지 않고, 사용자가 다시 연결한다.** D33의 "다시 연결은 없다"만 뒤집고 나머지(승인 때 첫 동기화, `active`가 아니면 빈 페이지와 cursor 유지, 철회 때 정리)는 그대로 둔다. I02B-C33도 그대로다: 갈아 끼운 파일을 **발견한 동기화**는 여전히 읽지 않고 `connector-failed`다. 자동 수용(같은 경로·같은 볼륨이면 읽기, 문서 파일 위치의 방식)을 고르지 않은 이유는 ① 바꿔 저장과 갈아 끼우기를 구별할 수 없고 ② JSONL 줄은 삭제를 실을 수 있어 조용히 읽으면 승인한 범위가 넓어지기 때문이다. 다시 연결은 사용자가 선택 창에서 고르는 행위라 승인과 같은 동의다. 대가: 바꿔 저장하는 편집기를 쓰면 저장할 때마다 한 번 다시 연결해야 한다. 자동 수용으로 바꾸려면 `jsonl-connector.ts`가 기대 정체 대신 볼륨만 비교하게 하고 C33과 C4를 고친다(그때는 설정으로 켜는 방식을 권한다).
- **DPF-D7 다시 연결은 다른 경로도 받는다.** 폴더·파일 위치의 다시 연결(I02B-R9)과 같은 규칙이고 계약을 바꾸지 않는다. 사용자가 선택 창에서 직접 고른 파일이며 승인 검사를 모두 지난다. 같은 자리로만 묶으려면 `relinkOne`에서 검사 결과의 실제 경로가 적힌 경로와 다르면 거절한다(거절 코드 하나가 계약에 더해진다).
- **DPF-D8 발견한 동기화 한 번만 실패로 남는다.** 그 뒤는 R5의 빈 페이지라 실패 작업이 주기마다 쌓이지 않는다. 발견한 동기화도 조용히 끝내려면 R4에서 오류를 던지지 않고 빈 페이지를 돌려준다(C33의 문장을 고쳐야 한다).
- **DPF-D9 상태로 옮기는 실패는 자리·정체의 것뿐이다.** 너무 큼·잠김·데이터 폴더 안·정체를 알 수 없음은 "찾을 수 없음"이 아니고 다시 연결로 풀리지도 않는다. 지금처럼 `connector-failed`다. 넓히려면 R4의 사유 표에 줄을 더하고 화면 글을 더한다.
- **DPF-D10 e2e는 더하지 않는다.** 탐색 정리의 e2e 파일(`explore-curation.e2e.ts`)은 다른 세션이 쥐고 있고, "JSONL 파일 추가"의 e2e는 #258에 따로 남아 있다. 두 흐름 모두 API 시험과 컴포넌트 시험으로 증명한다.

## 미검증 범위

- **Windows.** 바꿔 저장 뒤의 정체 값과 다시 연결의 경로 검사는 macOS에서만 돈다(site-setup S23).
- **실제 편집기.** 시험은 `rename`으로 바꿔 저장을 흉내 낸다. 어느 편집기가 이 방식으로 저장하는지는 재지 않는다.
- **브라우저에서의 실제 누름.** 목록·다시 연결 화면은 컴포넌트 시험으로만 본다(D10).

## 작업 분해

PR 하나, 한 worktree에서 이어서 한다. ①과 ②는 서로 기대지 않는다. 전체 시험은 PR 직전에 한 번만 돈다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 명령 |
|---|---|---|---|---|---|
| DPF-T1 | 목록 경로(계약·읽기 문·처리기)와 시험 | C1, C2 | 없음 | `packages/contracts/src/index.ts`, `backend/src/read-gate.ts`, `backend/src/server.ts`, `backend/src/entity-distinct-marks.test.ts`, `backend/src/api.contract.test.ts` | `pnpm exec vitest run backend/src/entity-distinct-marks.test.ts backend/src/api.contract.test.ts` |
| DPF-T2 | 목록·풀기 화면 | C3 | T1 | `apps/web/src/entity-distinct.tsx`, `entity-distinct.test.tsx`, `entity-curation.tsx`, `entity-curation.test.tsx`, `entity-text.ts` | `pnpm exec vitest run apps/web/src/entity-distinct.test.tsx apps/web/src/entity-curation.test.tsx` |
| DPF-T3 | 실패를 위치 상태로, 돌아온 파일 다시 읽기 | C4 | 없음 | `backend/src/adapters/jsonl-connector.ts`, `backend/src/composition.ts`, `backend/src/jsonl-file-location.test.ts` | `pnpm exec vitest run backend/src/jsonl-file-location.test.ts` |
| DPF-T4 | JSONL 파일 위치의 다시 연결 | C5 | T3 | `backend/src/local-locations.ts`, `backend/src/jsonl-file-instances.ts`, `backend/src/local-locations.relink.test.ts`, `backend/src/jsonl-file-location.test.ts` | `pnpm exec vitest run backend/src/local-locations.relink.test.ts backend/src/jsonl-file-location.test.ts` |
| DPF-T5 | 위치 화면의 안내와 종류별 선택 창 | C6 | T4 | `apps/web/src/local-locations.tsx`, `local-locations-text.ts`, `local-locations.test.tsx` | `pnpm exec vitest run apps/web/src/local-locations.test.tsx apps/web/src/local-locations-text.test.ts` |
| DPF-T6 | 문서: connector-sdk 9장, I02 D33 행, X02B·I02 변경 이력 | — | T4 | `docs/connector-sdk.md`, `docs/specs/2026-11-22-I02-local-file-import.md`, `docs/specs/2026-11-24-X02B-explore-curation.md` | `pnpm exec vitest run backend/src/connector-sdk.docs.test.ts` |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 이 문서 | #283 "spec이 넘긴 것" 첫 줄과 #258 F5를 한 묶음으로 |
| 2026-11-24 | R6·C5에서 "심볼릭 링크 거절"을 "심볼릭 링크는 실제 파일로 풀림, 거절은 `.jsonl`이 아닌 파일·폴더"로 고침 | R6, C5 | 구현 중 `checkApproval`이 승인 때부터 `realpath`로 링크를 풀어 가리키는 파일을 승인한다는 것을 확인(`local-path.ts:330`). 다시 연결도 같은 검사이므로 같은 동작이다 |
| 2026-11-24 | 변이 ①을 "두 겹을 함께 빼야 빨개진다"로 고침 | 변이 확인 ① | LCF 구현 중 측정: `read-gate.ts`의 `rowOk`·`itemOk`는 서로 대신 막아 한 겹만 빼면 시험이 초록 (#335 F1) |
| 2026-11-24 | 변이 ①에서 두 겹을 함께 빼면 빨개지는 것은 C1이 아니라 LCF-C4뿐임을 밝히고, "같은 원본 합집합"을 두 검사가 보는 원본으로 고침 | 변이 확인 ① | UIF(#342 F1·F2): C1의 가린 항목은 묶음 대표라 `read-gate.ts:287`이 계속 거름. 두 검사가 보는 원본은 서로 다름 |
