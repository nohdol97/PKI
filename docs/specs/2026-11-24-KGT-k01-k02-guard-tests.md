# 스펙: K01·K02 가드 시험 묶음(KGT) — 데이터를 지키는 가드 넷에 시험 붙이기

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 KGT-D1~D5 포함)
- 관련: 이슈 #247(U2·U3, 트리거 대조, #282 정리 함수), #235(F4·F7, C7), #225(C3b ①). [K02 spec](2026-11-23-K02-reflection-consolidation.md)(R13·R16·R17·D19), [K01 spec](2026-11-23-K01-wiki-projection.md)(R8·R13·R19·D20), [P4F spec](2026-11-24-P4F-followups.md)(분류 표의 "시험 보강" 행), [K01K02F spec](2026-11-24-K01K02F-followups.md)(KF-R1)
- 번호: 요구사항 `KGT-R<n>`, 완료 기준 `KGT-C<n>`, 결정 `KGT-D<n>`. **제품 코드·마이그레이션·계약 변경은 없다.**
- 기준 코드: `origin/main` `c5cc49f2`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

P4F가 "시험 보강"으로 남긴 줄을 코드와 다시 대조했다. 가드는 모두 있고 동작도 맞다. 고칠 결함은 없다. 남긴 것은 **데이터·보임을 지키거나 허용·차단을 정하는 가드인데 그 가드를 지워도 초록인 것**뿐이다.

| 항목 | 분류 | 근거(`파일:줄`) | 처리 |
|---|---|---|---|
| K-1 #247 U2 의견 쓰기 거부 | 시험 없음 | `storage/src/reflection-refine.ts:96`(계보 해시 확인), `:99`(`AND status = 'open'`). 이 함수를 부르는 시험은 `knowledge-engine/src/lint-kind.test.ts:187` 하나로 맞는 해시로만 쓴다 | R1 |
| K-1의 작업 쪽 앞걸음 | 하지 않음 | `knowledge-engine/src/reflection-refine-job.ts:62`·`:66`은 Provider 호출 전에 거르는 비용 가드다. 저장 여부는 위 쓰기 가드가 정한다 | D1 |
| K-2 #247 U3(20건 상한, 8개 초과 건너뜀, weekly에서만 넣기, 실제 실행기의 held) | 하지 않음 | `storage/src/reflection-refine.ts:58`·`:61`은 비용·주기 상한이다. 호출 예산·동의·전송은 Broker가 판정하고, 동의 없을 때 Provider를 부르지 않는 것은 `reflection-refine-job.test.ts:133`이 본다 | D3 |
| K-3 #247 트리거 상수 고정, v31 dirty 심기 | 하지 않음 | 트리거 집합 = 상수는 `storage/src/reflection.test.ts:67`이 본다. 빠진 dirty는 누락이 아니라 지연이다(weekly 커서, K02-R4). 데이터·보임 가드가 아니다 | D3 |
| K-4 #282 정리 함수의 `target_b`·관계 갈래 | 시험 없음 | `storage/src/reflection.ts:172`(`target_b`), `:174`(관계). 기존 시험은 항목 `target_a`(`reflection.test.ts:93`)와 사실(`:116`)뿐 | R2 |
| K-5 #235 F4·F7 원본 삭제 경로의 `#gone` | 이미 있음 | `knowledge-engine/src/wiki-kind.test.ts:236-249` | 하지 않음 |
| K-5 #235 F4·F7 `undoCreated` 자리, API의 `#gone` 조회·삭제 | 시험 없음 | 되돌리기의 이동은 `storage/src/semantic-user.ts:259`, API는 `backend/src/wiki-read.ts:241`(주인 없는 메모 목록)·`:400`(삭제 허용). `orphanNotes`·`note-remove`를 부르는 백엔드 시험이 없다 | R3 |
| K-6 #235 C7 되돌리기 경로의 `#gone` 이동 | 시험 없음 | `storage/src/wiki.test.ts:190`은 페이지·계보·연결만 본다 | R3(K-5와 한 시험) |
| K-7 #225 C3b ① 저장된 요약이 있는 채로 원본 삭제 | 시험 없음(경로) | 요약 비우기 `storage/src/wiki.ts:149`, 삭제 경로가 같은 함수를 부름 `knowledge-engine/src/wiki-kind.ts:63`. 카나리 시험 `wiki-kind.test.ts:152`는 요약 없이 돈다 | R4 |

## 목표

- 데이터·보임 가드 다섯 줄(R1~R4)이 지워지면 빨개지는 시험을 저장소 안에 둔다.

## 비목표

- 제품 코드 변경(시험 파일만 바꾼다). K-2·K-3, 작업 쪽 앞걸음(D1).
- #247·#235·#225의 다른 줄(성능, 문구, 배포처).
- 다른 세션(HVT)이 쥔 파일: `backend/src/system-measure*`, `tooling/scenarios/*`.

## 요구사항

