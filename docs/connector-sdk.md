# Connector SDK 사용 안내 — 수집기를 이 저장소 밖에서 만드는 사람에게

- 날짜: 2026-11-22 / 규격 버전: `CONNECTOR_SDK_VERSION` = 2 / 관련: [I01 spec](specs/2026-11-21-I01-connector-sdk.md), [ADR 0016](adr/0016-connector-sdk-v2.md), [ownership.md](ownership.md), [site-setup.md](site-setup.md)(S18)

이 문서는 메일·메신저·Wiki 같은 **원 시스템**(자료가 원래 들어 있는 시스템)에서 자료를 가져오는 수집기(Connector)를 새로 만드는 사람을 위한 안내다. 배포처 포크가 실제 수집기를 만들 때와 제3자가 자기 수집기를 만들 때 모두 같다. 이 저장소의 설계 문서를 읽지 않았다고 가정하고 쓴다.

**먼저 알아 둘 것: SDK는 아직 따로 내려받는 패키지가 아니다.** `@pki/contracts`, `@pki/testkit`, `@pki/connector-sdk`는 모두 `private`인 이 저장소의 워크스페이스 패키지이고 소스(`index.ts`)를 그대로 내보낸다. 그래서 수집기를 만드는 사람은 이 저장소를 복제한 곳(배포처 포크나 개인 복제본) 안에서 일해야 하고, 저장소 밖의 프로젝트에서 `npm install`로 SDK를 받을 수는 없다. 아래의 "제3자"는 이 저장소를 복제해 쓰는 사람을 뜻한다.

