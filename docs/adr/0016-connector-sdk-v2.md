# ADR 0016: Connector 규격 v2 — 출처·순서를 싣는 레코드, 네 가지 변경, 버전 검사

- 날짜: 2026-11-22 / 상태: **잠정 — 배포처 검증 대기**(실제 수집기로 지키는지는 S18에서 확인한다)
- 관련: [I01 spec](../specs/2026-11-21-I01-connector-sdk.md)(I01-R1~R7, "T01과 T02 사이"), 이슈 #18(I01), [ARCHITECTURE 5.5절](../ARCHITECTURE.md), [ownership.md 7절](../ownership.md), [ADR 0012](0012-upstream-and-fork-ownership.md), [ADR 0013](0013-failure-recovery.md), [ADR 0014](0014-egress-policy-and-consent.md)
- 후속: 규격 버전은 2 그대로이고, 수집기에 자격 증명을 건네는 선택 항목(`initialize`의 둘째 인자 `context`, `ConnectorCredentialError`, 건강 사유 상수)은 [ADR 0019](0019-connector-credentials.md)가 더했다. 인자 하나만 받는 v2 구현은 고치지 않아도 된다.

## 맥락

V01이 만든 Connector 규격(`schemaVersion` 1)의 원본 레코드는 `externalId`, `title`, `body`뿐이었다. 그래서 다음을 실을 자리가 없었다.

- 한 수집기 인스턴스 안에서 원본 식별자가 유일한 범위(위키 공간, 편지함). 이 범위가 없으면 공간이 다른 같은 번호의 글 둘이 한 원본으로 합쳐진다.
- 원 시스템이 매긴 개정 번호. 늦게 온 옛 사건이 최신을 덮는지 가릴 근거다.
- 접근 범위, 작성자·참여자·시각 같은 출처 정보, 문서의 원래 자리(쪽, 시트와 칸).

삭제와 권한 철회 사건은 있었지만 "내용은 그대로이고 볼 수 있는 사람만 바뀜"을 나타낼 사건이 없었고, 수집기가 실패를 "다시 해도 됨"과 "기다려야 함"으로 나눠 알릴 방법도 없었다. 배포처 포크가 실제 수집기(S01~S03)를 만들기 전에 규격을 고정해야 포크의 구현이 공용 저장소의 변경에 깨지지 않는다(ownership.md 7절).

## 결정

1. **규격 버전 `CONNECTOR_SDK_VERSION = 2`**를 `@pki/contracts`에 둔다. 수집기의 `manifest.schemaVersion`은 자기가 구현한 규격 버전이다. Connector 관리 모듈은 2가 아닌 수집기를 **초기화하지 않고** 상태를 `unavailable`(사유 `unsupported-sdk-version`)로 둔다. 이 사유는 Connector 목록 API와 `site-check`에 보이고, 그 인스턴스의 동기화 요청은 `connector-unavailable`로 답한다.
2. **원본 레코드 v2**(`SourceRecordSchema`, 모르는 필드는 거부):
   - 정체: `namespace`(빈 문자열 허용, 범위가 하나면 빈 문자열)와 `externalId`
   - 순서: `revision`(1 이상의 정수, 필수). 원 시스템이 고칠 때마다 커진다. 도착 순서를 가리는 데만 쓰고 제품의 version 번호와 섞지 않는다.
   - 형식 버전: `schemaVersion`(2)
   - 내용: `title`, `body`, 선택 `blocks`
   - 선택: 접근 범위 `accessScope`(비어 있지 않은 문자열 배열), 출처 정보(`sourceType`, `sourceUrl`, `author`, `participants`, `threadId`, `createdAt`, `updatedAt`, `metadata`)
   - **수집기 인스턴스 ID, 데이터 등급, 합성 여부, 악성 표시는 실을 수 없다.** 인스턴스 ID는 관리 모듈이 동기화하는 인스턴스에서 붙인다. 레코드가 자기 인스턴스를 주장할 수 있으면 다른 인스턴스의 원본으로 끼어들 수 있다.
