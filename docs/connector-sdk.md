# Connector SDK 사용 안내 — 수집기를 이 저장소 밖에서 만드는 사람에게

- 날짜: 2026-11-22 / 규격 버전: `CONNECTOR_SDK_VERSION` = 2 / 관련: [I01 spec](specs/2026-11-21-I01-connector-sdk.md), [ADR 0016](adr/0016-connector-sdk-v2.md), [ownership.md](ownership.md), [site-setup.md](site-setup.md)(S18)

이 문서는 메일·메신저·Wiki 같은 **원 시스템**(자료가 원래 들어 있는 시스템)에서 자료를 가져오는 수집기(Connector)를 새로 만드는 사람을 위한 안내다. 배포처 포크가 실제 수집기를 만들 때와 제3자가 자기 수집기를 만들 때 모두 같다. 이 저장소의 설계 문서를 읽지 않았다고 가정하고 쓴다.

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
  initialize(config: unknown): Promise<void>;
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
| `accessScope` | 아니오 | 누가 볼 수 있는지를 원 시스템의 말로 적은 문자열 목록. 비어 있지 않은 배열이고 원소도 빈 문자열이 아니다. 없으면 "알 수 없음"이고 가장 엄격하게 다뤄진다 |
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
| 2 | revision이 last와 같다 | 내용이 같고 범위도 같으면 `unchanged`, 범위만 다르면 `scope-updated`, 내용이 다르면 `revision-conflict`로 그 레코드를 거부한다 |
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

### 접근 범위의 변경

`scope-change`와 2차례의 `scope-updated`는 같은 처리를 받는다. 제품이 원본의 접근 범위를 바꾸고, 새 버전은 만들지 않으며, 그 범위에 기대던 파생물을 다시 판정한다. 막히면 `blocked`, last보다 작으면 `stale`이다. 같은 revision에서도 받아들인다. 살아 있는 버전이 없는 원본에 대해서는 `stale`이다.

### 부분 실패

- **레코드 하나만 거부**: 스키마 위반, `revision-conflict`, `invalid-blocks`, `capability-violation`, `scope-change-content-mismatch`. 나머지 레코드는 저장되고 cursor도 그 페이지 뒤로 확정된다. 거부 목록에는 위치와 사유 코드만 들어가고 필드의 값은 들어가지 않는다.
- **페이지 전체 실패**: `changes`·`nextCursor`·`hasMore`의 겉모양이 스키마에 맞지 않을 때, `limit`보다 많이 돌려줬을 때, 저장 트랜잭션이 실패했을 때. 그 페이지의 어느 것도 저장되지 않고 cursor는 그대로다. 같은 것을 다시 하면 같은 결과가 된다.

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

**이 두 오류가 아닌 예외를 던지면** 제품은 다시 해도 되는지 알 수 없다고 보고 `connector-failed`로 멈춘다(다시 시도하지 않는다). 그러니 원 시스템의 일시 장애는 반드시 `ConnectorError`(`retryable: true`)나 `ConnectorRateLimitError`로 감싸서 던진다. 한편 **오류의 문구는 API 응답, 동기화 결과, 로그 어디에도 옮겨지지 않는다.** 문구에 원 시스템의 내용이 섞일 수 있어서 제품은 사유 코드만 남긴다. 그러므로 진단용 글을 문구에 넣어도 제품에서는 볼 수 없다.

### 재시도의 값

같은 cursor로 한 페이지를 다시 받는 일은 동기화 한 번 안에서 아래 값으로 한다. 값은 아직 재 보지 않은 잠정 값이고 `SYNC_BACKOFF` 한 곳에 있다.

- 요청 한도(`ConnectorRateLimitError`): `min(retryAfterMs, 30초)`를 기다린다.
- 재시도 가능한 `ConnectorError`: 1초부터 두 배씩 기다리되 30초를 넘지 않는다.
- 한 페이지의 시도는 모두 3회까지다. 요청 한도로 소진되면 `rate-limited`, 재시도 가능한 오류로 소진되면 `connector-error`, 재시도할 수 없는 오류는 첫 번째에 `connector-failed`로 멈춘다.
- 어느 경우든 cursor는 마지막으로 확정된 값에 남는다.

