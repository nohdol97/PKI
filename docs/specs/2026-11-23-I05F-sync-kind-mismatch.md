# 스펙: I05 후속 — 저장된 종류와 어긋난 인스턴스의 동기화

- 날짜: 2026-11-23 / 상태: 확정(잠정 결정 포함)
- 관련: 이슈 #128(이 spec), 선행 I05-T02(PR #125)의 독립 검토 N1. [I05 spec](2026-11-22-I05-site-connector-registration.md)의 I05-R11·R12·R13과 I05-C10 ②를 잇는다. 그 spec은 고치지 않고 이 문서가 인용한다. [I01 spec](2026-11-21-I01-connector-sdk.md)(I01-R20 동기화 결과 표), [I03 spec](2026-11-21-I03-persistent-queue.md)(I03-R16 보류와 풀림, I03-R20 주기의 멈춤), [I06 spec](2026-11-22-I06-connector-credentials.md)(I06-R12 변경 알림), [connector-sdk.md](../connector-sdk.md) 5장

낯선 말은 [ARCHITECTURE 0절](../ARCHITECTURE.md#0-처음-나오는-말)에 풀이가 있다. `I05F-…`가 이 spec의 번호이고, `I01-…`·`I03-…`·`I05-…`·`I06-…`은 그 spec의 번호다.

| 말 | 뜻 |
|---|---|
| 정본 | 원본과 인스턴스 행이 들어 있는 저장소(SQLite). 인스턴스 ID 하나를 수집기 종류 하나에만 묶는다 |
| 묶음 | 정본의 `connector_instances` 행이 적고 있는 "이 ID는 이 종류"라는 기록. 첫 동기화나 첫 가져오기 때 생기고, 그 뒤로 바뀌지 않는다 |
| 어긋남 | 지금 등록(또는 바탕 묶음)이 어떤 ID에 적은 종류와, 정본이 같은 ID에 묶어 둔 종류가 다른 것 |
| 보류(`held`) | 작업이 지금은 돌 수 없어 시도 횟수를 쓰지 않고 멈춰 있는 상태. 사유 코드가 붙고, 조건이 풀리면 다시 대기열로 간다 |

## 배경

정본은 한 인스턴스 ID를 한 종류에만 묶는다(`storage/src/sources.ts`의 `registerConnectorInstance`). 묶인 ID를 다른 종류로 다시 묶으려 하면 이 함수가 예외를 던진다. 종류가 다른 수집기의 원본이 한 ID 아래에 섞이는 것을 막는 마지막 문이다.

그런데 지금은 그 문에 닿기 전에 어긋남을 알아보는 곳이 없다. 예를 들어 사용자가 `mail-1`이라는 ID로 JSONL을 가져온 적이 있는데, 그 뒤 포크의 등록이 같은 ID를 다른 종류의 인스턴스로 적으면 다음과 같이 된다(코드로 확인한 지금의 동작).

- 시작할 때 수집기 관리자(`backend/src/connectors.ts`의 `createConnectorManager`)는 정본의 묶음을 보지 않는다. 수집기를 만들고 초기화하며, 성공하면 그 인스턴스는 `ready`로 목록에 나온다.
- 동기화를 부르면 `runSync`의 첫 트랜잭션에서 `registerConnectorInstance`가 던진다. 관리자의 `sync`는 이 예외를 그대로 올려 보낸다.
- API에서는 서버의 마지막 `catch`가 받아 500 `internal-error`로 답한다(`backend/src/server.ts`).
- 예약된 수집 작업(`connector-sync`)에서는 실행기가 던진 처리기를 `handler-error` 재시도로 닫는다(`backend/src/job-runner.ts`). 몇 번을 다시 해도 결과가 같으므로 시도 횟수만 쓰다가 포기한 작업으로 남는다.

I05-T02의 `boot.stored-mismatch` ② 시험은 이 실패가 다른 인스턴스로 번지지 않고 묶여 있던 원본이 바뀌지 않음을 붙잡았다. 닫힌 쪽으로 실패하므로 자료는 안전하다. 남은 문제는 **원인을 알 수 없다**는 것이다. 목록은 `ready`라고 하는데 동기화는 "내부 오류"이고, 활동 화면의 작업은 "작업 처리 중 오류"다. 비유하자면 열쇠가 맞지 않는 문 앞에서 "고장"이라는 표지만 보는 셈이다. 다만 비유와 달리 문은 고장이 아니라 제대로 잠겨 있고, 고칠 것은 표지다.

## 목표

- 어긋난 인스턴스를 **시작할 때** 알아보고, 다른 "쓸 수 없는 인스턴스"와 같은 길로 다룬다: 목록에 `unavailable`과 정해진 사유, 동기화 요청에 정해진 409 답, 수집 작업은 그 사유로 보류.
- 어긋난 인스턴스의 수집기를 만들지도 초기화하지도 않는다. 동기화할 수 없는 인스턴스가 원 시스템이나 자격 증명에 닿을 이유가 없다.
- 사용자가 화면에서 원인과 고칠 길(등록의 ID나 종류를 고쳐 다시 시작)을 읽을 수 있다.
- 정본의 한 ID 한 종류 규칙과 `boot.stored-mismatch` ②가 붙잡은 성질(번지지 않음, 원본 불변, 던진 글이 새지 않음)은 그대로 둔다.

## 비목표

- **새 HTTP 오류 코드를 만들지 않는다.** 이슈가 예로 든 409 `instance-kind-mismatch`를 오류 코드로 더하지 않고, 답은 기존의 409 `connector-unavailable`이며 `instance-kind-mismatch`는 인스턴스의 **사유**로 쓴다(잠정 결정 D1). 그래서 `backend/src/server.ts`와 `ErrorResponseSchema`는 고치지 않는다.
- **묶음을 고치거나 옮기지 않는다.** 정본의 묶음을 지금 등록의 종류로 바꾸기, 묶여 있던 원본 지우기나 옮기기, 어긋남을 푸는 화면이나 명령은 없다. 푸는 길은 등록(또는 설정)의 ID나 종류를 고쳐 다시 시작하는 것뿐이다.
- **실행 중에 생기는 어긋남은 판정하지 않는다.** 지금 코드에서 묶음을 만드는 곳은 동기화, 가져오기, 시작할 때의 장부 재적용 셋이다. 장부 재적용은 관리자를 만들기 전에 끝나고(`backend/src/boot.ts`), 가져오기는 설정된 다른 종류 인스턴스의 ID에 묶지 못한다(`backend/src/imports.ts`). 그래서 시작한 뒤에 어긋남이 새로 생기는 길이 없다. 그런 길이 생기면 `registerConnectorInstance`의 거부가 지금처럼 마지막 문으로 남는다(500. 불변식이 깨진 것이므로 내부 오류가 맞다).
- **정본에 묶인 종류를 밖으로 내지 않는다.** 목록, 로그, 화면에 나오는 것은 사유 코드와 인스턴스 ID, 지금 등록의 종류뿐이다.
- I01-R20의 동기화 결과 표(`SYNC_OUTCOMES`)와 `syncConnector`·`registerConnectorInstance`의 동작, 가져오기 경로의 답(`bad-request`)은 바꾸지 않는다.
- I05 spec은 고치지 않는다. 그 spec의 C10 ② 문장("그 인스턴스의 동기화만 실패하며")은 이 spec 뒤에도 참이다.

## 요구사항

- **I05F-R1 시작할 때의 판정.** 수집기 관리자는 시작할 때 인스턴스마다 정본의 묶음을 읽는다(`readConnectorKind`). 묶음이 **있고** 그 종류가 지금 적힌 종류와 **다르면** 그 인스턴스는 `unavailable`이고 사유는 `instance-kind-mismatch`다.
  - 판정의 자리는 "모르는 종류"(I05-R11) 판정 **다음**이고, 자격 증명 칸의 선언 판정과 저장소 확인(I06-R6), 만드는 함수, `initialize`보다 **앞**이다. 종류도 모르고 묶음도 다른 인스턴스는 지금처럼 사유 없는 `unavailable`이고 로그는 `connector-kind-unknown`이다.
  - 어긋난 인스턴스에 대해 제품은 만드는 함수를 부르지 않고, 자격 증명 저장소에 묻지 않으며, `initialize`를 부르지 않는다.
  - 로그에는 `connector-kind-mismatch`와 인스턴스 `id`만 한 줄 남는다. 정본에 묶인 종류와 예외의 글은 남기지 않는다.
  - 시작은 끝나고 다른 인스턴스는 영향을 받지 않는다(I05-R11과 같은 규칙).
  - 묶음이 없는 ID(아직 한 번도 동기화하지 않음)와 같은 종류로 묶인 ID는 지금과 똑같이 다룬다.
- **I05F-R2 목록.** 수집기 목록(`GET` 수집기 목록)은 그 인스턴스를 `state: "unavailable"`, `reason: "instance-kind-mismatch"`로 낸다. `kind`는 지금 등록이 적은 종류다. `ConnectorSummarySchema`의 사유 목록에 이 코드를 더한다.
- **I05F-R3 동기화 요청의 답.** 그 인스턴스의 동기화 요청은 409 `connector-unavailable`로 답한다(I05-R11의 "쓸 수 없는 인스턴스"와 같은 답). 수집기는 불리지 않고, 정본의 묶음, 커서, 원본은 바뀌지 않는다. 다른 인스턴스의 동기화는 된다.
- **I05F-R4 수집 작업의 보류.** 그 인스턴스의 `connector-sync` 작업은 사유 `instance-kind-mismatch`로 보류되고 시도 횟수를 쓰지 않는다. I01-R20 표의 `unavailable` 행이 그대로 적용되며 표는 바뀌지 않는다. 이 사유를 보류 사유 표(`backend/src/held-release.ts`의 `HELD_REASONS`)에 수집기 사유로 더한다. 그 결과 다음 기존 동작이 이 인스턴스에도 그대로 적용된다(이 spec이 새로 만드는 것이 아니다): 보류된 작업이 있는 주기는 새 작업을 등록하지 않고 멈춘 것으로 보인다(I03-R20), `ready`가 아니므로 기본 주기를 새로 만들지 않는다(I03-R18).
- **I05F-R5 재점검과 변경 알림은 되살리지 않는다.** 한 시간마다의 재점검(I05-R13)과 자격 증명 변경 알림에 의한 다시 만들기(I06-R12)는 어긋난 인스턴스에 대해 아무것도 부르지 않고 상태를 그대로 둔다. 변경 알림의 답은 `skipped`다. 어긋남은 수집기의 사정이 아니라 등록과 정본의 사정이므로 새 객체를 만들어도 풀리지 않기 때문이다. 판정은 시작할 때 한 번이고, 다시 판정하는 것은 다음 시작이다.
- **I05F-R6 풀림.** 등록의 ID나 종류를 고쳐 다시 시작했을 때 어긋남이 없고 그 인스턴스가 `ready`이면, 사유 `instance-kind-mismatch`로 보류되어 있던 그 인스턴스의 수집 작업이 대기열로 돌아간다(시작할 때 준비된 인스턴스의 보류를 푸는 기존 장치, I03-R16 ②′).
- **I05F-R7 화면의 문구.** ① Sources 화면의 수집기 행은 이 사유에 문장을 낸다. 문장은 "같은 ID가 다른 종류의 자료에 이미 쓰이고 있다"는 원인과 "등록의 ID나 종류를 고쳐 다시 시작한다"는 고칠 길을 담는다. ② 활동 화면의 작업 사유 표(`apps/web/src/job-text.ts`)에 이 코드의 문장이 있고, `connector-unavailable`의 문장과 다르다.
- **I05F-R8 문서.** [connector-sdk.md](../connector-sdk.md) 5장의 보류 설명에 다음 두 문장을 그대로 적는다: "등록의 인스턴스 ID가 정본에 다른 종류로 묶여 있으면 그 인스턴스는 `unavailable`(사유 `instance-kind-mismatch`)이고, 제품은 그 수집기를 만들지도 초기화하지도 않는다. 그 수집 작업은 그 사유로 보류되며, 등록의 ID나 종류를 고쳐 다시 시작해 어긋남이 없어지면 풀린다."
- **I05F-R9 정본의 규칙은 그대로.** `registerConnectorInstance`는 지금처럼 다른 종류로 다시 묶기를 거부하고, 이 spec의 어떤 동작도 정본의 묶음을 쓰거나 고치지 않는다.

## 인터페이스 / 설계 개요

바뀌는 곳은 "인스턴스가 왜 쓸 수 없는가"를 정하는 한 자리, 곧 수집기 관리자의 시작 부분이다. 관리자가 사유를 정하면 나머지는 이미 있는 길을 탄다.

| 보이는 곳 | 지금 | 이 spec 뒤 | 그 동작을 내는 기존 코드 |
|---|---|---|---|
| 수집기 목록 | `ready` | `unavailable`, 사유 `instance-kind-mismatch` | 관리자의 `list` |
| 동기화 요청 | 500 `internal-error` | 409 `connector-unavailable` | 관리자의 `sync`가 준비되지 않은 인스턴스에 내는 답과 `errorStatus` 표(둘 다 그대로) |
| 수집 작업 | `handler-error` 재시도, 시도가 다하면 포기 | `held`, 사유 `instance-kind-mismatch`, 시도 횟수 그대로 | `connector-sync-job.ts`의 `heldReason`(인스턴스의 사유를 그대로 쓴다)과 I01-R20 표의 `unavailable` 행 |
| 재점검·변경 알림 | 해당 없음(`ready`였다) | 아무것도 부르지 않음 | 관리자의 `recheck`·`rebuild` |
| 다음 시작에서 어긋남이 없음 | 해당 없음 | 보류된 작업이 풀림 | `releaseReadyCollectors`와 `COLLECTOR_HELD_REASONS` |

- **계약(`packages/contracts/src/index.ts`)**: `ConnectorSummarySchema.reason`의 값에 `"instance-kind-mismatch"`가 더해진다. `ErrorResponseSchema`와 `SyncResponseSchema`는 그대로다.
- **관리자(`backend/src/connectors.ts`)**: 시작할 때의 인스턴스별 판정에 갈래 하나가 더해지고(`InitializeOutcome`의 사유에 이 코드), `recheck`와 `rebuild`가 이 인스턴스를 "만들 것이 없는" 인스턴스로 다룬다. `sync`는 준비되지 않은 인스턴스에 이미 `connector-unavailable`을 답하므로 그대로다. `syncConnector`와 `runSync`는 고치지 않는다.
- **보류 사유 표(`backend/src/held-release.ts`)**: 한 줄(`"instance-kind-mismatch": { events: [], collector: true }`).
- **고치지 않는 파일**: `backend/src/server.ts`, `backend/src/connector-sync-job.ts`, `storage/src/sources.ts`, `packages/connector-sdk/src/sync-outcomes.ts`. 구현이 이 가운데 하나를 고쳐야 한다고 판단하면 그것은 이 설계와 어긋난 것이므로 먼저 이 spec을 고친다.

그림은 두지 않았다. 더해지는 것은 판정 갈래 하나이고, 그 뒤의 동작은 위 표의 행들이 서로 기대지 않는 목록이어서 한 문장과 표로 빠짐없이 적힌다.

### 대안과 기각 사유

1. **동기화할 때 판정하고 새 오류 코드 409 `instance-kind-mismatch`로 답한다(이슈의 예).** 호출자가 답 하나로 원인을 안다는 장점이 있다. 고르지 않은 이유: ① 목록은 여전히 `ready`라고 말하게 되어, 화면의 동기화 단추가 눌리고 기본 주기가 만들어지고 재점검이 건드리지 않는 "준비된 척하는 인스턴스"가 남는다. 그것을 막으려면 결국 상태도 바꿔야 한다. ② 쓸 수 없는 인스턴스의 답은 이미 `connector-unavailable` 하나이고 원인은 인스턴스의 사유가 말한다(SDK 버전, 자격 증명 넷이 모두 그렇다). 같은 종류의 일에 둘째 방식을 만들지 않는다. ③ 수집 작업 쪽에 I01-R20 표의 새 행이나 오류 코드별 갈래가 필요해진다. ④ `server.ts`의 `errorStatus`를 고쳐야 하는데 그 파일은 지금 다른 작업(S01-T05)이 고치고 있다.
2. **목록을 낼 때마다 정본을 읽어 그때그때 판정한다.** 실행 중에 생기는 어긋남까지 잡는다. 고르지 않은 이유: 그런 길이 지금 없고(비목표), 수집기 객체는 `ready`인 채 남아 "상태는 `unavailable`인데 객체는 살아 있는" 둘째 모양이 생긴다. 재점검이 그 인스턴스를 다시 만들지 않게 하는 가드도 따로 필요하다.
3. **수집 작업을 포기(`dead_letter`)로 닫는다.** `instance-not-found`가 그렇다. 고르지 않은 이유: 등록에서 사라진 인스턴스는 돌아올 자리가 없지만 어긋난 인스턴스는 등록을 고치면 다시 돈다. 보류는 고친 뒤의 시작에서 저절로 풀리고, 포기는 사용자가 작업을 하나씩 되살려야 한다.

### 작업 분해

PR 하나이고 작업은 둘이다. T01이 계약의 사유 값을 더하므로 T02는 그 뒤에 간다. 보류 사유 표에 코드를 더하면 `backend/src/job-text.coverage.test.ts`가 활동 화면 문장을 요구하므로, 그 문장(R7 ②)은 T01에 든다.

| ID | 산출물 하나 | 선행 | 기준 | 바뀌는 파일 | 기대하는 증거 |
|---|---|---|---|---|---|
| I05F-T01 | **판정과 그 결과**: 시작할 때의 어긋남 판정, 사유 값, 보류 사유, 재점검·변경 알림의 건너뜀, 활동 화면 문장 | — | C1, C2, C3, C4, C5, C6(②) | `packages/contracts/src/index.ts`와 `index.test.ts`, `backend/src/connectors.ts`, `backend/src/held-release.ts`, `apps/web/src/job-text.ts`와 `job-text.test.ts`, 시험: `backend/src/connectors.boot.test.ts`, `backend/src/boot.connector-start.test.ts`(②의 기대값을 **의도적으로 바꾸고** ③④를 더한다), `backend/src/connector-sync-job.test.ts` | `connectors.boot-kind-mismatch`, `boot.stored-mismatch` ②③④, `pnpm typecheck`, `pnpm lint` |
| I05F-T02 | **Sources 화면 문장과 문서** | T01 | C6(①), C7 | `apps/web/src/connector-text.ts`와 `connector-text.test.ts`, `docs/connector-sdk.md`(5장), `tooling/docs/connector-sdk.test.ts` | 그 두 시험 파일, 마지막에 `pnpm test` 한 번 |

- 이 spec과 [docs/README.md](../README.md)의 행은 구현보다 먼저 들어간다.
- `tooling/docs/connector-sdk.test.ts`에는 `connectors.ts`의 줄을 글자 그대로 붙잡는 가드가 있다(I05 spec "작업 분해"의 설명). T01이 시작 부분을 고치다 그 가드에 걸리면 같은 PR에서 가드와 문서 문장을 함께 맞춘다.

## 완료 기준 (테스트 가능한 형태)

모든 기준은 **저장소 안의 자동 테스트**(`pnpm test`)로 닫힌다. 괄호 안은 그 시험이 놓이는 파일과 이름이다.

- [ ] **I05F-C1** (R1, R2, R9) (`backend/src/connectors.boot.test.ts`, `connectors.boot-kind-mismatch`): 한 ID가 다른 종류로 묶인 정본으로 관리자를 만들면 ① 그 인스턴스는 목록에 `unavailable`과 사유 `instance-kind-mismatch`, 지금 등록의 종류로 나오고 함께 넘긴 다른 인스턴스는 `ready`다 ② 그 인스턴스의 만드는 함수와 `initialize`가 한 번도 불리지 않고, 칸을 선언했더라도 자격 증명 저장소가 한 번도 불리지 않는다 ③ 로그에 `connector-kind-mismatch`와 그 `id`가 정확히 한 줄 있고, 로그 어디에도 정본에 묶인 종류의 이름이 없다 ④ 묶음이 없는 ID와 같은 종류로 묶인 ID는 `ready`이고 그 로그 줄이 없다 ⑤ 등록에 없는 종류를 적었고 묶음도 다른 인스턴스는 사유 없는 `unavailable`이며 로그는 `connector-kind-unknown`뿐이다 ⑥ 관리자를 만든 뒤에도 정본의 그 묶음은 처음 종류 그대로다.
- [ ] **I05F-C2** (R3, R9) (`backend/src/boot.connector-start.test.ts`, `boot.stored-mismatch` ②. **기존 기대값을 의도적으로 바꾼다**: `[500, { error: "internal-error" }]` → `[409, { error: "connector-unavailable" }]`): `jsonl-import`로 묶이고 원본 하나가 든 ID를 다른 종류의 인스턴스로 적어 실제 `bootBackend`를 띄우면 ① 시작이 끝난다 ② 그 인스턴스의 동기화 요청이 409 `connector-unavailable`이다 ③ 수집기 목록에 그 인스턴스가 `unavailable`, 사유 `instance-kind-mismatch`로 나온다 ④ 다른 인스턴스의 동기화는 원본을 만든다 ⑤ 묶여 있던 원본은 그대로이고, 수집기가 내는 원본은 다른 인스턴스의 것 하나뿐이다(기존 단언 유지) ⑥ 정본의 묶음은 여전히 `jsonl-import`다.
- [ ] **I05F-C3** (R4) (`boot.connector-start.test.ts`, `boot.stored-mismatch` ③과 `backend/src/connector-sync-job.test.ts`의 보류 사유 표 시험): ① C2와 같은 정본에 그 인스턴스의 대기 중 `connector-sync` 작업을 넣고 띄우면 그 작업은 `held`, 사유 `instance-kind-mismatch`로 닫히고 시도 횟수가 쓰이지 않으며(`handler-error`가 아니다), 다른 인스턴스의 동기화는 된다 ② 처리기는 사유 `instance-kind-mismatch`인 `unavailable` 인스턴스의 작업을 그 사유로 보류한다(기존 "names the held reason by the instance's own state" 표에 한 행).
- [ ] **I05F-C4** (R5) (`connectors.boot.test.ts`, `connectors.boot-kind-mismatch`): 어긋난 인스턴스에 ① `recheck`를 부르면 만드는 함수가 불리지 않고 상태와 사유가 그대로다 ② `rebuild`를 부르면 답이 `skipped`이고 만드는 함수와 자격 증명 저장소가 불리지 않는다 ③ `recheckInstances` 한 차례 뒤에도 그 인스턴스의 보류된 작업은 보류 그대로다.
- [ ] **I05F-C5** (R6) (`boot.connector-start.test.ts`, `boot.stored-mismatch` ④): 같은 데이터 폴더로 두 번 띄운다. 첫째는 어긋난 등록이어서 그 인스턴스의 작업이 `instance-kind-mismatch`로 보류된다. 닫고, 그 ID를 정본에 묶인 종류로 적은 등록으로 다시 띄우면 그 인스턴스가 `ready`이고 그 작업이 보류에서 벗어나 성공으로 끝난다.
- [ ] **I05F-C6** (R2, R7): ① (`apps/web/src/connector-text.test.ts`) 사유 `instance-kind-mismatch`인 행에 문장이 나오고, 그 문장은 자격 증명 사유 넷의 문장과 다르며 "다시 시작"을 담는다. 사유 `unsupported-sdk-version`과 사유 없는 행에는 지금처럼 문장이 없다(기존 단언 유지) ② (`apps/web/src/job-text.test.ts`, `packages/contracts/src/index.test.ts`, `backend/src/job-text.coverage.test.ts`) 작업 사유 `instance-kind-mismatch`의 문장이 있고 `connector-unavailable`의 문장과 다르며, `ConnectorSummarySchema`가 이 사유를 받고 사유 자리의 임의 글자는 지금처럼 거부하며, 보류 사유 표의 모든 코드에 문장이 있다는 기존 시험이 통과한다.
- [ ] **I05F-C7** (R8) (`tooling/docs/connector-sdk.test.ts`): connector-sdk.md 5장에 I05F-R8의 두 문장이 글자 그대로 있다.

**기준과 작업의 대응**: C1~C5와 C6 ②는 T01, C6 ①과 C7은 T02다. 기존 시험 가운데 기대값이 바뀌는 것은 `boot.stored-mismatch` ②의 한 줄뿐이다. 다른 기존 시험이 이 변경으로 실패하면(같은 데이터 폴더로 종류를 바꿔 다시 띄우는 시험이 있을 때) 기대값을 고치기 전에 그 시험이 어긋남을 뜻한 것인지부터 확인한다.

**검증되지 않는 범위**: Windows와 설치본에서의 실행, 실제 포크의 등록. 이 spec의 시험은 지어낸 수집기와 임시 폴더의 정본으로 돈다.

## 미해결 질문

없음. 사용자가 다르게 고를 수 있는 것은 아래 표에 고른 쪽과 바꾸는 방법으로 적었다.

## 잠정 결정과 가정

| 결정·가정 | 고른 쪽과 이유 | 바꾸려면 |
|---|---|---|
| D1 동기화 요청의 답 | 409 `connector-unavailable`. `instance-kind-mismatch`는 HTTP 오류 코드가 아니라 인스턴스의 사유다. 쓸 수 없는 인스턴스의 답과 사유를 나누는 기존 방식(I05-R11, I06-R9)을 따르고 `server.ts`를 건드리지 않는다 | `ErrorResponseSchema`에 코드를, `server.ts`의 `errorStatus`에 409 한 줄을 더하고, 관리자의 `sync`가 이 사유의 인스턴스에 그 코드를 답하게 한다. C2 ②의 기대값이 바뀐다 |
| D2 판정의 때 | 시작할 때 한 번. 실행 중에 어긋남이 생기는 길이 없다(비목표의 근거) | 그런 길이 생기면 관리자의 `sync`가 잠금 안에서 묶음을 다시 읽어 같은 상태로 옮기는 요구사항을 더한다 |
| D3 수집 작업의 처리 | 포기가 아니라 보류. 등록을 고친 뒤의 시작에서 저절로 풀린다("대안" 3) | I01-R20 표에 행을 더하거나 처리기가 이 사유를 `instance-not-found`처럼 닫게 한다. C3·C5가 바뀐다 |
| D4 수집기를 만들지 않음 | 어긋난 인스턴스는 만드는 함수도 `initialize`도 부르지 않는다. 동기화할 수 없는 인스턴스가 원 시스템과 자격 증명에 닿지 않게 한다 | R1의 판정 자리를 초기화 뒤로 옮긴다. C1 ②가 바뀐다 |
| D5 판정의 순서 | 모르는 종류 다음, 자격 증명 선언보다 앞. 기존 갈래(`connector-kind-unknown`)의 동작을 건드리지 않는다 | R1의 첫 항목과 C1 ⑤ |
| D6 이름 | 사유 `instance-kind-mismatch`(이슈가 든 이름), 로그 코드 `connector-kind-mismatch`(관리자의 다른 로그 코드 `connector-kind-unknown`과 같은 모양) | 계약의 사유 값, 보류 사유 표, 두 문구 표, R8의 문장 |
| D7 정본에 묶인 종류를 보이지 않음 | 사용자에게 필요한 것은 "이 ID가 이미 다른 자료에 쓰인다"는 사실이고, 묶인 종류의 이름은 지금 빌드에 없는 포크 종류일 수 있다 | 목록에 필드를 더하는 계약 변경(새 요구사항) |
| 정해 두지 않은 것 | 어긋난 인스턴스의 목록 행에 자격 증명 칸(`credentials`)이 나오는지는 정하지 않았다. 구현이 고르고 PR에 적는다 | 필요해지면 R2에 한 항목 |
| 가정 A1 | 시작한 뒤에는 정본의 묶음이 지워지거나 바뀌지 않는다(`connector_instances`의 행을 지우는 코드가 없고 종류를 고치는 코드가 없음을 확인했다) | 묶음을 지우는 기능이 생기면 D2를 다시 본다 |

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-23 | 최초 작성(초안). 어긋남을 시작할 때 판정해 `unavailable`(사유 `instance-kind-mismatch`)로 두고, 동기화 요청은 409 `connector-unavailable`, 수집 작업은 그 사유로 보류 | 이 문서 | 이슈 #128(I05-T02 독립 검토 N1). I05 spec은 고치지 않고 인용한다 |