**이 문서가 하는 약속과 하지 않는 약속.** 아래의 모든 사실 문장은 `main`에 있는 코드나 테스트에 기대고 있다. 아직 만들지 않은 것은 만들어졌다고 쓰지 않고 [11장](#11-아직-없는-것)에 모았다. 특히 실제 메일·메신저·Wiki 수집기는 이 저장소에 없다. 있는 것은 "미구현" 표시용 자리와 합성 자료를 내는 예시뿐이다.

낯선 말은 아래처럼 쓴다.

| 말 | 뜻 |
|---|---|
| 원 시스템 | 수집기가 자료를 읽어 오는 곳(메일 서버, Wiki 등) |
| 인스턴스 | 수집기 하나를 설정 하나로 돌리는 것. 같은 수집기 코드로 인스턴스를 여럿 둘 수 있다 |
| 관리 모듈 | 제품 쪽에서 수집기를 반복해서 부르고, 받은 것을 저장하는 부분. 수집기는 저장소를 직접 만지지 않는다 |
| 정본 | 제품이 믿고 쓰는 저장 상태(SQLite 파일). 화면과 검색은 여기서 나온다 |
| cursor | "어디까지 읽었는가"를 나타내는 책갈피 글자. 수집기가 만들어 주고, 제품이 다음 호출 때 그대로 돌려준다 |
| tombstone | "이 원본은 지웠다"는 내용 없는 표시. 지운 자료가 다시 수집되어 되살아나는 것을 막는다 |

## 1. 한눈에 보는 그림

수집기는 원 시스템에서 **바뀐 것만** 조금씩 읽어 주는 일을 한다. 저장, 재시도 일정, 화면 표시, 지운 자료의 정리는 제품이 한다.

1. 제품이 시작할 때 인스턴스마다 설정을 넘겨 `initialize`를 부른다.
2. 제품이 `getChanges(cursor, { limit, signal })`를 되풀이해 부른다. 첫 호출의 cursor는 `null`이고, 이후에는 수집기가 직전에 돌려준 `nextCursor`다. 제품은 한 번에 100개까지 요청한다(`PAGE_LIMIT`).
3. 한 페이지를 저장하는 일과 그 페이지의 `nextCursor`를 확정하는 일은 한 트랜잭션이다. 저장이 실패하면 cursor도 그대로이고 같은 페이지를 다시 받는다.
4. `hasMore`가 거짓인 페이지를 저장하면 그 동기화는 끝난다.

네 메서드 가운데 `getDocument`는 이 저장소의 제품 코드가 부르지 않고 계약 테스트만 부른다. `healthCheck`는 준비되지 않은 인스턴스를 한 시간마다 다시 점검할 때만 불린다(5장).

### 이 장을 줄이면

- 수집기는 "바뀐 것을 페이지로 읽어 주는" 일만 한다.
- 저장과 cursor 확정은 제품이 한 트랜잭션으로 한다.

## 2. 수집기가 구현할 것

수집기는 `Connector` 인터페이스(`packages/contracts/src/connector.ts`)를 구현한다. 메서드는 네 개다.

<!-- excerpt: packages/contracts/src/connector.ts -->
```ts
export interface Connector {
  readonly manifest: ConnectorManifest;
  /** Unimplemented integrations fail with ConnectorNotImplementedError. */
  initialize(config: unknown, context?: ConnectorContext): Promise<void>;
  /** Never throws: `ok`, or `unavailable` with a reason. */
  healthCheck(): Promise<HealthStatus>;
  getChanges(
    cursor: string | null,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<ChangeSet>;
  /** The latest revision of a source, or null if unknown or deleted. */
  getDocument(ref: { namespace: string; externalId: string }): Promise<SourceRecord | null>;
}
```

- `initialize(config)`: 설정을 읽고 준비한다. 고칠 수 없는 설정 오류는 `ConnectorError`를 `retryable: false`로 던진다. 초기화 전에 부른 `getChanges`와 `getDocument`는 실패해야 한다(위반 코드 `responds-before-init`).
- `healthCheck()`: 예외를 던지지 않고 `ok` 또는 `unavailable`(사유)을 돌려준다. 던지면 위반 `health-threw`다.
- `getChanges`: 한 페이지에 `limit`개를 넘기면 안 되고(위반 `limit-exceeded`), 이미 취소된 `signal`로 불리면 실패해야 한다(위반 `abort-ignored`). 읽는 도중 취소 신호가 오면 제품은 이미 확정된 페이지까지 남기고 `aborted`로 멈춘다.
- `getDocument({ namespace, externalId })`: 그 원본의 가장 최근 레코드를 돌려주고, 모르거나 지워진 원본이면 `null`을 돌려준다.

### manifest와 능력 선언

`manifest`는 `type`(수집기 종류 이름), `schemaVersion`(자기가 구현한 규격 버전), `capabilities`(능력 다섯)로 이루어진다. **규격 버전이 `CONNECTOR_SDK_VERSION`(지금 2)이 아니면 제품은 그 수집기를 초기화하지 않고** 그 인스턴스를 `unavailable`(사유 `unsupported-sdk-version`)로 둔다. manifest를 읽다가 예외가 나도 같은 결과이고 그 인스턴스만 멈춘다(`initializeConnector`).

능력 선언은 "내가 무엇을 약속하는가"이며, **선언과 행동이 맞아야 한다.** 제품은 선언과 어긋난 변경을 `capability-violation`으로 거부하고, 계약 테스트는 위반으로 잡는다.

| 능력 | 참이면 약속하는 것 |
|---|---|
| `incremental` | 마지막 cursor로 다시 물으면 새 변경이 없다 |
| `deletes` | `delete`와 `access-revoked` 사건을 낸다. 거짓이면 이 사건을 내지 않는다 |
| `accessScope` | 모든 upsert 레코드가 비어 있지 않은 `accessScope`를 갖고 `scope-change` 사건도 낼 수 있다. 거짓이면 레코드에 그 필드가 없고 `scope-change`도 내지 않는다 |
| `fullRescan` | cursor `null`로 처음부터 다시 읽을 수 있다 |
| `deletionsOnRescan` | 처음부터 다시 읽으면 그 사이에 지워진 원본을 모두 `delete`로 다시 알린다. 참이면 `deletes`와 `fullRescan`도 참이어야 한다 |

`deletionsOnRescan`을 참으로 선언하는 길은 둘이다. 원 시스템이 지운 항목을 "삭제 표시"로 남겨 두는 경우(예시 수집기가 이 경우다)와, 수집기가 자기가 알린 정체의 기록을 **인스턴스 밖**(설정이 가리키는 저장소)에 두고 다시 읽을 때 대조하는 경우다. 앱을 다시 켠 뒤의 재스캔도 같은 모양이어야 하므로 기록을 인스턴스 안의 메모리에 두면 안 된다. 어느 쪽도 못 하면 거짓으로 선언한다. 거짓인 수집기도 재스캔은 되고, 대신 제품은 "그동안 지워진 원본을 놓쳤을 수 있음"(`deletionsMayBeMissed`)을 화면에 남긴다.

### 이 장을 줄이면

- 메서드 넷을 구현하고, `healthCheck`는 던지지 않으며, 취소 신호를 지킨다.
- `schemaVersion`이 2가 아니면 제품이 그 수집기를 켜지 않는다.
- 능력은 약속이다. 지킬 수 없으면 거짓으로 선언한다.

## 3. 레코드와 변경

`getChanges`가 돌려주는 것은 `ChangeSet`이다. `changes`(변경의 목록), `nextCursor`, `hasMore`, 선택 `cursorExpired`, 선택 `rejected`로 이루어진다. 변경 하나(`ChangeSchema`)는 아래 넷 가운데 하나다.

| `kind` | 담는 것 | 뜻 |
|---|---|---|
| `upsert` | 레코드(`SourceRecordSchema`) 하나 | 새로 생겼거나 고쳐진 원본 |
| `scope-change` | `namespace`, `externalId`, `revision`, `accessScope`, `at` | 내용은 그대로이고 볼 수 있는 사람만 바뀜 |
| `delete` | `namespace`, `externalId`, `revision`, `at` | 원 시스템에서 지워짐 |
| `access-revoked` | `namespace`, `externalId`, `revision`, `at` | 이 PC의 사용자가 더는 그 원본을 볼 수 없음 |

`delete`와 `access-revoked`를 묶어 **tombstone 사건**이라 부른다. 둘은 내용이 없다. 둘의 차이는 중요하다. `delete`는 "원본이 사라졌다"이고, `access-revoked`는 "원본은 있어도 이 사용자는 더 볼 수 없다"이다. 일부 사람만 못 보게 된 경우는 둘 다 아니고 `scope-change`다. 하나도 볼 수 없게 된 경우에만 `access-revoked`를 쓴다.

### 레코드의 필드(`SourceRecordSchema`)

스키마는 **엄격**하다. 모르는 필드가 하나라도 있으면 그 레코드는 거부된다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `namespace` | 예 | `externalId`가 유일한 범위(위키 공간, 편지함 등). 범위가 하나뿐이면 빈 문자열 `""` |
| `externalId` | 예 | 원 시스템이 붙인 식별자, 한 글자 이상 |
| `revision` | 예 | 1 이상의 정수. 같은 원본을 원 시스템이 고칠 때마다 커진다(4장) |
| `schemaVersion` | 예 | 정수 2, `manifest.schemaVersion`과 같아야 한다 |
| `title`, `body` | 예 | 제목과 정규화된 본문 |
| `blocks` | 아니오 | 본문 구간과 원래 형식의 위치(아래) |
| `accessScope` | 아니오 | 누가 볼 수 있는지를 원 시스템의 말로 적은 문자열 목록. 비어 있지 않은 배열이고 원소도 빈 문자열이 아니다. 없으면 "알 수 없음"(`null`)이고 가장 엄격하게 다뤄진다. 수집기가 낸 원본이 범위가 없을 때는 배포처의 매핑이 `grade(null)`로 등급을 정한다(site-setup S08) |
| `sourceType`, `sourceUrl`, `author`, `participants`, `threadId` | 아니오 | 출처 정보 |
| `createdAt`, `updatedAt` | 아니오 | UTC 오프셋이 붙은 ISO-8601(`2026-01-05T09:00:00Z` 또는 `+09:00`) |
| `metadata` | 아니오 | 문자열 키의 객체 |

**수집기가 실을 수 없는 것이 있다.** 수집기 인스턴스 ID, 데이터 등급, 합성 여부, 악성 표시를 담을 필드가 없고, 넣으면 스키마가 거부한다. 이유는 둘이다. 인스턴스 ID는 제품이 동기화 중인 인스턴스의 것을 붙이므로, 레코드가 자기 인스턴스를 주장하면 다른 인스턴스의 원본으로 끼어들 수 있기 때문이다. 데이터 등급은 수집기가 정하면 자기 자료를 느슨하게 매길 수 있어서 제품(Broker)이 정본에서 계산한다. `namespace`와 `metadata`는 어떤 판정에도 쓰이지 않는다.

### block과 locator

`blocks`는 본문의 **코드 포인트 구간** `[start, end)`과 원래 문서에서의 위치(locator)를 짝지은 목록이다. PDF 몇 쪽, 엑셀 어느 칸처럼 "근거를 원문에서 찾아 가는 데" 쓴다. 규칙은 구간이 `0 ≤ start < end ≤ 본문의 코드 포인트 수`이고, `start` 순으로 정렬되며, 서로 겹치지 않는 것이다(빈틈은 허용한다). 어기면 그 레코드가 `invalid-blocks`로 거부된다(`blocksValid`). locator는 `format`으로 여덟 형식(`pdf`, `docx`, `xlsx`, `csv`, `html`, `markdown`, `txt`, `json`)이 갈린다(`NativeLocatorSchema`). 메일·메신저·Wiki 글처럼 원래 자리가 따로 없으면 `blocks`를 생략한다. 그러면 근거는 본문의 구간만 갖는다.

### 이 장을 줄이면

- 변경은 넷(`upsert`, `scope-change`, `delete`, `access-revoked`)이고 앞의 하나만 내용이 있다.
- 레코드는 엄격하다. 인스턴스 ID·등급·합성 여부는 실을 수 없다.
- `revision`과 `namespace`는 필수 칸이다. 범위가 하나면 `namespace`는 빈 문자열이다.

## 4. 두 번호와 제품이 받아들이는 규칙

수집기가 낸 변경을 제품이 어떻게 판정하는지 알아야 올바른 `revision`을 낼 수 있다.

### 원본의 정체

원본은 **인스턴스 + `namespace` + `externalId`** 셋으로 가려진다. 셋 중 하나라도 다르면 **내용이 같아도 다른 원본**이다. 각자 접근 범위, revision, 출처 정보, 버전, 근거를 따로 갖는다. 본문이 같은지 보는 해시는 한 원본 안에서 새 버전을 만들지 말지 정하는 데만 쓴다. 지워진 원본의 식별자는 제품이 키를 쓴 해시로 바꿔 보관한다(`identityKey`). 그래서 지운 원본이 같은 정체로 다시 오면 제품이 그것을 찾아 막는다.

### revision과 version, 섞지 않는다

- **revision**은 원 시스템이 매기는 번호다. 도착 **순서**를 가리는 데만 쓴다. 한 원본을 원 시스템이 고칠 때마다 커져야 한다.
- **version**은 제품이 매기는 번호다. 새 버전을 만들 때만 쓴다. 수집기는 이것을 보지도 정하지도 않는다.

둘을 비교하거나 서로 대신 쓰지 않는다. 순서를 가리는 일과 지운 뒤에도 이어지는 번호를 매기는 일은 서로 다른 문제이기 때문이다.

### upsert 하나가 판정되는 차례

제품은 스키마, 능력 선언, block 규칙을 통과한 upsert를 아래 차례로 판정한다. "last"는 그 원본에서 제품이 지금까지 받아들인 가장 큰 revision이다.

| 차례 | 상황 | 결과 |
|---|---|---|
| 0 | 그 원본에 해제되지 않은 tombstone이 있다 | 사용자가 지운 것은 해제 전까지 모두 막는다. 출처가 지운 것·권한을 잃은 것은 tombstone의 revision보다 **큰** revision만 통과하고 나머지는 막는다. 막힌 것은 `blocked`로 세고 저장하지 않는다 |
| 1 | revision이 last보다 작다 | `stale`(옛것). 저장하지 않고 오류도 아니다 |
| 2 | revision이 last와 같다 | 살아 있는 최신 버전이 없으면(해제 뒤의 재전송) 내용과 상관없이 `stale`. 있으면 내용이 같고 범위도 같을 때 `unchanged`, 범위만 다르면 `scope-updated`, 내용이 다르면 `revision-conflict`로 그 레코드를 거부한다 |
| 3 | revision이 last보다 크다 | 내용이 같으면 새 버전 없이 last만 올린다(범위가 다르면 `scope-updated`, 같으면 `unchanged`). 내용이 다르면 `created`로 새 버전을 만든다 |

여기서 수집기가 지킬 것이 나온다.

- **같은 revision으로 내용을 바꾸지 않는다.** 2차례의 `revision-conflict`가 된다.
- **옛 revision을 뒤늦게 다시 내도 지운 원본이 되살아나지 않는다.** 0차례가 막는다. 지운 뒤에 원 시스템이 그 원본을 다시 만들었다면 tombstone의 revision보다 큰 revision으로 내야 통과한다.
- 출처 정보(`author`, `metadata` 등)만 바뀐 레코드는 새 버전을 만들지 않는다. 내용 해시는 제목, 본문, block으로 계산한다. 그래도 계약 테스트는 같은 revision에서 출처 정보만 바뀐 것을 위반(`revision-not-increasing`)으로 잡는다. 제품이 그 변경을 소리 없이 버리기 때문이다.

### tombstone 사건

- `delete`: 그 원본의 last보다 작은 revision이면 적용하지 않고 `staleTombstone`으로 따로 센다(놓친 삭제가 묻히지 않게 결과에 보인다). 같거나 크면 적용한다.
- `access-revoked`: revision과 상관없이 **언제나 적용한다.** 권한은 순서보다 앞선다.
- 적용하면 제품은 그 원본의 본문, 작성자, 파생된 지식을 지운다. 처음 보는 원본에 대한 tombstone 사건도 기록해 둔다. 나중에 도착한 옛 upsert를 막기 위해서다.
- 그래서 tombstone 사건의 revision은 그 정체로 낸 마지막 upsert의 revision 이상이어야 한다(위반 `tombstone-revision-below-upsert`).
- **삭제 장부.** 제품은 tombstone을 쓰는 같은 트랜잭션이 커밋되기 전에 삭제 장부(데이터 폴더의 파일)에 그 삭제의 줄을 먼저 적고, 적을 수 없으면 **삭제를 적용하지 않고 거부한다**(장부 없이 지운 자료는 백업을 복원할 때 되살아날 수 있기 때문이다). 장부가 적을 수 없는 경우: 그 인스턴스의 ID가 128자를 넘거나 종류가 `^[a-z][a-z0-9-]{0,63}$`가 아닐 때, 그리고 장부가 잠겼을 때다. 가져오기의 `delete`·`access-revoked` 줄은 줄별 사유 `ledger-unwritable`로, 화면의 삭제 API(`POST /api/sources/delete`)는 409 `ledger-unwritable`로 거부된다. 그래서 수집기의 종류 이름은 그 규칙을 따라야 하고 인스턴스 ID는 128자 이내여야 한다.

### 접근 범위의 변경

`scope-change`와 2차례의 `scope-updated`는 같은 처리를 받는다. 제품이 원본의 접근 범위를 바꾸고, 새 버전은 만들지 않으며, 그 범위에 기대던 파생물을 다시 판정한다. 막히면 `blocked`, last보다 작으면 `stale`이다. 같은 revision에서도 받아들인다. 살아 있는 버전이 없는 원본에 대해서는 `stale`이다.

### 부분 실패

- **레코드 하나만 거부**: 스키마 위반, `revision-conflict`, `invalid-blocks`, `capability-violation`, `scope-change-content-mismatch`. 나머지 레코드는 저장되고 cursor도 그 페이지 뒤로 확정된다. 거부 목록에는 위치와 사유 코드만 들어가고 필드의 값은 들어가지 않는다.
- **페이지 전체 실패**: `changes`·`nextCursor`·`hasMore`의 겉모양이 스키마에 맞지 않을 때(`rejected[].code`가 `REJECT_CODES` 밖의 값인 것도 여기에 든다. 그 한 항목이 페이지 전체를 `invalid-page`로 만든다), `limit`보다 많이 돌려줬을 때, 저장 트랜잭션이 실패했을 때. 그 페이지의 어느 것도 저장되지 않고 cursor는 그대로다. 같은 것을 다시 하면 같은 결과가 된다.

수집기가 스스로 걸러 낸 항목은 `rejected`에 `{ at, code }`로 알릴 수 있다. `at`은 `line:12`처럼 종류와 숫자만 담을 수 있는 모양(`rejectedPositionValid`)이어야 하며, 어긋나면 제품이 `change:<순번>`으로 바꾸고 계약 테스트가 위반 `rejected-position-invalid`로 잡는다.

### 접근 범위와 등급

레코드의 `accessScope`는 제품이 보이기·전송 여부를 판정하는 입력이다. 수집기가 원 시스템에서 읽은 범위는 수집기의 책임으로 믿는다. 데이터 등급은 수집기가 정하지 않고, 제품이 범위에서 계산한다. 범위를 등급으로 바꾸는 규칙은 배포처가 채우는 부분이라 [site-setup.md](site-setup.md)의 S08과 S18이 설명한다. 이 저장소의 기본은 모든 범위를 일반 등급 하나로 매긴다. 가져온 JSONL의 범위(9장)는 사용자가 적은 값이라 더 조심해서 다룬다.

### 이 장을 줄이면

- 정체는 인스턴스 + namespace + externalId이고, 하나라도 다르면 다른 원본이다.
- revision은 순서, version은 제품 번호다. 수집기는 revision만 낸다.
- 같은 revision으로 내용을 바꾸지 말고, 지운 원본을 다시 살리려면 더 큰 revision을 낸다.
- `access-revoked`는 언제나 적용되고, `delete`는 옛 revision이면 `staleTombstone`으로 보인다.

## 5. 동기화 계약, 재시도, 결과

### 동기화는 제품이 하고, 한 인스턴스에 하나씩만 돈다

수집기는 `sync`를 구현하지 않는다. 제품의 관리 모듈(`syncConnector`)이 1장의 순서로 `getChanges`를 되풀이해 부른다. 한 인스턴스에서는 동기화와 가져오기가 **동시에 하나만** 돈다(`tryLockInstance`). 잠금이 잡혀 있으면 정해진 동기화는 수집기를 부르지 않고 `instance-busy`로 멈춘다. 잠금은 정상 종료, 예외, 취소의 모든 경로에서 풀린다.

### 오류를 알리는 법

수집기는 실패를 두 종류의 오류로 알린다.

<!-- excerpt: packages/contracts/src/connector.ts -->
```ts
export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(message: string, { retryable }: { retryable: boolean }) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = retryable;
  }
}
```

- `ConnectorError`: 같은 호출을 다시 해도 되는지(`retryable`)를 담는다.
- `ConnectorRateLimitError(message, { retryAfterMs })`: 원 시스템이 "나중에 다시 오라"고 했을 때 기다릴 시간(밀리초)을 담는다. 음수·무한·NaN은 `RangeError`로 거부된다.
- `ConnectorNotImplementedError`: 아직 구현하지 않은 자리표시용이다. 실제 수집기는 쓰지 않는다.

**이 두 오류가 아닌 예외를 던지면** 제품은 다시 해도 되는지 알 수 없다고 보고 `connector-failed`로 멈춘다(다시 시도하지 않는다). 그러니 원 시스템의 일시 장애는 반드시 `ConnectorError`(`retryable: true`)나 `ConnectorRateLimitError`로 감싸서 던진다. 한편 **오류의 문구는 API 응답, 동기화 결과, 로그 어디에도 옮겨지지 않는다.** 문구에 원 시스템의 내용이 섞일 수 있어서 제품은 사유 코드만 남긴다. 오류 문구가 나타날 수 있는 곳과 나타나지 않는 곳을 정확히 적으면 이렇다. 동기화 결과, API 응답, 백엔드 로그, 화면에는 나타나지 않는다. **`site-check` 명령은 예외다.** 그 종류의 `initialize`가 던진 오류의 문구를 그대로 출력한다(7장). 그러니 `initialize`가 던지는 문구에는 비밀 값이나 원 시스템의 내용을 넣지 않는다.

### 재시도의 값

같은 cursor로 한 페이지를 다시 받는 일은 동기화 한 번 안에서 아래 값으로 한다. 값은 아직 재 보지 않은 잠정 값이고 `SYNC_BACKOFF` 한 곳에 있다.

- 요청 한도(`ConnectorRateLimitError`): `min(retryAfterMs, 30초)`를 기다린다.
- 재시도 가능한 `ConnectorError`: 1초부터 두 배씩 기다리되 30초를 넘지 않는다.
- 한 페이지의 시도는 모두 3회까지다. 요청 한도로 소진되면 `rate-limited`, 재시도 가능한 오류로 소진되면 `connector-error`, 재시도할 수 없는 오류는 첫 번째에 `connector-failed`로 멈춘다.
- 어느 경우든 cursor는 마지막으로 확정된 값에 남는다.

### cursor가 만료되었을 때

원 시스템이 옛 cursor를 더는 받아 주지 않으면 `{ changes: [], nextCursor: ..., hasMore: false, cursorExpired: true }`를 돌려준다(예시 수집기가 이렇게 한다). 그러면 제품은 cursor를 버리고 **처음부터 다시 읽는다**(전체 재스캔). 규칙은 다음과 같다.

- 동기화 한 번에 전체 재스캔은 한 번뿐이다. 재스캔 중에 또 만료되면 `cursor-expired`로 멈춘다.
- `fullRescan`이 거짓인 수집기가 만료를 알리면 재스캔하지 않고 `cursor-expired`로 멈춘다. **cursor가 `null`인 호출(처음부터 읽는 호출)에 `cursorExpired`를 답해도 같다.** 만료를 알릴 곳이 없으므로 `cursor-expired`로 멈추고, 정해진 동기화에서는 포기(`dead_letter`)가 된다.
- 다시 받은 원본은 4장의 판정으로 걸러져 늘지 않는다.
- `deletionsOnRescan`이 거짓이면 그 재스캔의 결과에 `deletionsMayBeMissed: true`가 붙는다. 이 표시는 앱을 다시 켜도 남아 있다. 재스캔이 끝나는 페이지는 표시를 `deletionsOnRescan` 선언대로 다시 쓴다. 그래서 `deletionsOnRescan`이 거짓인 수집기에서는 표시가 한 번 올라가면 **내려가지 않고**(재스캔이 끝날 때마다 다시 올라간다), 재스캔 중에 지워진 원본을 `delete`로 알리는 수집기(`deletionsOnRescan` 참)에서만 재스캔이 끝나면 내려간다.

### 동기화의 결과와 멈춤 코드

결과(`SyncResponse`)는 받은 변경 수(`received`)와 그 갈래(`created`, `unchanged`, `scopeUpdated`, `stale`, `staleTombstone`, `blocked`, `tombstoned`), 거부 목록(위치와 코드, 앞의 100건 `REJECTED_LIST_LIMIT`)과 전체 수(`rejectedCount`), `rescanned`, `deletionsMayBeMissed`를 담는다. 멈췄다면 사유 코드 `stopped`가 붙고, `rate-limited`이면 수집기가 마지막으로 알린 `retryAfterMs`도 붙는다. 코드는 닫힌 목록이다.

- 거부 코드(`REJECT_CODES`): `invalid-json`, `schema`, `content-hash-mismatch`, `revision-conflict`, `invalid-blocks`, `capability-violation`, `scope-change-content-mismatch`.
- 멈춤 코드(`SYNC_STOP_CODES`): `invalid-page`, `no-progress`, `cursor-expired`, `rate-limited`, `connector-error`, `connector-failed`, `aborted`, `instance-busy`, `storage-failed`.

`no-progress`는 `hasMore`가 참인데 `nextCursor`가 받은 cursor와 같을 때 멈춘다. 제품이 잡는 것은 그 경우뿐이다. cursor를 돌려 가며 끝없이 `hasMore`를 보내는 수집기는 제품이 알아채지 못하고 취소될 때까지 돈다. 알고 있는 한계다.

### 정해진 동기화가 일정에서 어떻게 다뤄지는가

주기적으로 끌어오는 동기화는 제품의 작업 대기열(`connector-sync` 작업)에서 돈다. **끌어올 설정이 있는 인스턴스**(준비 상태이고, `jsonl-import` 종류라면 `{ path }` 설정이 있는 것. 다만 지금 제품에는 그런 파일 인스턴스를 만들어 주는 길이 없다. 9장)에는 한 시간 주기가 기본으로 만들어진다(`SYNC_PERIOD`). 사용자가 바꾸거나 끈 주기는 그대로 둔다. 동기화가 어떻게 끝났는지에 따라 작업이 아래처럼 처리된다. 이 표는 코드 상수 `SYNC_OUTCOMES`와 같은 것이고, 이 문서의 표가 상수와 어긋나면 테스트가 실패한다.

| 동기화의 끝 | 작업 결과 | 시도 | 다음 실행 | 이유 |
|---|---|---|---|---|
| 멈추지 않고 끝남(거부·`stale-tombstone`·`deletionsMayBeMissed`가 있어도) | `done` | — | 다음 주기 | 레코드 단위의 일은 결과에 남았고, 다시 돌려도 같다 |
| `rate-limited` | `retry` | 씀 | 작업 대기열의 대기 시간과 결과의 `retryAfterMs` 가운데 늦은 쪽 | 시간이 지나면 풀린다 |
| `connector-error` | `retry` | 씀 | 작업 대기열의 대기 시간 | 수집기가 재시도해도 된다고 했다 |
| `instance-busy` | `retry` | 쓰지 않음 | 1분 뒤 | 같은 인스턴스의 가져오기가 끝나면 풀린다. 수집기를 부르지 않았다(`jsonl-import` 종류가 제품에 등록되면 다시 볼 것. 그 종류는 수집기를 부른 뒤에도 이 코드로 멈출 수 있다) |
| `aborted` | `retry` | 씀 | 작업 대기열의 대기 시간 | 임대 상실이나 실행 시간 초과는 실행기의 사정이다 |
| `connector-failed` | `dead_letter` | — | 없음 | 수집기가 재시도할 수 없다고 했다 |
| `invalid-page` | `dead_letter` | — | 없음 | 수집기의 규격 위반이다. 다시 돌려도 같다 |
| `no-progress` | `dead_letter` | — | 없음 | 수집기의 규격 위반이다. 다시 돌려도 같다 |
| `cursor-expired` | `dead_letter` | — | 없음 | 재스캔도 만료되었거나 재스캔할 수 없는 수집기다 |
| `storage-failed` | `retry`, 시도가 다하면 `dead_letter` | 씀 | 작업 대기열의 대기 시간 | 디스크 사정이면 다시 하면 풀린다. 늘 같은 실패면 시도가 다해 포기한 작업으로 남는다 |
| 인스턴스가 `unavailable`(초기화 시간 초과, 초기화 실패, 만드는 함수의 예외, 등록에 없는 종류, `unsupported-sdk-version`) | `held` | 쓰지 않음 | 인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 한 시간마다의 재점검 | 설정이나 수집기가 바뀌어야 풀린다 |
| 인스턴스가 `not-implemented`(`site-*`) | `held` | 쓰지 않음 | 인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 한 시간마다의 재점검 | 포크가 실제 구현을 등록해야 풀린다 |

표의 `held` 행에 적힌 풀리는 때 가운데 "인스턴스의 설정이 바뀌거나"는 **지금은 일어나지 않는다.** 제품에 인스턴스의 설정을 쓰는 곳이 없기 때문이다(7장). 지금 보류가 풀리는 때는 앱을 시작했을 때 인스턴스가 준비되어 있는 경우(앱 갱신으로 수집기가 동작하게 된 시작을 포함해 모든 시작)와 한 시간마다의 재점검이다. 재점검은 인스턴스마다 60초(`RECHECK_TIMEOUT_MS`) 안에 끝나지 않으면 기다리지 않고 넘어가며, 끝나지 않은 재점검이 있는 인스턴스는 다시 시작하지 않는다. 60초를 넘겨 끝난 재점검의 결과는 성공이든 실패든 버린다. 결과를 받는 것은 그것을 기다리고 있는 차례뿐이어야 "준비됨으로 바뀜"과 "보류된 작업을 풂"이 늘 함께 일어나기 때문이다.

수집기를 만드는 사람이 이 표에서 챙길 것은 셋이다.

1. 포기(`dead_letter`)가 되는 `connector-failed`·`invalid-page`·`no-progress`·`cursor-expired`는 **자동으로 다시 시도되지 않는다.** 일시 장애를 `ConnectorError`로 감싸지 않으면 영구 실패로 처리된다.
2. 인스턴스가 준비되지 않으면(`unavailable`, `not-implemented`) 작업은 시도를 쓰지 않고 보류된다. 제품은 한 시간마다 준비되지 않은 인스턴스의 **만드는 함수를 다시 불러 새 객체를 만들고, 그 객체를 초기화한 뒤 `healthCheck`가 `ok`인지 본다**(`recheck`). 둘 다 되면 인스턴스가 그 새 객체로 바뀌고 준비된 것으로 보며 보류를 푼다. 아니면 새 객체를 버린다. 제품은 한 객체의 `initialize`를 한 번만 부르고, 준비된 인스턴스의 객체는 바꾸지 않는다. 그러므로 `initialize`는 다시 불려도 안전할 필요는 없지만, **같은 설정의 다른 객체가 동시에 초기화 중일 수 있다**는 것을 전제로 해야 한다(시작 때 10초를 넘긴 객체가 아직 도는 중에 첫 재점검이 새 객체를 만든다. 혼자만 잡는 잠금 파일이나 포트를 쓰지 않는다). 제품은 버린 객체를 닫지 못한다(규격에 닫기가 없다). 늦게 끝나 버려진 객체가 쌓이지 않도록, 60초를 넘겨 끝난 재점검이 연달아 3번(`RECHECK_LATE_LIMIT`)이면 그 인스턴스의 재점검을 그만두고 앱을 다시 시작할 때까지 준비되지 않은 채로 둔다. `healthCheck`는 원 시스템이 돌아오면 `ok`를 돌려줘야 한다.
3. 요청 한도가 오는 쪽은 `ConnectorRateLimitError`로 알려야 대기 시간이 반영된다.

### 이 장을 줄이면

- 일시 장애는 `ConnectorError(retryable: true)`나 `ConnectorRateLimitError`로 던진다. 그 밖의 예외는 영구 실패로 보인다.
- 한 페이지의 시도는 3회이고 대기는 30초를 넘지 않는다. 값은 잠정이다.
- 만료된 cursor는 `cursorExpired`로 알린다. 제품이 처음부터 다시 읽는다.
- 인스턴스가 준비되지 않으면 한 시간마다 다시 초기화해 본다.

## 6. 계약 테스트와 예시 수집기

### 계약 테스트란

내가 만든 수집기가 위의 규격을 지키는지 자동으로 돌려 보는 검사다. `@pki/testkit`이 두 가지를 낸다.

- `checkConnector(create, scenario)`: 수집기를 돌려 보고 규격 위반을 **위반 코드의 목록**으로 돌려준다. 테스트 프레임워크와 무관하다. 문구나 레코드 내용은 싣지 않고 코드만 돌려준다.
- `connectorContract(name, create, scenario)`: 위 함수를 vitest 묶음으로 감싼 것이다. 위반이 하나도 없으면 통과한다.

`create`는 수집기를 새로 만들어 돌려주는 함수다. 검사는 새 인스턴스를 여러 번 만든다. `scenario`(`ConnectorScenario`)는 아래 값을 갖는다.

| 필드 | 뜻 |
|---|---|
| `config` | 수집기를 초기화할 설정 |
| `later` | 선택. 원 시스템이 바뀐 **뒤의** 설정. 있으면 새 인스턴스를 그 설정으로 만들어 처음부터 읽고 재스캔으로 본다. 그래서 삭제 재알림(`deletionsOnRescan`)과 revision이 커지는지를 검사한다 |
| `maxPages` | 선택. 한 번 읽는 데 가져갈 페이지 수의 상한. 넘으면 위반이 아니라 시나리오 오류로 던진다. 기본 10,000쪽이다 |
| `versionedSources` | 선택. 파일의 줄마다 한 버전인 수집기(JSONL 파일 수집기)만 켠다(9장) |

### 예시 수집기 — 이 저장소에서 지금 돌려 볼 수 있다

`packages/connector-example/`에 지어낸 메모 자료를 내는 작은 수집기가 있다. 의존하는 것은 `@pki/contracts`와 `@pki/testkit`(테스트에서만)뿐이고, 제품에는 들어가지 않는다. 지어낸 원 시스템은 메모마다 한 줄(지금 상태)을 갖고, 변경 순번 `seq`를 붙이며, 지운 메모를 삭제 표시로 남긴다. 그래서 재스캔이 삭제를 빠짐없이 다시 알릴 수 있다. 능력은 `incremental`, `deletes`, `fullRescan`, `deletionsOnRescan`이 참이고 `accessScope`는 거짓이다. 진입점은 `createExampleConnector` 하나다.

**선언.**

<!-- excerpt: packages/connector-example/src/adapters/example-connector.ts -->
```ts
    manifest: {
      type: "connector-example",
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: true,
      },
    },
```

**`getChanges`.** cursor는 `seq:<마지막으로 넘긴 순번>`이다. 모양이 다르거나 원 시스템의 마지막 순번보다 큰 cursor에는 `cursorExpired`로 답한다. `limit`이 1보다 작으면 실패한다(제자리 cursor를 돌려주지 않으려는 것이다).

<!-- excerpt: packages/connector-example/src/adapters/example-connector.ts -->
```ts
    async getChanges(cursor, { limit, signal }) {
      signal.throwIfAborted();
      const { entries } = loaded();
      if (!(limit >= 1)) throw new ConnectorError("limit is 1 or more", { retryable: false });
      const after = cursor === null ? 0 : Number(CURSOR.exec(cursor)?.[1] ?? NaN);
      // Not a cursor of this origin, or one from ahead of it (the origin was reset).
      if (!(after <= (entries.at(-1)?.seq ?? 0))) {
        return { changes: [], nextCursor: "seq:0", hasMore: false, cursorExpired: true };
      }
      const rest = entries.filter((e) => e.seq > after);
      const page = rest.slice(0, limit);
      return {
        changes: page.map((e) => e.change),
        nextCursor: `seq:${page.at(-1)?.seq ?? after}`,
        hasMore: page.length < rest.length,
      };
    },
```

**`getDocument`.**

<!-- excerpt: packages/connector-example/src/adapters/example-connector.ts -->
```ts
    async getDocument({ namespace, externalId }) {
      const { entries, ...own } = loaded();
      if (namespace !== own.namespace) return null;
      const change = entries.find((e) => idOf(e.change) === externalId)?.change;
      return change?.kind === "upsert" ? change.record : null;
    },
```

### 계약 테스트를 돌리는 법

예시 수집기의 테스트 한 줄이 계약 묶음을 부른다. 내 수집기 테스트도 같은 모양이다.

<!-- excerpt: packages/connector-example/src/adapters/connector-example.contract.test.ts -->
```ts
import { connectorContract } from "@pki/testkit";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createExampleConnector } from "./example-connector.ts";
import { EARLIER, LATER } from "./synthetic-notes.ts";

connectorContract("connector-example", createExampleConnector, { config: EARLIER, later: LATER });
```

위 코드의 앞쪽 `import` 몇 줄(`node:fs`, `node:path`, `vitest`)은 같은 파일의 다른 테스트가 쓰는 것이다. 계약 묶음만 돌리는 내 테스트에는 `@pki/testkit`과 내 수집기, 내 지어낸 자료의 `import` 셋과 마지막 한 줄이면 된다.

저장소 루트에서 아래 명령으로 돌린다(pnpm이 `package.json`에 고정한 Node 24로 실행한다).

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run packages/connector-example --reporter=verbose
```

통과하면 `Connector contract: connector-example > checkConnector finds no violation`이 ✓로 나오고, 같은 폴더의 위반 변형 테스트와 예시 자신의 테스트까지 두 파일이 모두 통과한다. 위반이 있으면 그 한 줄이 실패하고 어긋난 값에 위반 코드의 목록이 나온다. 예를 들어 진행 없는 cursor를 돌려주는 변형은 이렇게 나온다.

```text
AssertionError: expected [ 'no-progress' ] to deeply equal []
```

### 내 수집기에 같은 묶음을 붙이는 법

1. 예시 폴더의 모양을 따른다. 수집기 파일 하나와, 원 시스템을 흉내 내는 지어낸 `config` 둘(`config`, 바뀐 뒤의 `later`), 테스트 파일 하나다. 테스트 한 줄은 위의 `connectorContract(...)`다.
2. 패키지의 `package.json`은 `@pki/contracts`를 `dependencies`로, `@pki/testkit`을 `devDependencies`로 적는다(둘 다 `workspace:*`). 예시 패키지가 그렇게 되어 있고, 저장소의 모듈 경계 규칙이 `@pki/testkit`을 테스트 파일에서만 쓰게 한다.
3. **`site/connectors/<이름>/`에 두는 법.** 워크스페이스에는 `site/composition`과 `site/connectors/*`가 이미 들어 있어 포크는 `pnpm-workspace.yaml`을 고치지 않는다. 수집기 패키지를 그 폴더에 만들고 `pnpm install`을 한 번 실행하면 그 안의 테스트가 `@pki/testkit`을 찾는다. 그때 `site/` 밖에서 달라지는 것은 `pnpm install`이 다시 쓰는 `pnpm-lock.yaml`뿐이다. 이름과 경계 규칙, 제품에 연결하는 길(등록)은 7장에 있다.

### 일부러 어긴 변형 — 위반 코드가 나오는 것을 보여 주는 것

예시 패키지에는 규격을 한 곳만 어긴 변형이 셋 있다. 진행 없는 cursor를 돌려주면 `no-progress`, 능력에서 `deletes`를 거짓으로 선언하고 삭제 사건을 내면 `capability-deletes`, 초기화 전에 `getChanges`에 빈 페이지로 답하면 `responds-before-init`이다. 이 변형들은 모델로 삼으면 안 되고, 어떤 위반이 어떤 코드로 나오는지 보는 용도다. 변형 하나는 이렇게 생겼다.

<!-- excerpt: packages/connector-example/src/adapters/violating-connectors.ts -->
```ts
/** `no-progress`: it hands back the cursor it was given and says there is more. */
export function createStuckCursorConnector(): Connector {
  const example = createExampleConnector();
  return {
    ...example,
    async getChanges(cursor, opts) {
      const page = await example.getChanges(cursor, opts);
      return { ...page, nextCursor: cursor ?? "seq:0", hasMore: true };
    },
  };
}
```

그리고 그 결과를 이렇게 확인한다.

<!-- excerpt: packages/connector-example/src/adapters/connector-example.violations.test.ts -->
```ts
  it.each([
    ["no-progress", createStuckCursorConnector],
    ["capability-deletes", createUndeclaredDeletesConnector],
    ["responds-before-init", createEarlyAnswerConnector],
  ] as const)("checkConnector reports %s for its variant", async (code, create) => {
    expect(await checkConnector(create, { config: EARLIER, later: LATER })).toEqual([code]);
  });
```

### 위반 코드 표

`checkConnector`가 돌려주는 코드는 닫힌 목록 26개이고 `CONNECTOR_VIOLATION_CODES`가 같은 순서로 갖고 있다. 구조상 함께 일어나는 위반은 하나만 보고한다(예: `health-threw`가 나면 `unhealthy-after-init`은 보지 않고, 버전이 다르면 그 버전으로 다른 검사를 하지 않고 `sdk-version-mismatch`를 보고한다. manifest의 모양이 함께 틀렸으면 `manifest-invalid`도 같이 나올 수 있다).

| 코드 | 잡는 것 |
|---|---|
| `manifest-invalid` | manifest의 종류·능력이 빠지거나 틀림, `deletionsOnRescan`인데 `deletes`·`fullRescan`이 거짓 |
| `sdk-version-mismatch` | `schemaVersion`이 2가 아니거나 레코드의 `schemaVersion`과 다름 |
| `responds-before-init` | 초기화 전 `getChanges`·`getDocument`가 성공함 |
| `unhealthy-after-init` | 초기화 뒤 `healthCheck`가 `ok`가 아님 |
| `health-threw` | `healthCheck`가 예외를 던짐 |
| `limit-exceeded` | 한 페이지가 `limit`보다 많음 |
| `page-size-dependent` | 페이지 크기에 따라 받은 원본이 다름 |
| `duplicate-identity` | 한 번 읽는 동안 같은 정체가 두 번 upsert됨 |
| `no-progress` | `hasMore`인데 cursor가 그대로 |
| `changes-after-final-cursor` | `incremental`인데 마지막 cursor 뒤에 변경이 나옴 |
| `record-schema` | 레코드가 스키마에 맞지 않음(등급·인스턴스 필드 포함) |
| `invalid-blocks` | block 규칙 위반 |
| `capability-deletes` | `deletes`가 거짓인데 tombstone 사건을 냄 |
| `capability-access-scope` | `accessScope` 선언과 레코드·`scope-change`가 어긋남 |
| `revision-not-increasing` | "나중 상태"에서 바뀐 원본의 revision이 커지지 않음 |
| `tombstone-revision-below-upsert` | tombstone 사건의 revision이 그 정체로 낸 마지막 upsert의 revision보다 작음 |
| `rescan-deletion-missing` | `deletionsOnRescan`인데 "나중 상태"에서 사라진 원본이 재스캔에서 `delete`로 나오지 않음 |
| `rejected-position-invalid` | `rejected[].at`이 `종류:숫자` 모양이 아님 |
| `get-document-mismatch` | `getDocument`가 마지막으로 낸 레코드와 다름 |
| `get-document-unknown` | 모르는 정체에 `null`이 아님 |
| `abort-ignored` | 이미 취소된 신호로 부른 `getChanges`가 성공함 |
| `credential-in-record` | 시나리오의 자격 증명 값이 `getChanges`·`getDocument`가 돌려준 것 안에 있음(`credentials`가 있을 때, I06-R21) |
| `credential-in-health` | 시나리오의 값이 `healthCheck`의 답 안에 있음(`credentials`가 있을 때) |
| `credential-in-error` | 시나리오의 값이 수집기가 던진 오류의 문구·이름·열거되는 필드·`cause` 사슬 안에 있음(`credentials`나 `rejected`가 있을 때) |
| `credential-in-log` | `checkConnector` 한 번이 도는 동안 `console`과 표준 출력·오류로 나간 글 안에 시나리오의 값이 있음(`credentials`나 `rejected`가 있을 때) |
| `credential-rejection-unsignalled` | 거부 시나리오(`rejected`)로 새 객체를 초기화하고 한 번 읽었는데 `initialize`도 첫 `getChanges`도 `ConnectorCredentialError`로 끝나지 않음. `healthCheck`의 값은 이 코드를 면하지 않는다 |

아직 구현하지 않은 자리표시용(`ConnectorNotImplementedError`로 초기화가 실패하는 것)에 돌리면 위반 대신 `not-implemented` 하나만 돌려준다. 그 밖의 초기화 실패나 읽는 도중의 예외는 위반이 아니라 시나리오가 틀린 것으로 보고 던져진다. 이 검사는 `getChanges`를 `limit` 1000과 1로 두 번 읽어 비교한다. 제품이 쓰는 100은 아니다. 제품과 다르게 보이는 곳이 셋 있다. ① 페이지의 겉모양이 틀린 것은 계약 묶음에서는 `record-schema`이고 제품에서는 `invalid-page`로 멈춘다. ② 묶음의 `no-progress`는 같은 cursor를 되풀이하는 것뿐 아니라 **앞서 본 cursor로 되돌아가는 순환**도 잡는다. 제품은 받은 cursor와 같은 것만 잡는다. ③ 위반이 둘 이상이면 머리 줄의 `expected [ ... ] to deeply equal []`는 줄여 보일 수 있으니 그 아래의 차이(diff)에서 코드를 전부 읽는다.

이 검사가 증명하지 못하는 것이 있다. 지어낸 원 시스템으로 돌린 것이므로 **실제 원 시스템의 요청 한도, cursor 만료, 대량 페이지에서의 동작**은 확인하지 못한다. 그것은 배포처의 S18이 맡는다.

### 공용 저장소에 실제 클라이언트가 들어오지 못하게 하는 검사

이 저장소의 수집기 경로(`backend/src/adapters/`, `packages/connector-example/src/`, `packages/connector-sdk/src/`)는 import를 허용 목록으로 걸러 낸다(`checkPublicOnly`). 허용되는 것은 같은 검사 대상 안의 상대 경로, `@pki/contracts`, `@pki/connector-sdk`, `zod`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`다(테스트 파일에는 `@pki/testkit`과 `vitest`도 허용). 동적 `import()`, `require`, 전역 `fetch`·`XMLHttpRequest`·`WebSocket`은 쓰지 못한다. **이 제한은 공용 저장소만 대상이다.** `site/`는 검사 대상이 아니고(공용 저장소가 내보내는 자리 표시 파일 `site/README.md`만 따로 본다), 포크가 `site/connectors/`에 두는 수집기는 네트워크 클라이언트를 써도 이 검사에 걸리지 않는다.

### 이 장을 줄이면

- 내 수집기 테스트의 핵심은 `connectorContract(이름, 만드는 함수, { config, later })` 한 줄이다.
- 예시는 `pnpm exec vitest run packages/connector-example`로 지금 돌려 볼 수 있다.
- 위반 코드는 26개이고 위 표가 전부다. 코드는 위반의 종류만 알려 주고 문구는 없다.
- 이 검사는 지어낸 원 시스템으로 돌린 것이다. 실제 원 시스템에서의 확인은 S18이다.

## 7. 수집기를 포크에 두고 제품에 연결하는 법

**이 장은 포크가 `site/` 안에 파일을 더하기만 해서 수집기를 제품에 끼우는 방법이다.** 포크는 공용 저장소의 추적 파일을 고치지 않는다. 다만 `pnpm install`이 다시 쓰는 `pnpm-lock.yaml`은 달라지고, 설치 스크립트가 있는 의존성을 쓰면 `pnpm-workspace.yaml`의 `allowBuilds`에도 줄 하나가 더해진다(이 장의 "lockfile과 설치 스크립트"). 이렇게 정한 이유와 기각한 대안은 [ADR 0018](adr/0018-fork-registration-at-build-time.md)에 있다. 코드가 확인해 주는 것과 아직 없는 것을 나눠 쓴다.

### 결합은 빌드할 때 정해진다

- 포크의 코드는 **빌드할 때** 정적 `import`로 제품에 들어간다. 실행 중에 폴더를 훑어 수집기를 찾아 읽어 들이는 코드는 없다. 설치본은 자기 안에 묶인 코드만 실행한다.
- 포크는 `site/composition/`에 작은 패키지(`@pki-site/composition`)를 둔다. 그 안에 **등록 객체**(`SiteRegistration`) 하나와 **진입점 둘**이 있다. 진입점은 공용 백엔드의 함수(`runShell`, `runSiteCheck`)를 자기 등록으로 부른다. 공용 저장소의 진입점(`backend/src/shell.ts`, `backend/src/site-check.ts`)은 같은 함수를 빈 등록 `publicSite`로 부른다.
- 빌드와 소스 실행은 `site/composition/package.json`이 있으면 `site/composition/src/shell.ts`를 백엔드의 진입점으로 고르고, 없으면 `backend/src/shell.ts`를 고른다(`backendEntry`). `site/composition/package.json`은 있는데 `site/composition/src/shell.ts`가 없으면 그 경로를 적은 오류로 실패한다. **반대로 `site/composition/src/shell.ts`만 있고 `site/composition/package.json`이 없으면 오류 없이 공용 진입점을 묶는다.** 패키지를 먼저 만든다.
- 등록은 바탕 묶음(제품의 `productConnectors()`, 소스 실행의 `--fixtures`가 주는 묶음) **위에 합쳐진다.** 등록은 바탕을 바꾸거나 지우지 못하고, 종류와 인스턴스를 더하거나 자리표시 이름(`site-mail`, `site-messenger`, `site-wiki`)을 같은 이름으로 대체할 수 있을 뿐이다.
- 브라우저 개발용 백엔드(`backend/src/dev.ts`)에는 포크의 수집기를 싣는 진입점이 없다. 포크는 Electron 소스 실행(`pnpm --filter @pki/desktop start`)으로 수집기를 본다.

### 공용 저장소가 주는 것

- 제품은 수집기를 **종류 이름**으로 만든다. 공용 저장소의 종류 이름과 만드는 함수의 표가 `backend/src/composition.ts`의 `connectorKinds`이고, 여기에 `site-mail`, `site-messenger`, `site-wiki`가 **자리표시 구현**(`createSiteConnector`)으로 올라 있다. 부팅이 쓰는 바탕 묶음은 `productConnectors()`다. 자리표시는 초기화하면 `ConnectorNotImplementedError`(문구 `미구현, 배포처 후속`)로 실패한다. 포크는 같은 이름으로 실제 구현을 등록해 이것을 대체한다.
- 등록이 되었는지 보는 명령이 `site-check`다. 공용 저장소(조립 패키지가 없는 트리)에서 `pnpm --filter @pki/backend site-check <종류>`(`site-mail`, `site-messenger`, `site-wiki`)는 그 종류를 초기화해 보고, 자리표시는 이렇게 나오고 1로 끝난다.

```text
site-mail: 미구현, 배포처 후속
```

- 초기화가 던진 오류는 그 문구가 그대로 출력된다(위 줄의 `미구현, 배포처 후속`이 그 문구다). 초기화가 성공하면 `<종류>: ok`가 나오고 0으로 끝난다. 규격 버전이 다르면 `<종류>: unsupported-sdk-version`이 나오고 1로 끝난다.
- `site-check`는 **빈 설정(`{}`)으로** 초기화한다. 설정을 요구하는 수집기는 자기 설정 오류의 문구로 실패하고 1로 끝난다(예시 수집기가 그렇다: `connector-example: invalid config`). 그 결과는 종류가 만들어지고 규격 버전 판정을 통과해 `initialize`까지 갔다는 확인이고, 인스턴스의 실제 설정으로 초기화되는지는 아니다. 그것은 시작할 때 수집기 목록의 `ready`로 본다(site-setup S27).

### 포크가 더하는 파일

```text
site/
├── README.md                     공용 저장소가 갖는 유일한 파일
├── composition/                  조립 패키지 @pki-site/composition
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── registration.ts       registration: SiteRegistration
│       ├── registration.test.ts  checkSiteRegistration(registration)이 빈 목록
│       ├── shell.ts              await runShell(registration)
│       └── site-check.ts         await runSiteCheck(registration, 인자)
├── connectors/<이름>/            수집기 패키지 @pki-site/connector-<이름>
│   ├── package.json              exports "./adapters"
│   ├── tsconfig.json
│   └── src/adapters/             구현과 계약 테스트
└── config/                       설정 값
```

`pnpm-workspace.yaml`의 `packages:` 목록에는 `site/composition`과 `site/connectors/*`가 이미 있다. 공용 저장소에는 그 폴더가 없어도 `pnpm install --frozen-lockfile`이 통과한다. 그래서 포크는 그 파일을 고치지 않는다.

### 등록 객체: 예시 패키지의 발췌

`packages/site-example/`(`@pki/site-example`)은 포크가 `site/composition/`에 둘 것과 같은 모양의 예시다. 수집기로 6장의 `@pki/connector-example`을 등록한다. 제품에는 들어가지 않고, 다른 공용 패키지는 이것을 의존성, `tsconfig` 참조, `import`에 적지 않는다. 아래 코드 블록은 모두 그 파일의 발췌다.

<!-- excerpt: packages/site-example/src/registration.ts -->
```ts
import type { SiteRegistration } from "@pki/backend";
import { createExampleConnector } from "@pki/connector-example/adapters";
// The scopes file, imported statically so the build puts its value in the backend bundle (I07-R1). Here it sits in
// this package (config/), which the build allows for the example's entry only; a fork's file is
// site/config/connector-scopes.json and its import path is "../../config/connector-scopes.json" (I07-R7, R16).
// The `with { type: "json" }` is required: without it Node's source run fails.
import connectorScopes from "../config/connector-scopes.json" with { type: "json" };

/** The collector's kind name is its manifest's `type` (I05-R7). */
const KIND = "connector-example";

export const registration: SiteRegistration = {
  connectorScopes,
  connectorKinds: { [KIND]: createExampleConnector },
  connectorInstances: [
    {
      id: "example-notes",
      kind: KIND,
```

진입점 둘은 각각 몇 줄이다. 공용 저장소가 나중에 진입점을 늘리면 포크는 같은 모양의 파일을 하나 더한다(충돌이 아니라 추가다).

<!-- excerpt: packages/site-example/src/shell.ts -->
```ts
import { runShell } from "@pki/backend";
import { registration } from "./registration.ts";

await runShell(registration);
```

<!-- excerpt: packages/site-example/src/site-check.ts -->
```ts
import { runSiteCheck } from "@pki/backend";
import { registration } from "./registration.ts";

await runSiteCheck(registration, process.argv.slice(2));
```

<!-- excerpt: packages/site-example/src/registration.test.ts -->
```ts
import { checkSiteRegistration } from "@pki/backend";
import { describe, expect, it } from "vitest";
import { registration } from "./registration.ts";

describe("site.example-registration", () => {
  it("has no violation: the check returns an empty list", () => {
    expect(checkSiteRegistration(registration)).toEqual([]);
  });
```

`SiteRegistration`의 필드는 모두 선택이다.

| 필드 | 뜻 | 없을 때 |
|---|---|---|
| `connectorKinds` | 종류 이름 → 수집기를 **새로 만들어** 돌려주는 함수(`ConnectorFactory`) | 바탕 묶음의 종류만 |
| `connectorInstances` | 시작할 때의 인스턴스(`id`, `kind`, `config`) | 바탕 묶음의 인스턴스만 |
| `scopeGrading` | 접근 범위 → 데이터 등급 매핑(site-setup S08) | `publicScopeGrading` |
| `scopePolicy` | 접근 범위 정책(site-setup S21). 있으면 설치본은 언제나 이 정책을 쓴다 | 공용 기본 정책 |
| `connectorScopes` | 인스턴스마다의 접근 범위(site-setup S18) | 모든 인스턴스가 알 수 없음 |

**이름과 인스턴스의 규칙.**

- 종류 이름은 `^[a-z][a-z0-9-]{0,63}$`를 따른다(삭제 장부가 종류에 요구하는 규칙과 같다). 만드는 함수가 돌려준 수집기의 `manifest.type`은 종류 이름과 같아야 한다.
- **공용 종류는 등록할 수 없다**(`PUBLIC_CONNECTOR_KINDS`. 지금 `jsonl-import`와 `test-fixtures`). 공용 종류는 제품이 따로 지키는 약속(사용자의 경로 승인, 합성 등급)을 갖기 때문이다. 자리표시 이름은 같은 이름으로 등록해 대체한다. 대체하지 않은 자리표시는 그대로 남아 `미구현, 배포처 후속`을 알린다.
- 인스턴스는 **이 등록이 등록한 종류의 것만** 만들 수 있다. `id`는 1자 이상 128자 이하이고 등록 안에서 서로 달라야 하며 공용 인스턴스의 ID(`isPublicInstanceId`)와 겹치면 안 된다. 공용 종류나 대체하지 않은 자리표시 이름을 `kind`로 적은 인스턴스는 허용되지 않는다.

**등록 검사.** `checkSiteRegistration(registration)`은 위반을 코드의 목록으로 돌려준다(한 위반마다 한 코드. 만드는 함수와 매핑은 검사에서 부르지만 시작할 때는 부르지 않는다). 예시의 `registration.test.ts`처럼 포크도 자기 등록이 빈 목록을 돌려주는 테스트를 둔다. 코드와 시작할 때의 처리는 다음과 같다.

| 코드 | 잡는 것 | 시작할 때 |
|---|---|---|
| `kind-name-invalid` | 종류 이름의 모양 위반 | 그 종류를 빼고 계속한다 |
| `kind-reserved` | 공용 종류의 이름 | 그 종류를 빼고 계속한다(공용 것은 그대로) |
| `instance-id-invalid` | 인스턴스 `id`가 한도 밖 | 그 인스턴스를 빼고 계속한다 |
| `instance-id-duplicate` | 같은 `id`가 둘 이상 | 첫 것만 쓰고 계속한다 |
| `instance-kind-unknown` | 어디에도 없는 종류의 인스턴스 | 그 인스턴스만 `unavailable`로 두고 계속한다 |
| `instance-kind-reserved` | 공용 종류나 대체하지 않은 자리표시의 인스턴스 | **시작을 멈춘다** |
| `instance-id-reserved` | 공용 인스턴스의 ID | **시작을 멈춘다** |
| `kind-factory-threw` | 만드는 함수가 예외를 던짐 | 검사에서만(시작할 때는 인스턴스 단위로 다룬다) |
| `kind-manifest-mismatch` | `manifest.type`이 종류 이름과 다름 | 검사에서만 |
| `scope-grading-invalid` | 매핑이 허용된 등급 밖을 답함 | 검사에서만 |

`connectorScopes`에 대한 `connector-scopes-field-invalid`와 `connector-scopes-entry-invalid`도 검사에서만 나온다. 시작을 멈추는 두 위반은 공용이 지키는 약속을 넘으려는 시도이므로 조용히 넘기지 않는다. 그런 등록을 실은 설치본은 켜지지 않는다. 시작 실패는 고정된 사유 `site-registration-invalid`로 알리고, 표준 오류의 한 줄에 코드와 건수만 적는다(등록이 적은 글은 어디에도 싣지 않는다).

### 순서대로: 명령

1. 수집기를 등록하기 전에 그 수집기의 계약 묶음(`connectorContract`, 6장)을 통과시킨다. 이것은 **문서의 절차이고 빌드가 강제하지 않는다.** 계약 묶음에는 수집기마다 지어낸 원 시스템이 필요하고 그것은 수집기 자신의 테스트만 갖는다.
2. 아래 명령을 차례로 실행한다.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @pki-site/composition site-check <종류>
pnpm --filter @pki/desktop build
```

- `pnpm lint`는 ESLint와 `prettier --check`를 함께 돌려 `site/`의 파일도 본다. 손으로 쓴 파일의 서식이 틀리면 `pnpm exec prettier --write site`로 맞춘다. `pnpm typecheck`는 저장소의 프로젝트와 `site/composition`, `site/connectors/*`의 `tsconfig.json`을 함께 본다. `site/` 아래 패키지에 `tsconfig.json`이 없으면 그 패키지 이름을 적어 실패한다. `pnpm test`는 공용 테스트 파일을 하나도 고치지 않은 채 포크 모양에서도 통과해야 한다(`site/`의 존재로 갈리는 코드는 저장소 루트를 인자로 받는다). **`pnpm e2e`도 포크 모양에서 통과한다(I05-T06, macOS 예행 한 번).** 공용 시험 다섯(산출물 시험 둘과 `v02-flow` 셋)은 두 모양에서 참이 되도록 고쳐졌다. 다만 `v02-flow`는 포크 모양에서도 공용 이중을 띄우므로 포크의 등록이 아니라 공용 이중을 시험한다. 포크의 등록으로 띄운 앱은 산출물 시험이 본다.
- 포크의 `site-check <종류>`는 위와 같은 판정을 등록의 종류(자리표시를 대체한 것 포함)에 한다. 모르는 종류는 사용법을 적고 2로 끝난다. 등록이 시작을 멈추는 위반을 가졌으면 그 코드와 건수를 표준 오류에 적고 1로 끝난다. 예시 패키지에서 `pnpm --filter @pki/site-example site-check <종류>`로 같게 돌려 볼 수 있다.
- `pnpm --filter @pki/backend site-check <종류>`는 **공용 저장소의 명령**이다. 조립 패키지가 있는 저장소에서 실행하면 자리표시의 결과를 내지 않고, 그 패키지의 `package.json`의 `name`을 읽어 위의 포크 명령을 알린 뒤 2로 끝난다. 포크가 구현한 종류에 `미구현`이 나오는 오해를 막으려는 것이다.
- `pnpm --filter @pki/desktop build`는 포크의 진입점을 묶어 설치본을 만든다. Windows 11 설치본으로 만들어 실행하는 확인은 site-setup S27이다.

### 포크의 패키지를 만들 때

**조립 패키지의 `package.json`.** 이름은 `@pki-site/composition`이어야 한다(다른 이름이면 `pnpm test`의 이름 검사가 실패한다. 수집기 패키지는 `@pki-site/`로 시작하면 된다). 직접 가져오는 패키지는 모두 적는다(pnpm의 엄격한 `node_modules` 때문에 적지 않은 패키지는 실행 때 찾지 못하고, 경계 규칙도 적지 않은 `@pki/*`를 거부한다). 예시의 것을 이름만 바꾼 모양이다. 자기 수집기 패키지는 `dependencies`에 `workspace:*`로 더한다.

```json
{
  "name": "@pki-site/composition",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "site-check": "node src/site-check.ts"
  },
  "dependencies": {
    "@pki/backend": "workspace:*",
    "@pki/connector-example": "workspace:*"
  },
  "devDependencies": {
    "@pki/contracts": "workspace:*",
    "@pki/testkit": "workspace:*"
  }
}
```

**`tsconfig.json`은 예시를 그대로 복사할 수 없다.** 예시는 `packages/` 안에 있어 형제 패키지를 `../connector-example`처럼 가리키는데, `site/composition/`에서는 같은 패키지가 `../../packages/connector-example`이다. 그대로 두면 참조한 프로젝트를 찾지 못해 `pnpm typecheck`가 실패한다. 의존하는 워크스페이스 패키지는 모두 `references`에 있어야 하고(`tooling/workspace/tsconfig-references.test.ts`), 포크의 수집기 패키지는 `../connectors/<이름>`으로 가리킨다. 저장소 루트의 `tsconfig.base.json`을 확장하는 줄과 `../../backend` 참조는 폴더 깊이가 같아 그대로다. 예시의 `include`에 있는 `config/*.json`은 예시의 범위 파일이 패키지 안에 있어서 필요한 것이고, 포크의 범위 파일은 패키지 밖(`site/config/`)이라 아래 블록은 `["src"]`만 둔다.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "noEmit": false,
    "emitDeclarationOnly": true,
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [
    { "path": "../../backend" },
    { "path": "../../packages/connector-example" },
    { "path": "../../packages/contracts" },
    { "path": "../../packages/testkit" },
    { "path": "../connectors/<이름>" }
  ]
}
```

**수집기 패키지.** 구현은 자기 패키지의 `src/adapters/`에 두고 `exports`의 `"./adapters"` 진입점으로만 내보낸다. 그 진입점을 가져올 수 있는 파일은 `site/composition/src/registration.ts`(예시에서는 `packages/site-example/src/registration.ts`) **하나뿐**이다. 같은 패키지의 다른 파일이 가져오면 린트가 막는다.

**경계 규칙이 막는 것과 막지 않는 것.** `pnpm lint`의 경계 규칙(`tooling/eslint/module-boundary.js`)은 다음을 오류로 알린다.

- 포크 패키지가 `@pki/backend`를 패키지 이름이 아닌 길로 가져오는 것: `backend/src`를 상대 경로, 절대 경로, `file:` 주소로 가져오거나 `@pki/backend/<하위 경로>`로 가져오는 것. 시험 파일도 마찬가지다. 가져올 수 있는 것은 패키지 진입점이 내보내는 `runShell`, `runSiteCheck`, `checkSiteRegistration`, `publicSite`와 타입 `SiteRegistration`·`SiteRegistrationCode`·`ConnectorFactory`·`ConnectorInstanceConfig`뿐이다. `bootBackend`와 서버를 띄우는 `startServer`는 내보내지 않는다. 그 옵션들은 등록 검사를 건너뛰기 때문이다.
- 공용 패키지가 `@pki-site/*`를 가져오거나 의존성으로 적는 것(방향은 언제나 포크에서 공용으로다).
- `pnpm lint`는 저장소 루트의 `eslint.config.js` 하나만 쓴다(`eslint -c eslint.config.js`). 포크가 `site/` 아래에 둔 ESLint 설정 파일은 읽히지 않는다. 그렇지 않으면 그 파일이 루트의 규칙을 통째로 대신하고 `pnpm lint`는 여전히 0으로 끝난다.
- 파일 안의 주석으로 규칙을 끄거나 바꾸는 것. `site/`와 `packages/site-example/`의 파일에서는 인라인 설정(`// eslint-disable pki/module-boundary`, `/* eslint pki/module-boundary: … */`)이 효력이 없다.

**린트가 보지 않는 길이 다섯 있다.** `tsconfig`의 `paths` 별칭, 심볼릭 링크, `createRequire(...)`로 부르기, 계산된 이름의 `import()`, `package.json`의 `imports`(`#이름`)다. 모두 일부러 해야 닿는 길이고 린트는 막지 않는다. 포크의 코드 검토가 맡는다.

### 빌드와 산출물

`pnpm --filter @pki/desktop build`가 고른 진입점을 묶으면 다음이 성립한다.

- 묶음에는 등록과 그 수집기의 모듈이 들어가고, 테스트 파일과 `@pki/testkit`은 들어가지 않는다. 등록이 테스트 모듈에 닿으면 빌드가 실패한다.
- 설치본의 백엔드는 `--scope-policy`와 `--fixtures`를 받지 않는다(받으면 시작이 실패한다). 등록에 `scopePolicy`가 있으면 설치본은 언제나 그 정책을 쓰고, 설치본을 공용 기본 정책으로 돌리는 스위치는 없다. 이름으로 정책을 고르는 `PKI_SCOPE_POLICY`(`default`, `site`)는 소스 실행에서만 듣는다.
- **네이티브 모듈은 지원하지 않는다.** 수집기 패키지의 의존성이 네이티브 코드(패키지 폴더에 `binding.gyp`나 `prebuilds/` 폴더가 있거나 `.node` 파일이 든 것)이면 빌드가 그 패키지 이름을 적어 실패한다. 공용이 앱 폴더에 복사해 주는 `better-sqlite3`와 `@huggingface/transformers`는 이 검사에서 빠진다. 수집기 패키지가 그 이름을 자기 버전으로 선언해도 확인하는 검사는 없고, 실행 때는 공용이 복사한 것을 쓴다.
- **그 검사에는 빠져나가는 곳이 둘 있다.** 하나는 계산된 이름으로 네이티브 모듈을 불러오고 못 찾으면 순수 JS 코드로 내려가는 패키지다. 번들러가 그 모듈을 풀지 않으므로 검사에 걸리지 않고, 빌드는 조용히 지나가 내려갈 코드가 묶인다. 다른 하나는 검사가 **빌드하는 컴퓨터에 설치된 패키지만 본다**는 것이다. 운영체제마다 다른 선택 의존성(`optionalDependencies`)을 쓰는 패키지는 한 OS에서는 실패하고 다른 OS에서는 통과할 수 있다. 그래서 이 검사 통과는 Windows 설치본에서 동작한다는 증거가 아니다(site-setup S27).

### lockfile과 설치 스크립트

- 수집기 패키지를 더하거나 의존성을 바꾼 뒤에는 `pnpm install`을 실행하고 `pnpm-lock.yaml`의 변경을 commit한다. 그 변경은 포크 패키지의 `importers` 항목과 그 외부 의존성뿐이다. 손으로 고치지 않는다. 이 시험이 붙잡는다: `pnpm-lock.yaml`의 `site/` 항목은 디스크의 포크 패키지와 정확히 같다. 의존성이 하나도 없는 포크 패키지는 `importers`에 빈 항목(`site/connectors/x: {}`)을 남기는데 그 패키지를 지워도 `pnpm install`이 그 항목을 지우지 않는다. 그때는 항목을 손으로 지운다.
- 공용 변경을 받아 왔을 때 `site/` 밖에서 달라지는 추적 파일은 `pnpm-lock.yaml` 하나다(아래 설치 스크립트 경우는 예외). `git status --porcelain`에 그 밖의 파일이 보이면 `site/` 밖을 고친 것이다. `pnpm-lock.yaml`이 충돌하면 **공용 쪽의 내용을 취하고** `pnpm install`을 다시 실행한다. 포크의 항목이 다시 만들어진다.
- 수집기의 의존성은 npm 레지스트리에서 받는 것이어야 한다. git·tarball·로컬 주소는 `tooling/workspace/lockfile-registry.test.ts`가 거부하고, 그 시험은 포크에서도 돈다.
- **설치 스크립트가 있는 의존성**을 더하면 `pnpm install`이 `ERR_PNPM_IGNORED_BUILDS`로 실패하고, 그 실패한 실행이 `pnpm-workspace.yaml`의 `allowBuilds`에 `<패키지>: set this to true or false` 줄을 스스로 써 넣는다. 포크는 그 줄을 `false`로 고친다(스크립트를 돌리지 않는다는 뜻이고, 측정한 것은 이 값뿐이다). 그러면 `site/` 밖에서 달라지는 추적 파일이 `pnpm-lock.yaml`과 `pnpm-workspace.yaml`의 이 줄 둘이 된다(`packages:` 목록은 고치지 않는다). 스크립트가 정말 필요한 의존성(`true`)은 지원하지 않는다. [ownership.md 5절](ownership.md)의 방법으로 공용에 알린다.

### 시작할 때와 재점검

- 백엔드는 인스턴스들의 `initialize`를 함께 시작하고 각각 10초(`INITIALIZE_TIMEOUT_MS`)까지만 기다린 뒤에 서비스를 시작한다. 10초 안에 끝나지 않은 인스턴스는 준비되지 않은 것으로 두고, 그 뒤에 끝난 결과는 성공이든 실패든 버린다. 이 제한은 비동기로 기다리는 시간만 재므로 수집기가 동기 코드로 멈추면 막지 못한다.
- 만드는 함수가 던지거나 `initialize`가 던지거나 인스턴스가 등록에 없는 종류를 적어도(`connector-kind-unknown`) 시작은 계속되고 그 인스턴스만 준비되지 않은 상태(`unavailable`)가 된다. 그 인스턴스의 동기화는 `connector-unavailable`로 답하고 수집 작업은 보류된다. 로그에는 고정된 코드(`connector-initialize-timeout`, `connector-factory-failed`, `connector-initialize-failed`, `connector-kind-unknown`)와 인스턴스 `id`만 남고 수집기가 던진 글은 남지 않는다.
- 한 시간마다의 재점검은 만드는 함수를 다시 불러 **새 객체**를 만들어 초기화한다(5장). 제품은 한 객체의 `initialize`를 한 번만 부른다. 그러므로 `initialize`는 같은 설정의 다른 객체가 동시에 초기화 중일 수 있다는 것을 전제로 쓴다. 혼자만 잡는 잠금 파일이나 포트를 쓰지 않는다.
- 제품은 버린 객체를 닫지 못한다(규격에 닫기가 없다). 늦게 끝나 버려진 객체는 닫히지 않은 채 자원을 쥘 수 있다. 쌓이는 수에 끝을 두려고 60초를 넘겨 끝난 재점검이 연달아 3번이면 그 인스턴스의 재점검을 그만두고 앱을 다시 시작할 때까지 준비되지 않은 채로 둔다(`connector-recheck-abandoned`).

### 믿는 것과 막지 못하는 것

포크의 수집기는 건물에 들어와 일하는 **직원**이지 손님이 아니다. 출입증 검사(등록 검사)와 회의 시간 제한(시간 제한)은 직원의 실수를 잡지만 직원이 마음먹고 하는 일을 막지는 못한다. 다만 비유와 달리 이 직원이 가져오는 서류(수집한 내용, 오류의 글)는 여전히 믿지 않는다. 스키마로 검사하고 오류의 글은 로그와 화면에 싣지 않는다.

- 포크의 코드는 **빌드할 때 포크 소유자가 검토해 넣은, 믿는 코드**다. 백엔드와 같은 프로세스에서 같은 권한으로 돈다. 정본 DB, 비밀 값 통로, 네트워크, 파일에 닿고 **가둬지지 않는다.** 등록 검사와 시간 제한은 실수와 느린 초기화를 잡는 장치이지 격리가 아니다.
- 막지 못하는 것: 만드는 함수나 `initialize`의 **동기 멈춤**(10초 제한이 끊지 못해 앱이 시작하지 못한다), **포크 모듈을 읽는 도중의 예외**(`runShell`이 불리기 전에 진입점이 끝난다. 셸은 기존의 시작 실패로 알린다), 수집기가 프로세스를 끝내거나 메모리를 다 쓰는 일, 제한을 넘긴 초기화가 뒤에서 계속 도는 일, 악의적인 포크 코드나 그 의존성. 동기 멈춤은 포크의 코드 검토와 site-setup S27이, 포크 모듈을 읽는 도중의 예외는 포크의 `pnpm test`(조립 패키지의 부팅 테스트)와 S27이 맡는다.
- 데이터 폴더에 파일을 놓아 실행본이 그것을 코드로 읽게 할 길은 없다(실행 중 로더가 없다). 설치 폴더의 파일을 바꿀 수 있는 공격자는 실행본 자체를 바꿀 수 있으므로 이 장치의 범위 밖이다.

### 수집기 종류를 뺀 빌드로 백업을 복원하지 않는다

삭제 장부를 시작할 때 다시 적용하는 단계는 **그 빌드가 아는 종류**의 줄만 적용한다. 아는 종류는 등록이 더한 종류를 포함한다. 그런데 모르는 종류의 줄은 건너뛰면서도 적용 위치를 올린다. 그래서 어떤 종류를 뺀 빌드로 백업을 복원해 띄웠다가 나중에 그 종류를 다시 넣으면, 그 사이에 건너뛴 삭제는 다시 적용되지 않고 지운 자료가 다음 동기화에서 되돌아올 수 있다. 건너뛴 건수는 상태 화면과 장부 이력에 남으므로 조용하지는 않다. 고치는 일은 공용 저장소의 #121이 추적한다. 그때까지는 수집기 종류를 뺀 빌드로 백업을 복원하지 않는다.

### 아직 없는 것

번호(공용 저장소 #114 등)는 **공용(upstream) 저장소**의 추적 이슈다. 포크에서 `#114`는 포크 자신의 이슈를 가리키므로 공용 저장소의 이슈 목록에서 찾는다.

1. **수집기에 비밀 값을 건네는 통로가 없다**(공용 저장소 #114). 8장.
2. **설치본이 `site/config/connector-scopes.json`을 읽는 길이 없다**(공용 저장소 #115). site-setup S18.
3. **`jsonl-import` 파일 인스턴스를 설정하는 제품의 길이 없다**(공용 저장소 #116). 인스턴스의 설정은 시작할 때 등록의 `connectorInstances`가 주고, 설정 화면이나 설정 파일로 인스턴스를 만들 수 있는 곳이 없다. 제품이 등록한 종류는 `site-*` 셋뿐이다(`jsonl-import`는 시험에서만 등록된다). 9장.

이 항목들은 이 문서가 임의로 정하지 않았다. 포크가 다른 방법을 정했다면 그 방법을 공용 저장소에 알린다([ownership.md 5절](ownership.md)).

### 포크가 수집기를 만들 때 지킬 것

- 모든 포크 코드는 `site/` 안에 둔다. 공용 저장소의 수집기 경로에는 실제 클라이언트가 들어갈 수 없다(6장).
- 실제 수집기가 가져온 자료는 합성 자료가 될 수 없다. 제품은 합성 등급을 합성 목록과의 대조로만 붙인다.
- 공용 저장소에 이슈·테스트 데이터·로그를 올릴 때는 배포처의 주소, 계정, 업무 데이터를 넣지 않는다([ownership.md 6절](ownership.md)).

### 이 장을 줄이면

- 포크는 `site/composition/`에 등록 하나와 진입점 둘을 두고, 빌드가 그 진입점을 고른다. 결합은 빌드할 때의 정적 `import`다.
- 등록은 사이트 종류와 그 인스턴스만 더한다. 공용 종류에 손을 대는 등록은 시작하지 못하고, 그 밖의 잘못된 항목과 멈추는 수집기는 그 항목만 빠진다.
- 예시의 `tsconfig.json`은 그대로 복사할 수 없다. 네이티브 모듈 검사와 린트에는 빠져나가는 길이 있다.
- 포크의 코드는 믿는 코드로 실리고 가둬지지 않는다. 동기 멈춤은 막지 못한다.
- 명령은 `pnpm install`, `pnpm lint && pnpm typecheck && pnpm test`, `pnpm --filter @pki-site/composition site-check <종류>`, `pnpm --filter @pki/desktop build`다. `site/` 밖에서 달라지는 것은 `pnpm-lock.yaml`이고, 설치 스크립트가 있는 의존성이면 `allowBuilds`의 `false` 줄이 더해진다.
- 수집기 종류를 뺀 빌드로 백업을 복원하지 않는다(#121).

## 8. 자주 만나는 두 가지: 정수 revision이 없을 때, 자격 증명

### 원 시스템에 정수 revision이 없을 때

`revision`은 필수이고 1 이상의 안전한 정수다. 원 시스템에 그런 번호가 없으면 **수정 시각을 밀리초 정수로 바꿔** 쓴다. 예를 들어 `new Date("2026-01-05T09:00:00Z").getTime()`은 `1767603600000`이다. 이 값은 같은 원본을 고칠 때마다 커지므로 revision의 조건을 만족한다. 주의할 점이 둘 있다.

- 밀리초 안에 같은 원본이 두 번 고쳐지는 원 시스템이면 같은 revision에 다른 내용이 올 수 있고, 그러면 `revision-conflict`로 그 레코드가 거부된다(4장). 수정 시각의 해상도가 그보다 거칠면 더 심하다. 그런 시스템이면 원 시스템 안에서 더 세밀한 순번을 찾아야 한다.
- 문자열 번호만 있는 시스템은 지금 규격으로 표현할 수 없다. 규격 v3의 일이다.

### 자격 증명

원 시스템에 접근하는 비밀 값(API 키, 토큰, 암호)은 **OS 자격 증명 저장소에 두고, 레코드·설정 파일·로그에 넣지 않는다.** 이유는 레코드와 설정은 제품의 정본과 백업에 남고, 로그와 오류 문구는 그대로 사람이 보거나 옮겨 갈 수 있기 때문이다. 이 저장소의 지침은 [ADR 0010](adr/0010-encryption-at-rest.md)이다. 그 결정은 비밀 값을 Electron의 `safeStorage`로 암호화한 파일에 두고 키를 OS가 지키게 한다. 이 저장소가 지금 그 저장소에 두는 것은 Provider의 키이고, **수집기가 비밀 값을 받는 통로는 아직 없다.** 수집기가 받는 것은 `initialize(config)`의 설정 하나다. 그러므로 포크가 수집기의 자격 증명을 어떻게 읽을지(예: 수집기가 직접 OS 저장소를 부르는 방법)는 포크가 정해야 하고, 그 값을 레코드의 `metadata`나 설정 파일, 던지는 오류의 문구에 넣지 않는다는 것이 이 문서의 규칙이다. 오류의 문구는 동기화 결과·API·로그로는 옮겨지지 않지만 `site-check`는 `initialize` 오류의 문구를 출력하고, 수집기가 자기 로그에 남기는 것은 제품이 막을 수 없다.

### 이 장을 줄이면

- 정수 revision이 없으면 수정 시각의 밀리초를 쓴다. 같은 밀리초의 두 번 수정은 충돌이 된다.
- 자격 증명은 OS 자격 증명 저장소에만 둔다. 수집기에 비밀 값을 건네는 통로는 아직 없다.

## 9. JSONL 가져오기 — 수집기를 만들지 않고 파일로 넣는 길

수집기를 만들 수 없는 곳의 자료는 JSONL(한 줄에 JSON 하나) 파일로 만들어 넣을 수 있다. 줄 하나는 **한 원본의 한 버전**이다. 줄 형식은 `ImportRecordSchema`이고 골든 데이터와 같다. 줄의 필드를 규격의 필드로 옮기는 규칙은 다음과 같다.

| JSONL 줄 | 옮겨 가는 곳 |
|---|---|
| `connector_instance_id` | `namespace`(제품의 인스턴스 ID가 아니다) |
| `external_id` | `externalId` |
| `version` | `revision`(제품 version이 아니다) |
| `title`, `content` | `title`, `body` |
| `access_scope` | `accessScope`(가져온 범위) |
| `source_type`, `source_url`, `author`, `participants`, `thread_id`, `created_at`, `updated_at`, `metadata` | 같은 이름의 camelCase |
| `operation` | `Change.kind` |

`operation`은 `upsert`, `delete`, `revoke`, `access-revoked` 넷이다. **`revoke`와 `access-revoked`는 다르다.** `revoke`는 `scope-change`(내용은 그대로이고 범위만 좁아짐)가 되어 원본을 지우지 않고, `access-revoked`는 tombstone이 되어 원본의 내용을 지운다. 사용자가 더는 볼 수 없는 원본은 `access-revoked`로 적는다. 줄이 사라진 것은 삭제가 아니다. 원본을 지우려면 `delete` 줄을 적어야 하고, 줄만 지우면 그 원본은 남는다.

실제로 이렇게 생겼다(줄의 `content_hash`는 `content`의 sha256이어야 하며, 맞지 않으면 그 줄이 `content-hash-mismatch`로 거부된다).

<!-- jsonl-sample -->
```jsonl
{"id":"line-1","source_type":"wiki","external_id":"page-1","title":"Reading list","content":"Three made-up books about lighthouses.","author":"author-a","participants":["author-a"],"thread_id":"","source_url":"","created_at":"2026-01-05T09:00:00Z","updated_at":"2026-01-05T09:00:00Z","content_hash":"sha256:c0860c4c7bb6f5c1d53fed68140952871d71cd8a9d20eb00a5d04da8db1ee904","version":1,"access_scope":["group-a"],"metadata":{},"connector_instance_id":"example-import","operation":"upsert","schema_version":"1"}
{"id":"line-2","source_type":"wiki","external_id":"page-1","title":"Reading list","content":"","author":"author-a","participants":["author-a"],"thread_id":"","source_url":"","created_at":"2026-01-05T09:00:00Z","updated_at":"2026-01-06T10:00:00Z","content_hash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","version":2,"access_scope":["group-a"],"metadata":{},"connector_instance_id":"example-import","operation":"delete","schema_version":"1"}
```

두 줄은 같은 원본(`page-1`)의 version 1과 delete(version 2)다. 두 번째처럼 `delete` 줄의 `content`는 빈 문자열이어야 한다.

- **지금 제품에서 JSONL이 들어가는 길.** 로컬 가져오기 API `POST /api/imports`(요청 `{ instanceId, content }`)와, 화면의 가져오기가 쓰는 `POST /api/import/jsonl`이다. 파일을 읽는 수집기(종류 `jsonl-import`, 설정 `{ path }`)는 **코드와 계약 시험으로만 있고** 제품에서 인스턴스를 만들어 줄 길은 없다(제품이 등록한 종류는 `site-*` 셋뿐이다. 아래 열린 항목). 파일 수집기와 API는 같은 해석 함수(`parseJsonl`)와 같은 저장 함수를 쓰도록 만들어져 있어서, 한 줄은 어느 길로 들어가도 같은 뜻이다.
- **한도.** 본문(API)과 파일은 10 MiB(`MAX_JSONL_BYTES`)까지다(API는 JSON 이스케이프 때문에 같은 한도의 파일보다 적게 들어간다). 넘으면 API는 413 `payload-too-large`로 답하고 파일 수집기는 재시도할 수 없는 실패(`connector-failed`)가 된다. 줄 하나는 1 MiB 글자(`MAX_JSONL_LINE_CHARS`, UTF-16 단위로 센다)를 넘으면 해석하지 않고 `schema`로 거부된다. 줄의 중첩 깊이는 64(`MAX_JSONL_DEPTH`)를 넘으면 `JSON.parse`가 끝난 **뒤에** 세어 `schema`로 거부된다. 세 값은 잠정이다.
- **인스턴스 ID의 한도.** 줄의 `connector_instance_id`와 가져오기 API의 `instanceId`는 1자 이상 128자 이하(`MAX_INSTANCE_ID_LENGTH`, `@pki/contracts`)다. 한 줄이 넘으면 그 줄만 `schema`(가져오기 응답에서는 `invalid-record`)로 거부된다. 한도를 하나로 둔 까닭은, 삭제 장부가 적을 수 없는 ID의 원본이 생겨 지울 수 없게 되는 일을 막으려는 것이다(아래 "삭제 장부"). 거부 사유는 `invalid-json`, `schema`, `content-hash-mismatch`이고 위치는 `line:<줄 번호>`(1부터)다. 빈 `access_scope`는 범위를 싣는 줄(`upsert`, `revoke`)에서만 `schema`로 거부한다.
- **정체는 하나다.** 줄을 (인스턴스, namespace = 줄의 `connector_instance_id`, external id)로 푼다. 그리고 **가져오기는 `jsonl-import`가 아닌 인스턴스의 원본을 읽지도 쓰지도 지우지도 못한다.** 줄이 가리키는 인스턴스가 다른 종류의 것이면 줄은 가져온 쪽의 새 정체로 저장되고, 그 다른 수집기의 원본은 건드려지지 않는다.
- **범위는 사용자가 적은 값이다.** 가져온 원본은 청구한 범위라는 표시(`scope_claimed`)를 달고, 제품은 그 범위가 배포처가 정한 인스턴스 범위보다 느슨해지지 못하게 등급을 계산한다. 공용 저장소의 등급은 하나라서 결과가 바뀌지 않는다.
- **파일 수집기의 `deletionsOnRescan`은 거짓이다.** 파일에는 이전 상태가 없어 사라진 줄을 삭제로 알릴 수 없기 때문이다. 고친 파일을 다시 넣으면 파일의 sha256이 달라 cursor가 만료되어 전체 재스캔이 되고, 이때 `deletionsMayBeMissed`가 붙는다.

### 한 원본의 버전이 여럿인 파일과 `versionedSources`

파일 하나가 한 원본의 버전을 여럿 담을 수 있어(줄마다 한 버전) 한 번 읽는 동안 같은 정체가 두 번 upsert될 수 있다. 일반 수집기에서는 `duplicate-identity` 위반이다. 계약 묶음에서 이 예외를 켜는 시나리오 필드가 `versionedSources: true`다. **켠 시나리오에서만** revision이 **앞선 것보다 클 때** 같은 정체를 다시 upsert해도 되고, 같거나 낮은 revision의 되풀이는 켜도 위반이다. 이것은 파일의 줄마다 한 버전인 수집기를 위한 것이다. 원 시스템을 읽는 일반 수집기는 켜지 않는다. 켜 두면 한 번 읽는 동안 같은 원본을 여러 번 낸 실수를 잡을 수 없기 때문이다.

### 열린 항목: 파일 인스턴스의 설정과 경로의 제한(공용 저장소 #116)

제품에는 `jsonl-import` 파일 인스턴스를 만들 길이 없다. 그 길이 생길 때 `{ path }`를 누가 적는지가 정해져야 하고, 파일 수집기 코드는 그 경로를 **그대로 읽는다.** 경로를 허용 폴더 안으로 가두는 일, 심볼릭 링크를 따라가지 않는 일은 만들지 않았다. 이 문서는 이것이 지켜진다고 말하지 않는다.

### 이 장을 줄이면

- JSONL의 한 줄은 한 원본의 한 버전이다. `version`이 `revision`이 되고, `connector_instance_id`가 `namespace`가 된다.
- `revoke`는 범위 변경, `access-revoked`는 삭제다.
- 파일 수집기의 `versionedSources`는 줄마다 한 버전인 수집기만 켠다.
- 파일 경로 제한은 아직 없다.

## 10. v1 수집기를 v2로 옮기는 법

규격 v1(`schemaVersion` 1)의 수집기는 v2에서 초기화되지 않는다(`unsupported-sdk-version`). 호환 층은 두지 않았다. 옮기는 순서는 [ADR 0016](adr/0016-connector-sdk-v2.md)의 "결과"에 있고, 요약하면 다음과 같다.

1. `manifest.schemaVersion`을 `CONNECTOR_SDK_VERSION`(2)로 하고 `capabilities`에 `deletionsOnRescan`을 더한다.
2. 레코드마다 `namespace`(범위가 하나면 `""`), `revision`, `schemaVersion: 2`를 채운다. 원 시스템의 개정 번호가 정수가 아니면 수정 시각의 밀리초를 쓴다(8장).
3. `delete`·`access-revoked` 사건의 `version`을 `revision`으로 바꾸고 `namespace`를 붙인다. `at`은 UTC 오프셋이 붙은 ISO-8601이다. 범위만 바뀐 원본은 `scope-change`로 낸다.
4. `getDocument(externalId)`를 `getDocument({ namespace, externalId })`로 바꾼다.
5. 다시 시도해도 되는 실패는 `ConnectorError`(`retryable: true`), 요청 한도는 `ConnectorRateLimitError`로 던진다.
6. 계약 테스트를 다시 돌린다.

규격이 또 바뀌면 같은 PR에서 규격, 그 규격을 쓰는 모든 구현, 계약 테스트가 함께 바뀌고, 호환이 깨지면 ADR에 옮기는 법이 적힌다([ownership.md 7절](ownership.md)). 포크는 계약 테스트의 실패로 변경을 알게 된다.

### 이 장을 줄이면

- v1 수집기는 v2에서 켜지지 않는다. 위 여섯 단계로 옮긴다.
- 옮긴 뒤 계약 테스트를 다시 돌린다.

## 11. 아직 없는 것

| 항목 | 상태 |
|---|---|
| 실제 메일·메신저·Wiki 수집기 | 이 저장소에 없다. 자리표시(`site-mail`, `site-messenger`, `site-wiki`)와 지어낸 자료를 내는 예시뿐이다. 구현은 배포처 포크의 일이다 |
| 실제 원 시스템에서의 규격 확인 | 하지 않았다. 요청 한도, cursor 만료, 대량 페이지, 만료된 동안의 삭제, 범위와 revision 채우기는 S18이 배포처에서 확인한다 |
| 수집기 종류를 뺀 빌드로 복원한 백업에서 건너뛴 삭제를 그 종류가 돌아온 뒤 다시 적용하는 일 | 없다. 건너뛴 줄은 건수로만 남는다. 종류를 뺀 빌드로 백업을 복원하지 않는다(7장, #121) |
| 수집기에 비밀 값을 건네는 통로 | 없다(8장, #114) |
| 설치본이 `site/config/connector-scopes.json`을 읽는 길 | 만들지 않았다. 소스 트리에서 실행할 때만 그 파일을 읽는다(site-setup S18, #115) |
| `jsonl-import` 파일 인스턴스를 제품에서 설정하는 길과 `{ path }`의 경로 제한 | 없다. 수집기 코드는 있고 시험에서만 등록된다. 인스턴스는 시작할 때 등록의 `connectorInstances`가 준 설정으로만 생긴다(9장, #116) |
| 화면에서 locator 표시 | 없다. 근거를 읽는 정본 함수와 API 응답은 locator를 돌려주지만 화면은 그리지 않는다 |
| Windows에서의 확인 | 하지 않았다. 이 문서의 명령은 macOS 개발 환경에서 돌려 보았다 |
