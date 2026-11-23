# 스펙: I02 후속 — 메일 첨부 metadata와 첨부 안의 근거 위치를 레코드에 담기

- 날짜: 2026-11-23 / 상태: 확정(잠정 결정 포함)
- 관련: 이슈 #122, 상위 #19(I02-C1의 "첨부 metadata"), [I02-B spec](2026-11-22-I02-local-file-import.md) 후속 표 F1, [I01 spec](2026-11-21-I01-connector-sdk.md)(레코드 규격, I01-R7 block, I01-R29 근거의 위치), [site-setup](../site-setup.md) S01. 앞 spec들은 고치지 않고 이 문서가 잇는다. 번호는 `I02C-…`이다.

| 말 | 뜻 |
|---|---|
| 첨부 metadata | 첨부 하나의 이름·형식(media type)·크기(바이트). 첨부의 내용물이 아니다 |
| 첨부 block | 본문 구간 가운데 "이 글은 몇 번째 첨부에서 왔다"는 표시(`attachment`)가 붙은 block |

## 배경

이슈 #19의 I02-C1은 "첨부 metadata·근거 위치를 보존한다"를 요구한다. I02-A와 I02-B는 파일 하나의 표·쪽·칸 위치까지만 다뤘고, 첨부는 메일의 것이라 F1로 미뤘다. 지금 레코드 규격(`SourceRecordSchema`)에는 첨부를 적을 자리가 없고 스키마가 엄격해서, 배포처의 메일 수집기가 첨부를 실으려 하면 레코드가 통째로 거부된다. 실제 메일 수집기는 배포처 포크의 일이므로, 공용 저장소가 할 일은 **실을 자리와 읽는 규칙**을 만들고 합성 자료로 증명하는 것이다.

## 목표

- 수집기가 레코드에 첨부의 이름·형식·크기를 싣고, 본문 구간이 어느 첨부의 어느 자리(쪽, 칸 등)에서 왔는지 적을 수 있다.
- 그 정보가 정본에 버전과 함께 남고, 근거를 열면 "어느 첨부의 어디"인지 보인다.
- 첨부가 없는 레코드와 지금의 JSONL 파일은 전과 똑같이 동작한다.

## 비목표

- **첨부 내용물의 수신·보관·정규화.** 제품은 첨부 파일을 받지도 두지도 않는다(ADR 0017). 첨부의 글을 본문에 넣을지와 그 정규화는 수집기의 몫이다.
- 실제 메일 수집기, 메일 시스템 연동: 배포처 후속(site-setup S01).
- JSONL 줄에 block을 싣는 것. JSONL v1에는 block이 없으므로 JSONL로 들어온 원본은 첨부 목록만 갖고 첨부 안의 위치는 갖지 않는다.
- 첨부 이름으로 검색하기, 원본의 첨부 목록 화면, Insight 근거 목록(`insightEvidence`)에 첨부 표시, AI 제공자에게 보내는 문맥에 첨부 metadata 넣기.
- 저장소 스키마 변경(마이그레이션), SDK 버전 올리기, 새 API 경로.

## 요구사항