- **KGT-R1** 의견 쓰기(`writeFindingOpinion`)는 발견의 지금 계보 해시가 물은 해시와 다르거나 발견이 `open`이 아니면 쓰지 않는다는 것을 시험한다(K02-D19).
- **KGT-R2** 대상 없는 발견 정리(`removeDanglingFindings`)가 두 번째 항목(`target_b`)이 사라진 발견과, 관계가 사라진 발견을 지운다는 것을 시험한다(KF-R1).
- **KGT-R3** 사용자가 만든 항목을 되돌리면 그 페이지의 메모가 `#gone` 키로 옮겨져, 같은 번호를 다시 받은 항목의 페이지(API)에는 나오지 않고, API의 주인 없는 메모 목록에 나오며 지울 수 있다는 것을 시험한다(K01-D20, R19).
- **KGT-R4** 요약이 저장된 페이지의 원본을 지우면 그 트랜잭션 직후 Wiki 테이블 어디에도 지운 원본의 글이 없다는 것을 시험한다(K01-C3b ①, R13).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| KGT-C1 | 열린 `synonym` 발견에 ① 다른 계보의 해시로 쓰면 `false`이고 의견 칸이 비어 있다 ② `dismissed`로 바꾼 뒤 맞는 해시로 쓰면 `false`이고 의견 칸이 비어 있다. 대조로 열린 발견·맞는 해시는 `true`다(R1) | `storage/src/reflection-refine.test.ts`(새 파일) |
| KGT-C2 | 두 번째 항목을 되돌린 `synonym` 발견과, 사용자가 더했다 되돌린 관계의 발견이 되돌리기 뒤 `listFindings`에 없다(R2) | `storage/src/reflection.test.ts` 「reflection.dangling」 묶음 새 사례 |
| KGT-C3 | 사용자가 만든 항목의 페이지에 메모를 달고 항목을 되돌린 뒤 같은 번호의 항목과 페이지를 다시 만들면: `page(key).notes`가 비고, `index().orphanNotes`에 `pageKey`가 `<key>#gone`인 그 메모가 있고, 그 메모의 `note-remove`가 `applied`다(R3) | `backend/src/wiki-gate.test.ts` 새 묶음 |
| KGT-C4 | 카나리 원본이 받치는 남는 페이지에 카나리 문장을 담은 요약을 저장한 뒤 그 원본을 지우면, 모든 `wiki_*` 테이블의 내용에 카나리가 없다(R4) | `knowledge-engine/src/wiki-kind.test.ts:152` 묶음 새 사례 |

넷 다 지금 동작을 묶는 시험이라 처음부터 통과한다(D5). 대신 가드 한 줄을 지워 빨개지는 것을 한 번씩 확인하고 되돌린다.

| 기준 | 지울 가드 줄 | 빨개질 단언 |
|---|---|---|
| KGT-C1 ① | `storage/src/reflection-refine.ts:96` `if (lineageHash(lineageOfFinding(tx, id)) !== hash) return false;` | ① |
| KGT-C1 ② | `storage/src/reflection-refine.ts:99`의 ` AND status = 'open'` | ② |
| KGT-C2 | `storage/src/reflection.ts:172` `OR (target_b IS NOT NULL AND target_b NOT IN (SELECT id FROM items))`, 따로 `:174` 관계 갈래 | 각 발견 |
| KGT-C3 | `storage/src/semantic-user.ts:259` `endWikiItemIncarnation(tx, ref.id);` | `notes`가 빈다 |
| KGT-C4 | `storage/src/wiki.ts:149`의 `summary = NULL, summary_hash = NULL` | 카나리 없음 |

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| KGT-D1 | U2는 저장 함수 `writeFindingOpinion`에서 시험하고, 작업의 앞걸음(`reflection-refine-job.ts:62`·`:66`)은 시험하지 않는다 | 무엇이 저장되는지는 쓰기 가드가 마지막으로 정한다. 앞걸음을 지워도 Broker가 지금 계보만 등급 매겨 보내므로 새는 것은 없고 Provider 호출 한 번이 늘 뿐이다 | 작업 시험에 "계보를 바꾼 뒤 돌리면 `provider.requests`가 비어 있다"를 더한다 |
| KGT-D2 | K-5의 남은 반과 K-6을 API 수준 시험 하나로 묶는다(`userDecisions.undo` → `createWikiReads`) | 되돌리기 자리(F4), 이동(C7), API 조회·삭제(F7)를 한 흐름이 지난다. 사례 하나로 셋을 덮는다 | 저장소 층 `storage/src/wiki.test.ts:190`에 `#gone` 단언을 따로 둔다 |
| KGT-D3 | K-2·K-3은 하지 않고 #247에 그대로 둔다 | 비용·주기 상한과 dirty 지연은 데이터·보임·허용 가드가 아니다(테스트 간략화 규칙 1·5) | 다음 묶음에서 시험 보강으로 잡는다 |
| KGT-D4 | K-7은 기존 카나리 묶음에 사례를 더하고 요약은 `writeWikiSummary`로 직접 저장한다 | 요약 작업(Provider)을 돌리지 않아도 저장된 요약 칸이 비는지가 질문이다 | `wiki-summary-job.test.ts`처럼 fake Provider로 요약을 만든다 |
| KGT-D5 | 처음부터 초록인 시험의 빨강은 가드 변이로 보인다 | 동작이 이미 맞아 실패 시험을 먼저 만들 수 없다(RPF와 같음) | — |

## 미검증 범위

- 위 사실은 읽기로 확인했다. 가드 변이가 실제로 빨개지는지는 구현 때 처음 확인한다.
- KGT-C3에서 되돌린 번호를 새 항목이 다시 받는지(`storage/src/reflection.test.ts:112`가 같은 일을 확인한다). 다시 받지 않으면 `notes` 단언은 키 문자열로 확인한다.
- Windows, e2e.

## 작업

PR 하나, 구현자 한 명. 시험 파일·검증 명령은 작업 지도(`_workspace/pki-kgt/phase1_architect_taskmap.md`)에 있다. `docs/README.md` 색인에 이 spec 한 줄을 더한다. 머지 뒤 #247(U2, 정리 함수 시험 줄), #235(F4·F7, C7), #225(C3b ①)의 해당 체크박스를 고치고 세 이슈는 열어 둔다(다른 줄이 남음).

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | P4F가 남긴 K01·K02 시험 보강 줄을 코드와 대조해 데이터·보임 가드 시험 넷으로 정리 |
