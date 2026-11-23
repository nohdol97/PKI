# 스펙: I02 후속 — 로컬 자료·첨부 검토에서 남은 지적 묶음

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 포함)
- 관련: 이슈 #237(I02B-T04)·#263(#122 첨부)·#249(T05)·#258(T06)·#200·#190·#179. [I02 spec](2026-11-22-I02-local-file-import.md)의 I02B-R8·R13·R39·C28과 [첨부 spec](2026-11-23-I02-attachment-metadata.md)의 D2를 잇는다. 두 spec은 고치지 않고 이 문서가 인용한다. 번호는 `I02F-…`이다.

| 말 | 뜻 |
|---|---|
| 삭제 보류 | 한 번에 너무 많은 파일이 사라졌을 때, 사용자가 수를 확인할 때까지 삭제를 미뤄 두는 것(I02B-R8). 색인 항목의 `pendingDelete = 1` |
| 제동 판정 | 이번 훑기에서 사라진 파일 수와 비율이 한도(기본 20개·0.5)를 넘는지 보는 계산 |
| 읽기 관문 | 원본이 지금 이 사용자에게 보여도 되는지 답하는 한 곳(`read-gate.ts`의 `sourceShown`) |
| 인스턴스 잠금 | 한 수집기 인스턴스에 동기화·철회·가져오기가 한 번에 하나만 돌게 하는 잠금 |

## 배경

일곱 이슈의 남은 항목을 이 작업 나무의 코드와 하나씩 맞춰 보았다. 이미 고쳐진 것과 시험 보강·문구뿐인 것을 빼면 **동작이 틀리는 다섯**과 **작은 미룬 기능 하나**가 남는다.