- **I02C-R1 첨부 목록.** `SourceRecordSchema`에 선택 필드 `attachments`를 더한다. 원소는 엄격한 객체 `{ name, mediaType, size }`이고 목록은 0~100개다. 없는 레코드는 전과 같이 통과한다. `CONNECTOR_SDK_VERSION`(2)과 저장되는 레코드 스키마 버전은 그대로다.
- **I02C-R2 신뢰하지 않는 값의 한도.** `name`은 1~255자이고 제어 문자(U+0000–001F, U+007F–009F)와 `/`, `\`를 담지 못한다. `mediaType`은 127자 이하의 소문자 `type/subtype`(매개변수 없음)이다. `size`는 0 이상 `Number.MAX_SAFE_INTEGER` 이하의 정수다. 어기면 그 레코드만 `schema`로 거부된다. 제품은 `name`을 경로로 열거나 잇지 않고 글자로만 보여 준다. `size`와 `mediaType`은 원 시스템이 말한 값이며 제품은 확인하지 않는다.
- **I02C-R3 첨부 block.** `BlockSchema`에 선택 필드 `attachment`(0 이상의 정수, `attachments`의 순번)를 더한다. 순번이 목록 길이 이상이거나 목록이 없으면 그 레코드는 `invalid-blocks`로 거부된다. 판정은 `blocksValid` 한 곳에서 하고, 제품의 받아들이기(`page-store`)와 계약 테스트 묶음(`packages/testkit`)이 같은 함수를 쓴다. `locator`는 그대로 첨부 **안에서의** 위치(예: PDF 3쪽)다.
- **I02C-R4 JSONL.** `ImportRecordSchema`에 선택 필드 `attachments`(원소 `{ name, media_type, size }`, R1·R2와 같은 한도)를 더하고 `recordToChange`가 레코드의 `attachments`로 옮긴다. `schema_version`은 `"1"` 그대로이고, 필드가 없는 줄과 골든 데이터는 전과 같다. 파일 수집기와 가져오기 API는 같은 `parseJsonl`을 쓰므로 한 번의 변경으로 둘 다 받는다.
- **I02C-R5 저장.** 첨부 목록은 그 버전의 출처 정보(`source_versions.meta` JSON의 `attachments`)에 남는다. 새 표·열이 없다. 출처 정보의 다른 값처럼 내용 해시에는 들지 않는다(D2).
- **I02C-R6 근거에서 읽기.** `evidenceSource` 응답에 `attachment: { name, mediaType, size } | null`을 더한다. 근거 구간의 시작이 든 block에 `attachment`가 있으면 그 버전의 해당 첨부, 아니면 `null`이다. 저장하지 않고 읽을 때 계산한다(I01-R29와 같은 방식). 근거 화면은 위치 줄 앞에 첨부의 이름·형식·크기를 글자로 보여 준다.
- **I02C-R7 보임과 삭제.** 첨부 metadata는 부모 원본의 것이다. 읽는 길은 지금의 읽기 검사(`gate.evidenceSource`)를 지나는 R6 하나뿐이고, 원본이 보이지 않으면 첨부도 나오지 않는다. 원본이 삭제·철회되어 버전이 지워지면 첨부 metadata도 함께 사라진다(버전 행의 값이므로 따로 지울 것이 없다. 시험으로 고정한다).
- **I02C-R8 문서.** [connector-sdk.md](../connector-sdk.md) 3장의 필드 표와 block 설명, 9장의 JSONL 대응 표에 위 필드를 적는다. site-setup S01의 "추적 이슈는 따로"를 이슈 #122와 이 spec의 링크로 바꾼다.

## 인터페이스 / 설계 개요

```ts
// @pki/contracts connector.ts
AttachmentSchema = z.strictObject({ name, mediaType, size })      // R2의 한도
BlockSchema      = { start, end, locator, attachment?: number }    // R3
SourceRecordSchema.attachments?: Attachment[]                      // 최대 MAX_ATTACHMENTS(100)
blocksValid(body, blocks, attachmentCount = 0): boolean            // 순번 검사를 더함
// @pki/contracts index.ts
EvidenceSourceResponseSchema.attachment: Attachment | null
```

값이 지나는 길은 지금 있는 것 그대로다: 레코드 → `page-store`(스키마, `blocksValid`) → `knowledge-engine/arrival.ts`(출처 정보에 `attachments`를 더함) → `saveSourceRecord`(고치지 않는다) → `storage/evidence-view.ts`(block과 `meta`에서 계산) → 근거 화면. `server.ts`와 `composition.ts`는 고치지 않는다.

### 대안과 기각 사유

| 대안 | 기각 사유 |
|---|---|
| 첨부를 별도 표(`source_attachments`)나 새 열에 저장 | 마이그레이션이 필요하고 삭제·복원 경로마다 새 표를 챙겨야 한다. 버전 행의 `meta`에 두면 버전과 함께 지워지고 되살아난다 |
| locator의 각 형식에 `attachment`를 넣기 | 여덟 형식에 같은 필드를 되풀이한다. "어느 파일인가"는 형식 안의 자리가 아니라 block의 성질이다 |
| 첨부를 원본(레코드) 하나씩으로 따로 내기 | 스레드·정체·삭제 전파를 새로 정해야 하고 I02-C1이 요구하는 것(metadata와 위치)보다 크다 |

## 완료 기준 (테스트 가능한 형태)

합성 자료만 쓴다. 기준마다 대표 사례 하나둘이다.

- [x] **I02C-C1** (R1, R2): 첨부 둘을 가진 합성 메일 레코드가 `SourceRecordSchema`를 통과하고, `attachments`가 없는 레코드도 통과한다. 이름에 `/`가 있는 것, `mediaType`이 `type/subtype`이 아닌 것, 첨부 101개인 것은 각각 통과하지 못한다.
- [x] **I02C-C2** (R3): `attachment: 2`인 block을 가진 첨부 둘짜리 레코드를 받으면 `page-store`가 `invalid-blocks`로 거부하고 다른 변경은 저장된다. 계약 테스트 묶음이 같은 레코드를 내는 수집기에 `invalid-blocks`를 보고한다.
- [x] **I02C-C3** (R4): `attachments`가 있는 JSONL 줄을 `parseJsonl`에 넣으면 변경의 `record.attachments`가 `mediaType`으로 옮겨져 있고, 이름에 `\`가 있는 줄은 `schema`(필드 `attachments`)로 그 줄만 거부된다. 필드가 없는 줄의 변경은 `record.attachments`가 `undefined`이고 지금의 JSONL 시험이 그대로 통과한다.
- [x] **I02C-C4** (R5, R6): 첨부 둘과, 본문 block 하나·`attachment: 1`인 PDF block 하나를 가진 레코드를 받아들인 뒤, 첨부 block 안에서 시작하는 근거의 `evidenceSource` 응답이 둘째 첨부의 `{ name, mediaType, size }`와 그 block의 locator를 갖는다. 본문 block에서 시작하는 근거와 첨부가 없는 원본의 근거는 `attachment: null`이다.
- [x] **I02C-C5** (R6): 근거 화면 컴포넌트가 `attachment`가 있는 응답에서 첨부 이름·형식·크기를 글자로 그리고, `null`이면 그 줄이 없다.
- [x] **I02C-C6** (R7): 읽기 검사가 가리는 근거의 `evidenceSource`는 전과 같이 `not-found`이고 응답에 첨부 이름이 없다. 첨부 이름을 표식으로 가진 원본을 삭제하고 지운 뒤 DB 파일에 그 표식이 없다(`purge-canary` 시험에 표식 하나를 더한다).
- [x] **I02C-C7** (R8): 문서 시험(`connector-sdk.docs`)이 3장 필드 표에 `attachments`가, 9장 대응 표에 `attachments`가 있음을 보고, site-setup S01에 `#122`가 있다.