### cursor가 만료되었을 때

원 시스템이 옛 cursor를 더는 받아 주지 않으면 `{ changes: [], nextCursor: ..., hasMore: false, cursorExpired: true }`를 돌려준다(예시 수집기가 이렇게 한다). 그러면 제품은 cursor를 버리고 **처음부터 다시 읽는다**(전체 재스캔). 규칙은 다음과 같다.

- 동기화 한 번에 전체 재스캔은 한 번뿐이다. 재스캔 중에 또 만료되면 `cursor-expired`로 멈춘다.
- `fullRescan`이 거짓인 수집기가 만료를 알리면 재스캔하지 않고 `cursor-expired`로 멈춘다.
- 다시 받은 원본은 4장의 판정으로 걸러져 늘지 않는다.
- `deletionsOnRescan`이 거짓이면 그 재스캔의 결과에 `deletionsMayBeMissed: true`가 붙는다. 이 표시는 재스캔을 끝내는 페이지가 저장될 때 내려가고, 앱을 다시 켜도 남아 있다.

### 동기화의 결과와 멈춤 코드

결과(`SyncResponse`)는 받은 변경 수(`received`)와 그 갈래(`created`, `unchanged`, `scopeUpdated`, `stale`, `staleTombstone`, `blocked`, `tombstoned`), 거부 목록(위치와 코드, 앞의 100건 `REJECTED_LIST_LIMIT`)과 전체 수(`rejectedCount`), `rescanned`, `deletionsMayBeMissed`를 담는다. 멈췄다면 사유 코드 `stopped`가 붙고, `rate-limited`이면 수집기가 마지막으로 알린 `retryAfterMs`도 붙는다. 코드는 닫힌 목록이다.

- 거부 코드(`REJECT_CODES`): `invalid-json`, `schema`, `content-hash-mismatch`, `revision-conflict`, `invalid-blocks`, `capability-violation`, `scope-change-content-mismatch`.
- 멈춤 코드(`SYNC_STOP_CODES`): `invalid-page`, `no-progress`, `cursor-expired`, `rate-limited`, `connector-error`, `connector-failed`, `aborted`, `instance-busy`, `storage-failed`.

`no-progress`는 `hasMore`가 참인데 `nextCursor`가 받은 cursor와 같을 때 멈춘다. 제품이 잡는 것은 그 경우뿐이다. cursor를 돌려 가며 끝없이 `hasMore`를 보내는 수집기는 제품이 알아채지 못하고 취소될 때까지 돈다. 알고 있는 한계다.

### 정해진 동기화가 일정에서 어떻게 다뤄지는가

주기적으로 끌어오는 동기화는 제품의 작업 대기열(`connector-sync` 작업)에서 돈다. **끌어올 설정이 있는 인스턴스**(준비 상태이고, 파일 수집기라면 `{ path }` 설정이 있는 것)에는 한 시간 주기가 기본으로 만들어진다(`SYNC_PERIOD`). 사용자가 바꾸거나 끈 주기는 그대로 둔다. 동기화가 어떻게 끝났는지에 따라 작업이 아래처럼 처리된다. 이 표는 코드 상수 `SYNC_OUTCOMES`와 같은 것이고, 이 문서의 표가 상수와 어긋나면 테스트가 실패한다.