1. 삭제 보류가 스스로 풀린다. 제동 판정을 훑기마다 새로 하는데, 새 파일이 늘어 비율이 내려가거나 보류한 파일 일부가 돌아와 수가 한도 아래로 내려가면 **남은 보류 파일이 확인 없이 삭제로 나간다**(#237 FU2). 예: 40개 중 25개 보류 → 새 파일 20개 추가 → 25/60 < 0.5 → 25개 삭제.
2. "폴더에서 보기"가 읽기 관문을 지나지 않는다. 화면이 version 번호만 주면, 가려진 원본이라도 OS 파일 관리자가 그 파일 자리에서 열린다(#237 FU3).
3. 삭제 반영을 읽지 않는 위치(`paused`·`revoking`)에서도 받는다(#237 FU4).
4. 전체 다시 훑기는 인스턴스 잠금이 잡혀 있으면 아무 일도 하지 않는데 응답은 `queued`다(#237 FU6).
5. 제목·본문·block이 같고 첨부 목록만 다른 새 개정이 "변경 없음"으로 버려져 옛 목록이 남는다. 순서만 바뀐 경우 근거가 엉뚱한 첨부를 보인다(#263 F-1·F-2).
6. DOCX 메모에서 온 근거의 위치가 "문단 N"으로만 보인다. 계약에는 메모 모양(`comment`)이 생겼는데 문구가 없다(#237 C28, #249 F6).

## 목표

- 위 여섯을 고친다. 항목마다 대표 시험 한두 건을 둔다.

## 비목표

- **스키마와 저장 데이터를 바꾸지 않는다**(마이그레이션 없음). 내용 해시(`contentHash`)의 계산도 그대로다.
- HTTP 계약(`packages/contracts`)과 서버 경로(`backend/src/server.ts`)는 고치지 않는다. 필요한 오류 코드(`instance-busy`·`bad-request`)와 화면 문구는 이미 있다.
- JSONL 파일 위치의 다시 연결(#258 F5)은 하지 않는다. I02 결정 D33을 뒤집는 기능이고 수집기·위치 API·화면을 함께 고쳐야 한다.
- 시험 보강·문구·비용 측정뿐인 항목, Windows나 배포처가 있어야 확인되는 항목, 느린 정규화기 묶음(C49·C17)은 다루지 않는다(아래 「미루는 항목」).

## 요구사항

- **I02F-R1 (삭제 보류는 스스로 풀리지 않는다, #237 FU2)** 이미 보류된 파일(`pendingDelete = 1`)이 이번 훑기에도 없으면, 제동 판정이 거짓이어도 **보류를 유지한다.** 보류가 풀리는 길은 셋뿐이다: 사용자의 수 확인, 그 파일이 돌아옴, 다시 연결. 보류가 남아 있는데 위치가 `active`면 그 훑기에서 `needs-confirmation`으로 돌린다. 제동 판정의 식과, 보류된 적 없는 파일의 처리는 그대로다.
- **I02F-R2 ("폴더에서 보기"의 읽기 관문, #237 FU3)** 셸에 돌려주는 절대 경로는 읽기 관문이 그 version을 보인다고 답할 때만 만든다. 가려졌거나 없는 version은 같은 답(경로 없음)이다. 관문 없이 경로를 얻는 함수 모양을 남기지 않는다.
- **I02F-R3 (삭제 반영을 받는 상태, #237 FU4)** 삭제 반영은 `paused`·`revoking`인 위치에서 `bad-request`로 거절하고 아무것도 바꾸지 않는다. 그 밖의 상태는 지금과 같다.
- **I02F-R4 (전체 다시 훑기의 정직한 답, #237 FU6)** 인스턴스 잠금이 잡혀 있어 다시 훑기를 시작하지 못하면 `instance-busy`(409)로 답한다. 시작했으면 지금처럼 `queued`다.
- **I02F-R5 (첨부만 바뀐 개정, #263 F-1·F-2)** 받아들이기 판정의 "내용이 같다"는 **내용 해시가 같고 첨부 목록도 (순서까지) 같다**는 뜻이다. 첨부 목록만 다르면 새 version을 만든다(해시는 같고 출처 정보의 `attachments`가 새 것). 없는 목록과 빈 목록은 같다. 같은 revision에서 첨부만 다르면 내용이 다를 때와 같이 `revision-conflict`다.
- **I02F-R6 (메모 위치 문구, #237 C28·#249 F6)** DOCX 위치표에 `comment`가 있으면 `문단 N · 메모 T의 I번째 글(머리|본문)`으로 그린다(T·I는 1부터). 없으면 지금과 같다.

## 인터페이스 / 설계 개요

- `backend/src/adapters/local-files-connector.ts`의 삭제 가지: 보류 여부를 `brake || 이미 보류됨`으로 본다. 위치 상태 전환도 같은 조건이다.
- `backend/src/local-reveal.ts` `revealPathOf(db, sourceVersionId, shown)`: 관문 술어를 **필수 인자**로 받는다. `BootedBackend`에 `revealPath(sourceVersionId)`를 더하고(`boot.ts`가 조립한 registry로 관문을 만든다), `shell-main.ts`는 그것만 부른다.
- `backend/src/local-locations.ts`: `confirmDeletions`에 받는 상태 목록을 준다. `rescan` 옵션은 시작 여부(`boolean`)를 돌려주고, 거짓이면 `instance-busy`다. `boot.ts`는 잠금을 한 번 잡았다 놓아 비어 있는지 본 뒤 같은 틱에 동기화를 부른다.
- `storage/src/sources.ts` `saveSourceRecord`: 최신 version의 `meta.attachments`를 읽어 들어온 `provenance.attachments`와 정규화한 JSON으로 비교한다. 해시 비교 두 곳(같은 revision, 변경 없음)이 한 술어를 쓴다.
- `apps/web/src/evidence-text.ts` `locatorText`의 docx 가지 한 줄.

## 완료 기준 (테스트 가능한 형태)

- **I02F-C1** (R1) 40개 중 25개가 사라져 보류된 위치에 새 파일 20개를 더하고 훑으면, 삭제는 0건이고 보류는 25개이며 상태는 `needs-confirmation`이다. 그 뒤 25로 확인하면 삭제 25건이 나온다. → `backend/src/local-files-lifecycle.test.ts`
- **I02F-C2** (R2) ① 관문이 거짓이면 `revealPathOf`는 경로를 주지 않고, 참이면 파일의 경로를 준다. → `backend/src/local-reveal.test.ts` ② 모든 것을 가리는 registry로 시작한 백엔드의 `revealPath`는 경로를 주지 않고, registry가 `source` 종류에 대해 질문을 받았다. → `backend/src/boot.read-gate.test.ts`
- **I02F-C3** (R3) `paused`인 위치에 삭제 반영을 보내면 `bad-request`이고 색인의 보류 표시가 그대로다. → `backend/src/local-locations.pause.test.ts`
- **I02F-C4** (R4) 시작한 백엔드에서 `local-files` 인스턴스 잠금을 쥔 채 `POST /api/local-locations/rescan`을 부르면 409 `instance-busy`이고, 놓은 뒤에는 200 `queued`다. → `backend/src/local-rescan-busy.test.ts`(새 파일)
- **I02F-C5** (R5) 첨부 A·B를 가진 원본에 제목·본문·block이 같고 첨부가 B·A인 더 높은 revision을 저장하면 `created`이고 새 version의 `meta.attachments`가 B·A다. 첨부까지 같은 것을 다시 저장하면 `unchanged`다. → `storage/src/sources.test.ts`
- **I02F-C6** (R6) `{ format: "docx", paragraph: 4, comment: { thread: 1, index: 0, part: "head" } }`가 `문단 5 · 메모 2의 1번째 글(머리)`로 그려진다. → `apps/web/src/evidence-text.test.ts`

변이 확인은 데이터와 보임을 지키는 C1·C2에만 한다(R1의 "이미 보류됨" 조건, R2의 관문 호출을 지우면 그 시험이 빨개지는지 한 번씩, 결과는 PR 본문).

## 잠정 결정과 가정

| 번호 | 결정 | 이유 | 바꾸려면 |
|---|---|---|---|
| D1 | 보류는 "한 번 보류되면 확인·복귀·다시 연결로만 풀린다". 제동 판정의 식은 그대로 둔다 | I02 계획 P3("보류는 스스로 풀리지 않는다")을 따른다. 틀려도 잃는 것은 사용자의 확인 한 번이고, 반대쪽은 지식이 확인 없이 지워진다 | 비율이 내려가면 풀리게 하려면 삭제 가지의 조건에서 "이미 보류됨"을 빼고 C1을 지운다 |
| D2 | 관문 술어를 `revealPathOf`의 필수 인자로 둔다 | 관문 없이 부를 수 있는 모양이 남으면 같은 결함이 다시 생긴다. 호출하는 곳이 하나다 | — |
| D3 | 삭제 반영은 `paused`·`revoking`만 거절하고 `active`·`unavailable`·`needs-confirmation`은 받는다 | 읽지 않는 위치는 삭제도 알리지 않는다(I02 P2). 화면은 두 상태에서 이 동작을 내놓지 않는다. `active`는 다시 켠 직후 보류가 남은 짧은 구간이 있어 받는다 | `needs-confirmation`만 받게 하려면 상태 목록 한 줄과 기존 시험 둘(`local-locations.pause.test.ts`, `local-lifecycle.api.test.ts`의 `count-mismatch` 단언)을 고친다 |
| D4 | 잠금이 잡혀 있으면 다시 훑기를 **거절**한다. 기억해 두었다 나중에 돌리지 않는다 | 화면에 `instance-busy` 문구가 이미 있고, 사용자가 다시 누르면 된다. 기억하려면 재시작을 넘는 표시가 필요해 저장 변경이 된다 | `boot.ts`의 `rescan`에서 돌던 동기화가 끝날 때 한 번 더 부르게 하고 답을 `queued`로 되돌린다 |
| D5 | 같은 revision에서 첨부만 다르면 `revision-conflict`다 | revision 하나는 원본의 한 상태를 가리킨다(I01-R10). 조용한 "변경 없음"보다 거부 사유가 보이는 쪽이 낫다 | 같은 revision의 첨부 차이를 받으려면 같은 revision 가지에서 첨부 비교를 빼고 새 version을 만든다(한 revision에 version 둘이 생긴다) |
| D6 | 첨부 목록은 순서까지 비교한다 | block의 `attachment`가 순번이라 순서가 뜻을 가진다(F-2) | — |
| D7 | 메모 문구는 `문단 N · 메모 T의 I번째 글(머리|본문)` | 메모가 달린 문단을 먼저 보여 문서에서 찾기 쉽다. `머리`는 작성자·시각 줄이다 | `locatorText`의 한 줄과 C6 |

가정: 첨부만 바뀐 새 version은 다른 새 version과 같이 추출을 다시 돌린다(본문이 같아도). 메일은 고쳐지지 않으므로 드문 경우로 본다.

## 미루는 항목

| 항목 | 사유 | 남는 곳 |
|---|---|---|
| #258 F5 JSONL 파일을 새 사본으로 바꿔 저장하면 계속 `connector-failed` | 다시 연결 기능(D33을 뒤집음). 철회 뒤 재승인으로 돌아갈 수 있다 | #258 |
| #258 F7 `addInstance` 경합의 자격증명 회수 | 이 경로에서 자격증명을 선언하는 종류가 없다 | #258 |
| #237 FU5 `reopenLocation`의 `blocked()` | 지금은 닿는 길이 없다 | #237 |
| #200 F3 백엔드가 없을 때 폴더 선택이 조용히 끝남, F4 `excluded` | 백엔드 없이는 화면 자체가 목록을 못 읽는다. F4는 데스크톱이 항상 값을 넘긴다 | #200 |
| #249 F4·F5·F7과 #273 검토의 낮은 지적 | 비용·주석·낮은 화면 지적 | #249 |
| #179 FU2·FU3·FU4, #258 F4·e2e, #263 F-3·F-4·F-5, #237 FU1·FU7, #190·#200의 포트 묶기 시험 | 시험·타입 보강 | 각 이슈 |
| Windows·실제 `fs.watch`·Electron `showItemInFolder`·UNC 경로 | 배포처·Windows 실행이 필요 | #237, #258 |

이미 끝나 있던 것: #190 FU-2(만료 티켓 시험, `local-locations.api.test.ts`), #179 FU1·FU6(`local-files-lifecycle.test.ts`와 수집기), #258 F2·F3·F6(#264), #249 R29 나머지·F2·F3(#273).

## 남는 위험 / 검증하지 않은 범위

1. **R4의 잦은 거절.** 승인 직후처럼 동기화가 도는 동안 "전체 다시 훑기"를 누르면 거절 문구가 보인다. 얼마나 잦은지는 재지 않았다.
2. **R2는 셸 통로까지 시험하지 않는다.** `shell-main.ts`가 `revealPath`를 부르는 한 줄은 기존 셸 시험(없는 version → null)만 지난다. 실제 Electron `showItemInFolder`는 확인하지 않는다.
3. **R5의 재추출 비용.** 첨부만 바뀐 개정이 많은 수집기에서는 추출 호출이 는다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 초안 | 문서 전체 | 이슈 #237·#263·#249·#258·#200·#190·#179 |
| 2026-11-24 | 초안에서 확정으로 | 상태 | 구현 착수 |