3. **변경은 넷이다.** `upsert`(레코드 하나), `scope-change`(범위만 바뀜), `delete`(원 시스템에서 지워짐), `access-revoked`(이 PC의 사용자가 더는 볼 수 없음). 뒤의 셋은 `namespace`, `externalId`, `revision`, `at`(UTC 오프셋이 붙은 시각)을 갖고 내용이 없다. V01의 tombstone 사건에 있던 `version`은 `revision`이 되었다.
4. **`ChangeSet.rejected`**: 수집기가 스스로 걸러 낸 항목의 목록(기본 빈 목록). 항목은 위치 `at`과 닫힌 목록의 사유 코드다. `at`은 `종류:숫자` 모양(`^[a-z][a-z0-9-]{0,15}:[0-9]{1,9}$`)만 인정한다. 내용을 담을 수 없게 하려는 것이다. 페이지 스키마는 어긋난 `at`으로 페이지 전체를 버리지 않고, 관리 모듈이 그것을 `change:<n>`으로 바꾼다(I01-T03).
5. **block과 locator**: `blocks`는 본문의 코드 포인트 구간 `[start, end)`과 원래 형식의 자리(locator)의 목록이다. locator는 I02의 위치표와 같은 모양이며 `format`으로 갈리는 여덟 형식(pdf, docx, xlsx, csv, html, markdown, txt, json)이다. 구간 규칙(정렬, 겹침 없음, 본문 안)은 본문이 있어야 판정하므로 스키마와 따로 `blocksValid`가 보고, 어긋난 레코드는 `invalid-blocks`로 거부한다.
6. **능력 선언**에 `deletionsOnRescan`(재스캔이 그동안의 삭제를 모두 다시 알림)을 더한다. 참이면 `deletes`와 `fullRescan`도 참이어야 한다.
7. **실패 두 종류**: `ConnectorError`(`retryable`), `ConnectorRateLimitError`(`retryAfterMs`). 관리 모듈은 오류 문구를 옮기지 않고 사유 코드만 남긴다(문구에 원 시스템의 내용이 섞일 수 있다). `ConnectorNotImplementedError`는 그대로다.
8. **`getDocument`는 `{ namespace, externalId }`를 받는다.**
9. **정본의 원본 정체는 `connector_instance_id + namespace + external_id`다.** 마이그레이션 v12(I04-T01의 v10, I03-T01의 v11 뒤)가 `sources`를 다시 만들어 유일 키를 바꾸고, 이전 원본은 빈 namespace로 옮긴다. namespace에는 기본값을 두지 않는다. 쓰는 쪽이 언제나 이름을 대게 하려는 것이다.
10. **v1 호환 층은 두지 않는다.** 규격, 그 규격을 쓰는 공용 저장소의 모든 구현(테스트 Connector, JSONL 가져오기, `site-*` 미구현 표시, 테스트 대역), 계약 테스트를 같은 PR에서 옮긴다.

`EvidenceView`(근거 하나를 읽은 모양: version, 코드 포인트 구간, 인용문, locator 또는 null)도 이 규격에 둔다. 값을 채우는 일은 I01-T07이다.

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| v1 수집기를 계속 받는 호환 층 | v1 구현은 공용 저장소의 것뿐이고 이 변경에서 함께 옮긴다. 쓰는 사람이 없는 호환 층은 지울 수 없는 코드가 된다 |
| 버전이 다른 수집기도 초기화하고 경고만 | 레코드 모양이 다르면 저장 단계에서 페이지마다 실패하거나, 더 나쁘게는 빠진 필드를 기본값으로 메워 잘못 저장한다. 초기화 전에 막아야 원인이 한 줄로 보인다 |
| `revision`을 선택 필드로 | 도착 순서와 "지운 뒤 다시 만든 것"을 가를 값이 없어진다. 원 시스템에 정수 번호가 없으면 수정 시각을 밀리초 정수로 옮긴다(SDK 문서, I01-T10) |
| 레코드가 인스턴스 ID를 싣기 | 레코드가 다른 인스턴스의 원본을 주장할 수 있다. 관리 모듈이 동기화하는 인스턴스로 붙인다 |
| 어긋난 `rejected[].at`이면 페이지 전체를 거부 | 위치 표기 하나의 실수로 정상 레코드까지 저장되지 않는다. 모양만 바꾸고 계약 테스트가 위반으로 잡는다 |
| `sources.namespace`에 기본값 `''` | 쓰는 코드가 namespace를 빠뜨려도 조용히 통과해 공간이 다른 원본이 합쳐진다 |