| 동기화의 끝 | 작업 결과 | 시도 | 다음 실행 | 이유 |
|---|---|---|---|---|
| 멈추지 않고 끝남(거부·`stale-tombstone`·`deletionsMayBeMissed`가 있어도) | `done` | — | 다음 주기 | 레코드 단위의 일은 결과에 남았고, 다시 돌려도 같다 |
| `rate-limited` | `retry` | 씀 | 작업 대기열의 대기 시간과 결과의 `retryAfterMs` 가운데 늦은 쪽 | 시간이 지나면 풀린다 |
| `connector-error` | `retry` | 씀 | 작업 대기열의 대기 시간 | 수집기가 재시도해도 된다고 했다 |
| `instance-busy` | `retry` | 쓰지 않음 | 1분 뒤 | 같은 인스턴스의 가져오기가 끝나면 풀린다. 수집기를 부르지 않았다 |
| `aborted` | `retry` | 씀 | 작업 대기열의 대기 시간 | 임대 상실이나 실행 시간 초과는 실행기의 사정이다 |
| `connector-failed` | `dead_letter` | — | 없음 | 수집기가 재시도할 수 없다고 했다 |
| `invalid-page` | `dead_letter` | — | 없음 | 수집기의 규격 위반이다. 다시 돌려도 같다 |
| `no-progress` | `dead_letter` | — | 없음 | 수집기의 규격 위반이다. 다시 돌려도 같다 |
| `cursor-expired` | `dead_letter` | — | 없음 | 재스캔도 만료되었거나 재스캔할 수 없는 수집기다 |
| `storage-failed` | `retry`, 시도가 다하면 `dead_letter` | 씀 | 작업 대기열의 대기 시간 | 디스크 사정이면 다시 하면 풀린다. 늘 같은 실패면 시도가 다해 포기한 작업으로 남는다 |
| 인스턴스가 `unavailable`(초기화 실패, `unsupported-sdk-version`) | `held` | 쓰지 않음 | 인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 한 시간마다의 재점검 | 설정이나 수집기가 바뀌어야 풀린다 |
| 인스턴스가 `not-implemented`(`site-*`) | `held` | 쓰지 않음 | 인스턴스의 설정이 바뀌거나 앱이 갱신될 때, 그리고 한 시간마다의 재점검 | 포크가 실제 구현을 등록해야 풀린다 |

수집기를 만드는 사람이 이 표에서 챙길 것은 셋이다.

1. 포기(`dead_letter`)가 되는 `connector-failed`·`invalid-page`·`no-progress`·`cursor-expired`는 **자동으로 다시 시도되지 않는다.** 일시 장애를 `ConnectorError`로 감싸지 않으면 영구 실패로 처리된다.
2. 인스턴스가 준비되지 않으면(`unavailable`, `not-implemented`) 작업은 시도를 쓰지 않고 보류된다. 제품은 한 시간마다 준비되지 않은 인스턴스를 **같은 수집기 객체로 다시 초기화하고 `healthCheck`가 `ok`인지 본다**(`recheck`). 둘 다 되면 준비된 것으로 바꾸고 보류를 푼다. 그러므로 `initialize`는 같은 객체에 다시 불려도 안전해야 하고(규격이 따로 정한 약속은 아니지만 제품이 그렇게 부른다), `healthCheck`는 원 시스템이 돌아오면 `ok`를 돌려줘야 한다.
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
3. **`site/connectors/`에 두려면 워크스페이스에 그 폴더를 알려야 한다.** `pnpm-workspace.yaml`의 `packages` 목록에는 `site/connectors/*`가 없다. 이 항목을 더하고 `pnpm install`을 한 번 실행하면 `site/connectors/<이름>/` 안의 테스트가 `@pki/testkit`을 찾는다. 이 문서를 쓰면서 예시 수집기를 그 자리에 복사해 이 방법으로 돌려 보았고 계약 묶음이 통과했다. 이 한 줄은 `site/` 밖의 파일을 고치는 일이라 [ownership.md 3절](ownership.md)의 원칙과 부딪힌다(7장).

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

`checkConnector`가 돌려주는 코드는 닫힌 목록 21개이고 `CONNECTOR_VIOLATION_CODES`가 같은 순서로 갖고 있다. 구조상 함께 일어나는 위반은 하나만 보고한다(예: `health-threw`가 나면 `unhealthy-after-init`은 보지 않고, 버전이 다르면 `sdk-version-mismatch`만 보고한다).

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

아직 구현하지 않은 자리표시용(`ConnectorNotImplementedError`로 초기화가 실패하는 것)에 돌리면 위반 대신 `not-implemented` 하나만 돌려준다. 그 밖의 초기화 실패나 읽는 도중의 예외는 위반이 아니라 시나리오가 틀린 것으로 보고 던져진다. 이 검사는 `getChanges`를 `limit` 1000과 1로 두 번 읽어 비교한다. 제품이 쓰는 100은 아니다.