## 미해결 질문 / 검증하지 않은 범위

- **배포처 후속**: 실제 메일의 첨부 이름(인코딩된 헤더, 255자 초과, 경로가 섞인 이름)을 R2의 한도에 맞게 다듬는 일, 첨부의 글을 본문에 넣을 때의 정규화와 block 만들기는 메일 수집기(S01)가 하고 거기서만 확인할 수 있다.
- 첨부만 바뀌고 제목·본문·block이 그대로인 새 revision은 새 버전이 되지 않는다(D2). 메일은 고쳐지지 않으므로 지금은 문제가 아니다.

## 잠정 결정과 가정

| 번호 | 결정 | 이유 | 바꾸려면 |
|---|---|---|---|
| D1 | SDK 버전(2)과 JSONL `schema_version`("1")을 올리지 않고 선택 필드로 더한다 | 있는 수집기·파일이 그대로 통과한다. 포크는 빌드할 때 공용 저장소와 묶이므로 옛 제품이 새 필드를 만날 일이 없다 | `CONNECTOR_SDK_VERSION`을 올리고 connector-sdk.md 10장에 옮기는 법을 더한다 |
| D2 | 첨부 목록은 `meta`에 두고 내용 해시에 넣지 않는다 | 저장 함수와 마이그레이션을 건드리지 않는다. 해시에 넣으면 JSONL `revoke` 줄의 내용 대조(`page-store`의 `contentHash(title, body)`)가 첨부 있는 원본에서 어긋난다 | `contentHash`에 첨부를 넣고 `revoke` 줄의 기억(`expectedContent`)에도 첨부를 싣는다 |
| D3 | 한도: 첨부 100개, 이름 255자, 형식 127자. 넘으면 잘라 내지 않고 레코드를 거부 | 제품이 조용히 고치면 근거의 순번이 어긋난다. 다듬기는 원문을 아는 수집기가 한다 | `connector.ts`의 상수 값을 바꾼다 |
| D4 | 이름에 `/`, `\`, 제어 문자를 허용하지 않는다 | 이름이 경로로 읽힐 여지를 스키마에서 없앤다. 수집기는 마지막 경로 조각만 싣는다 | `AttachmentSchema`의 `name` 검사를 푼다(제품은 어차피 경로로 쓰지 않는다) |
| D5 | 순번 참조(`attachment: n`)를 쓴다 | 이름은 한 메일 안에서 겹칠 수 있다. block마다 이름을 되풀이하지 않는다 | block에 첨부 ID 문자열을 두고 첨부에 `id`를 더한다 |
| D6 | 읽는 곳은 `evidenceSource` 하나, 화면은 근거 화면의 한 줄 | I02-C1이 요구하는 것은 보존과 근거 위치다. 목록 화면은 요구가 생기면 만든다 | `EvidenceSummarySchema`나 원본 보기 응답에 같은 필드를 더한다 |

| D7 | `blocksValid`의 `attachmentCount`가 없으면 0이다. 첨부 block이 있는 레코드에 `attachments`가 없으면 `invalid-blocks`다 | R3의 "목록이 없으면 거부"를 한 곳에서 판정 | 기본값을 바꾼다 |
| D8 | 근거 읽기에서 `meta`가 없거나 block이 가리키는 순번에 첨부가 없으면 던지지 않고 `attachment: null`이다 | 직접 넣은 행·복원 경로에서 읽기 전체가 죽지 않게 | `attachmentAt`을 바꾼다 |
| D9 | 근거 화면의 줄은 `첨부: 이름 (형식, N바이트)` 모양이다 | 이름은 신뢰하지 않는 글자라 `<bdi>`로 감싼다 | `attachmentDetailText`와 화면 한 줄 |

가정: 한 레코드의 첨부 순서는 수집기가 정하고 같은 revision 안에서 바뀌지 않는다.

## 작업

한 PR, 한 구현자. 각 작업은 실패하는 시험부터 쓴다.

| 작업 | 기준 | 고치는 곳 | 선행 |
|---|---|---|---|
| T1 규격과 판정 | C1, C2, C3 | `packages/contracts/src/connector.ts`, `import-record.ts`, `packages/connector-sdk/src/jsonl.ts`, `backend/src/page-store.ts`, `packages/testkit/src/connector.contract.ts`와 각 시험 | 없음 |
| T2 저장과 근거 읽기 | C4, C6 | `knowledge-engine/src/arrival.ts`, `storage/src/evidence-view.ts`, `packages/contracts/src/index.ts`(응답), `backend/src/evidence-api.test.ts`, `knowledge-engine/src/purge-canary.test.ts` | T1 |
| T3 근거 화면 | C5 | `apps/web/src/evidence-view.tsx`, `evidence-text.ts`와 시험 | T2 |
| T4 문서 | C7 | `docs/connector-sdk.md`, `docs/site-setup.md`, `backend/src/connector-sdk.docs.test.ts` | T1 |

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-23 | 작성, 확정 | 이 문서 | 이슈 #122(I02-B 후속 표 F1) |
| 2026-11-23 | 구현 완료, C1~C7 체크, 잠정 결정 D7~D9 추가 | 이 문서 | 구현자 보고 |