## 결과

- 포크가 옮겨 가는 방법(v1 → v2):
  1. `manifest.schemaVersion`을 `CONNECTOR_SDK_VERSION`(2)로 하고, `capabilities`에 `deletionsOnRescan`을 더한다.
  2. 레코드마다 `namespace`(범위가 하나면 `""`), `revision`, `schemaVersion: 2`를 채운다. 원 시스템의 개정 번호가 정수가 아니면 수정 시각의 밀리초를 쓴다.
  3. `delete`·`access-revoked` 사건의 `version`을 `revision`으로 바꾸고 `namespace`를 붙인다. `at`은 UTC 오프셋이 붙은 ISO-8601이다. 범위만 바뀐 원본은 `scope-change`로 낸다.
  4. `getDocument(externalId)`를 `getDocument({ namespace, externalId })`로 바꾼다.
  5. 다시 시도해도 되는 실패는 `ConnectorError`(`retryable: true`), 요청 한도는 `ConnectorRateLimitError`로 던진다.
  6. 계약 테스트(`@pki/testkit`의 `connectorContract`)를 다시 돌린다. 버전이 2가 아니면 그 테스트가 실패하고, 제품은 그 수집기를 `unsupported-sdk-version`으로 띄우지 않는다.
- 이 PR에서 정본이 바로 쓰는 것은 정체의 namespace와 레코드의 revision(V02-T04의 `source_versions.revision`)뿐이다. 출처 정보와 block의 저장, revision으로 도착을 가리는 판정, `scope-change`의 저장은 I01-T02가 한다. 그 전까지 `scope-change`를 받으면 그 페이지가 실패하고, tombstone 사건은 V02-T08의 삭제를 그 원본의 최신 제품 version으로 부른다(I01 spec "T01과 T02 사이").
- 화면의 원본 목록과 삭제 요청도 namespace를 싣는다. 삭제 요청 `{ connectorId, namespace, externalId }`는 namespace가 필수라, 같은 external id가 여러 namespace에 있어도 사용자가 고른 원본 하나만 지운다. 그래서 포크의 수집기가 빈 문자열이 아닌 namespace를 써도 화면에서 지울 수 있다.
- manifest를 읽을 수 없는 수집기(없음, 던지는 getter)도 `unsupported-sdk-version`으로 그 인스턴스만 멈춘다. 다른 인스턴스는 그대로 돈다.
- 공용 저장소의 수집기는 인스턴스마다 범위가 하나라서 namespace가 `""`다. JSONL 줄의 `connector_instance_id`를 namespace로 옮기는 일은 `@pki/connector-sdk`의 해석기가 한다(I01-T05. 가져오기 API와 파일 수집기가 쓴다). V02의 Sources 화면 경로(`/api/import/jsonl`)는 아직 그 줄을 인스턴스로 보고 namespace를 `""`로 둔다.
- 레코드 모양이 바뀌었으므로 이미 저장된 원본은 다시 저장되지 않는다. v12 이전 원본은 빈 namespace를 갖고, 같은 수집기가 같은 정체로 다시 보내면 같은 원본으로 찾힌다.

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-22 | 최초 작성(잠정) | 이 문서 | I01-T01, I01-R1(호환이 깨지는 변경은 ADR에 바뀐 점과 이전 방법을 적는다) |
| 2026-11-22 | 결과에 화면 목록·삭제 요청의 namespace와 읽을 수 없는 manifest를 더함 | 결과 | I01-T01 검토 A-S1·B-S1·B-S2 |
| 2026-11-22 | 마이그레이션 번호를 v12로 고침(I04-T01의 v10, I03-T01의 v11이 먼저 머지) | 결정 9, 결과 | origin/main 재기반 |