이 검사가 증명하지 못하는 것이 있다. 지어낸 원 시스템으로 돌린 것이므로 **실제 원 시스템의 요청 한도, cursor 만료, 대량 페이지에서의 동작**은 확인하지 못한다. 그것은 배포처의 S18이 맡는다.

### 공용 저장소에 실제 클라이언트가 들어오지 못하게 하는 검사

이 저장소의 수집기 경로(`backend/src/adapters/`, `packages/connector-example/src/`, `packages/connector-sdk/src/`)는 import를 허용 목록으로 걸러 낸다(`checkPublicOnly`). 허용되는 것은 같은 검사 대상 안의 상대 경로, `@pki/contracts`, `@pki/connector-sdk`, `zod`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`다(테스트 파일에는 `@pki/testkit`과 `vitest`도 허용). 동적 `import()`, `require`, 전역 `fetch`·`XMLHttpRequest`·`WebSocket`은 쓰지 못한다. **이 제한은 공용 저장소만 대상이다.** `site/`는 검사 대상이 아니고(공용 저장소가 내보내는 자리 표시 파일 `site/README.md`만 따로 본다), 포크가 `site/connectors/`에 두는 수집기는 네트워크 클라이언트를 써도 이 검사에 걸리지 않는다.

### 이 장을 줄이면

- 내 수집기 테스트의 핵심은 `connectorContract(이름, 만드는 함수, { config, later })` 한 줄이다.
- 예시는 `pnpm exec vitest run packages/connector-example`로 지금 돌려 볼 수 있다.
- 위반 코드는 21개이고 위 표가 전부다. 코드는 위반의 종류만 알려 주고 문구는 없다.
- 이 검사는 지어낸 원 시스템으로 돌린 것이다. 실제 원 시스템에서의 확인은 S18이다.

## 7. 수집기를 포크에 두고 제품에 연결하는 법

**이 장은 지금 `main`이 갖고 있지 않은 부분을 가장 많이 담는다.** 코드가 확인해 주는 것과 아직 없는 것을 나눠 쓴다.

**있는 것.**

- 제품은 수집기를 **종류 이름**으로 만든다. 종류 이름과 만드는 함수의 표가 `backend/src/composition.ts`의 `connectorKinds`이고, 여기에 `site-mail`, `site-messenger`, `site-wiki`가 자리표시 구현으로 올라 있다. 인스턴스(종류, ID, 설정)의 목록은 `connectorInstances()`가 만든다. 부팅이 쓰는 묶음은 `productConnectors()`다.
- 자리표시 구현은 `createSiteConnector`이고 초기화하면 `ConnectorNotImplementedError`(문구 `미구현, 배포처 후속`)로 실패한다. 포크는 같은 이름으로 실제 구현을 등록해 이것을 대체한다.
- 등록이 되었는지 보는 명령이 있다. `pnpm --filter @pki/backend site-check <종류>`(`site-mail`, `site-messenger`, `site-wiki`)는 그 종류를 초기화해 보고, 지금은 이렇게 나오고 1로 끝난다.

```text
site-mail: 미구현, 배포처 후속
```

- 초기화가 성공하면 `<종류>: ok`가 나오고 0으로 끝난다. 규격 버전이 다르면 `<종류>: unsupported-sdk-version`이 나오고 1로 끝난다.

**없는 것(열린 항목).**

1. **`site/connectors/`를 읽어 들이는 코드가 없다.** 제품은 `site/` 폴더에서 수집기를 찾아 올리지 않는다. 지금 방법은 `connectorKinds`(와 `connectorInstances()`)가 포크의 수집기를 가리키도록 `backend/src/composition.ts`를 고치는 것인데, 이것은 `site/` 밖의 파일을 고치는 일이다. [ownership.md 3절](ownership.md)은 `site/` 밖을 고쳐야만 하는 일이 생기면 규격에 빈 곳이 있다는 신호라고 적었고, 이 빈 곳을 메우는 장치는 아직 없다.
2. **`site/connectors/*`가 워크스페이스에 없다.** 6장의 3번 항목이다.
3. **인스턴스의 설정을 쓰는 곳이 없다.** 인스턴스의 설정은 부팅 때 주어진다. 설정 화면으로 인스턴스를 만드는 길은 없다.

이 세 가지는 이 문서가 임의로 정하지 않았다. 포크가 방법을 정했다면 그 방법을 공용 저장소에 알린다([ownership.md 5절](ownership.md)).

### 포크가 수집기를 만들 때 지킬 것

- 모든 포크 코드는 `site/` 안에 둔다. 공용 저장소의 수집기 경로에는 실제 클라이언트가 들어갈 수 없다(6장).
- 실제 수집기가 가져온 자료는 합성 자료가 될 수 없다. 제품은 합성 등급을 합성 목록과의 대조로만 붙인다.
- 공용 저장소에 이슈·테스트 데이터·로그를 올릴 때는 배포처의 주소, 계정, 업무 데이터를 넣지 않는다([ownership.md 6절](ownership.md)).

### 이 장을 줄이면

- 종류와 만드는 함수의 표는 `connectorKinds`이고, 확인 명령은 `site-check`다.
- `site/connectors/`를 읽는 코드와 워크스페이스 항목은 아직 없다. 지금은 `site/` 밖의 파일을 고쳐야 연결된다.

## 8. 자주 만나는 두 가지: 정수 revision이 없을 때, 자격 증명

### 원 시스템에 정수 revision이 없을 때

`revision`은 필수이고 1 이상의 안전한 정수다. 원 시스템에 그런 번호가 없으면 **수정 시각을 밀리초 정수로 바꿔** 쓴다. 예를 들어 `new Date("2026-01-05T09:00:00Z").getTime()`은 `1767603600000`이다. 이 값은 같은 원본을 고칠 때마다 커지므로 revision의 조건을 만족한다. 주의할 점이 둘 있다.

- 밀리초 안에 같은 원본이 두 번 고쳐지는 원 시스템이면 같은 revision에 다른 내용이 올 수 있고, 그러면 `revision-conflict`로 그 레코드가 거부된다(4장). 수정 시각의 해상도가 그보다 거칠면 더 심하다. 그런 시스템이면 원 시스템 안에서 더 세밀한 순번을 찾아야 한다.
- 문자열 번호만 있는 시스템은 지금 규격으로 표현할 수 없다. 규격 v3의 일이다.

### 자격 증명

원 시스템에 접근하는 비밀 값(API 키, 토큰, 암호)은 **OS 자격 증명 저장소에 두고, 레코드·설정 파일·로그에 넣지 않는다.** 이유는 레코드와 설정은 제품의 정본과 백업에 남고, 로그와 오류 문구는 그대로 사람이 보거나 옮겨 갈 수 있기 때문이다. 이 저장소의 지침은 [ADR 0010](adr/0010-encryption-at-rest.md)이다. 그 결정은 비밀 값을 Electron의 `safeStorage`로 암호화한 파일에 두고 키를 OS가 지키게 한다. 이 저장소가 지금 그 저장소에 두는 것은 Provider의 키이고, **수집기가 비밀 값을 받는 통로는 아직 없다.** 수집기가 받는 것은 `initialize(config)`의 설정 하나다. 그러므로 포크가 수집기의 자격 증명을 어떻게 읽을지(예: 수집기가 직접 OS 저장소를 부르는 방법)는 포크가 정해야 하고, 그 값을 레코드의 `metadata`나 설정 파일, 던지는 오류의 문구에 넣지 않는다는 것이 이 문서의 규칙이다. 오류의 문구는 제품이 옮기지 않지만, 수집기가 자기 로그에 남기는 것은 제품이 막을 수 없다.

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

- **들어가는 길 둘.** 파일 수집기(종류 `jsonl-import`, 설정 `{ path }`)와 로컬 가져오기 API `POST /api/imports`(요청 `{ instanceId, content }`)가 같은 해석 함수(`parseJsonl`)와 같은 저장 함수를 쓴다. 그래서 한 줄은 어느 길로 들어가도 같은 뜻이다.
- **한도.** 본문(API)과 파일은 10 MiB(`MAX_JSONL_BYTES`)까지다. 넘으면 API는 413 `payload-too-large`로 답하고 파일 수집기는 재시도할 수 없는 실패(`connector-failed`)가 된다. 줄 하나는 1 MiB 글자(`MAX_JSONL_LINE_CHARS`)를 넘으면 해석하지 않고 `schema`로 거부된다. 줄의 중첩 깊이는 64(`MAX_JSONL_DEPTH`)를 넘으면 `JSON.parse`가 끝난 **뒤에** 세어 `schema`로 거부된다. 세 값은 잠정이다.
- **줄 하나의 거부는 그 줄만 거부한다.** 거부 사유는 `invalid-json`, `schema`, `content-hash-mismatch`이고 위치는 `line:<줄 번호>`(1부터)다. 빈 `access_scope`는 범위를 싣는 줄(`upsert`, `revoke`)에서만 `schema`로 거부한다.
- **정체는 하나다.** 줄을 (인스턴스, namespace = 줄의 `connector_instance_id`, external id)로 푼다. 그리고 **가져오기는 `jsonl-import`가 아닌 인스턴스의 원본을 읽지도 쓰지도 지우지도 못한다.** 줄이 가리키는 인스턴스가 다른 종류의 것이면 줄은 가져온 쪽의 새 정체로 저장되고, 그 다른 수집기의 원본은 건드려지지 않는다.
- **범위는 사용자가 적은 값이다.** 가져온 원본은 청구한 범위라는 표시(`scope_claimed`)를 달고, 제품은 그 범위가 배포처가 정한 인스턴스 범위보다 느슨해지지 못하게 등급을 계산한다. 공용 저장소의 등급은 하나라서 결과가 바뀌지 않는다.
- **파일 수집기의 `deletionsOnRescan`은 거짓이다.** 파일에는 이전 상태가 없어 사라진 줄을 삭제로 알릴 수 없기 때문이다. 고친 파일을 다시 넣으면 파일의 sha256이 달라 cursor가 만료되어 전체 재스캔이 되고, 이때 `deletionsMayBeMissed`가 붙는다.

### 한 원본의 버전이 여럿인 파일과 `versionedSources`

파일 하나가 한 원본의 버전을 여럿 담을 수 있어(줄마다 한 버전) 한 번 읽는 동안 같은 정체가 두 번 upsert될 수 있다. 일반 수집기에서는 `duplicate-identity` 위반이다. 계약 묶음에서 이 예외를 켜는 시나리오 필드가 `versionedSources: true`다. **켠 시나리오에서만** revision이 **앞선 것보다 클 때** 같은 정체를 다시 upsert해도 되고, 같거나 낮은 revision의 되풀이는 켜도 위반이다. 이것은 파일의 줄마다 한 버전인 수집기를 위한 것이다. 원 시스템을 읽는 일반 수집기는 켜지 않는다. 켜 두면 한 번 읽는 동안 같은 원본을 여러 번 낸 실수를 잡을 수 없기 때문이다.

### 열린 항목: 파일 경로의 제한

파일 수집기의 `{ path }`는 지금 부팅·`site/` 설정에서만 오며, 제품은 그 경로를 **그대로 읽는다.** 경로를 허용 폴더 안으로 가두는 일, 심볼릭 링크를 따라가지 않는 일은 만들지 않았다. 설정이 인스턴스를 만들 수 있게 되는 때(사용자가 경로를 적는 화면이 생기는 때) 정해야 한다. 이 문서는 이것이 지켜진다고 말하지 않는다.

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
| `site/connectors/`를 읽어 들이는 코드와 워크스페이스 항목 | 없다(7장) |
| 수집기에 비밀 값을 건네는 통로 | 없다(8장) |
| 설치본이 `site/config/connector-scopes.json`을 읽는 길 | 만들지 않았다. 소스 트리에서 실행할 때만 그 파일을 읽는다(site-setup S18) |
| 파일 수집기 `{ path }`의 경로 제한 | 없다(9장) |
| 수집기가 설정 화면에서 만들어지는 길 | 없다. 인스턴스는 부팅 때 주어진 설정으로만 생긴다 |
| 화면에서 locator 표시 | 없다. 근거를 읽는 정본 함수와 API 응답은 locator를 돌려주지만 화면은 그리지 않는다 |
| Windows에서의 확인 | 하지 않았다. 이 문서의 명령은 macOS 개발 환경에서 돌려 보았다 |
