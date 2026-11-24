# 스펙: 가져오기 가드 시험 묶음(IGT) — 로컬 파일·첨부 경계의 가드에 시험 붙이기

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 IGT-D1~D6 포함)
- 관련: 이슈 #179(FU2·FU3·FU4), #190(FU-4), #237(#284 검토의 남은 줄), #258(C54의 `revoking` 단언), #263(F-3). [I02 spec](2026-11-22-I02-local-file-import.md)(I02B-R8·R53·C54), [I02F spec](2026-11-24-I02F-followups.md)(I02F-R1·R3·R4, "시험·타입 보강" 행), [LCF spec](2026-11-24-LCF-location-curation-followups.md)(#190 FU-4 행), [PD3 spec](2026-11-24-PD3-pending-decisions.md)(#263 F-3 행), [첨부 spec](2026-11-23-I02-attachment-metadata.md)(I02C-R1·R2·R3)
- 번호: 요구사항 `IGT-R<n>`, 완료 기준 `IGT-C<n>`, 결정 `IGT-D<n>`. **제품 코드·마이그레이션·계약 변경은 없다.**
- 기준 코드: `origin/main` `b64ee295`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

I02F·LCF·PD3가 "시험·타입 보강"으로 넘긴 줄을 코드와 다시 대조했다. 가드는 모두 있고 동작도 맞다. 고칠 결함은 없다. 남긴 것은 **허용·차단, 데이터 격리, 신뢰 경계 검증을 하는 가드인데 지워도 초록인 것**과 값싼 컴파일 시점 가드 하나뿐이다.

| 항목 | 분류 | 근거(`파일:줄`) | 처리 |
|---|---|---|---|
| #179 FU2 색인 포트의 쓰기 인자 드리프트 | 컴파일 가드 없음 | 포트는 메서드 문법(`packages/contracts/src/local-files.ts:109`~`:120`)이라 인자가 양방향으로 느슨하게 검사된다. 기존 대입 시험 `backend/src/local-files-connector.test.ts:46`~`:52`는 실제 색인(`storage/src/local-files.ts:161`)이 쓰기 인자 `EntryFields`(`:131`)·`NewEntry`(`:146`)를 포트의 `LocalIndexFields`·`LocalIndexNewEntry`와 다르게 가져도 통과한다. 지금은 두 쪽이 같다 | R1 |
| #179 FU3 정규화기 포트의 드리프트 검사 | 이미 있음 | 제품 쪽은 `backend/src/composition.ts:802`~`:820`이 실제 격리 정규화기를 캐스트 없이 포트로 돌려준다. 남은 `as unknown as`(`backend/src/local-normalizer.test-support.ts:14`, `local-files-connector.test-support.ts:194`)는 시험 지원 코드이고 제품은 이 경로로 파서에 닿지 않는다 | 하지 않음(D5) |
| #179 FU4 `LOCAL_SKIP_REASONS`에 없는 코드가 `corrupt`로 | 이미 있음 | 컴파일 시점 멈춤: 훑기·읽기 코드 `backend/src/adapters/local-files-connector.ts:109`~`:114`, 격리 정규화기 코드 `backend/src/composition.ts:797`~`:799`. 이 둘을 지나 `asSkipReason`(`local-files-connector.ts:116`)의 `corrupt`에 닿는 제품 코드가 없다 | 하지 않음 |
| #190 FU-4 시작마다 따로 묶는 포트, 묶이지 않은 인스턴스의 `unavailable` | 시험 없음 | 묶기 `backend/src/composition.ts:960`~`:967`(`boot.ts:445`가 부름), 묶이지 않은 목록 `composition.ts:667`, 상태 답 `local-files-connector.ts:882`. `withLocalFilesPorts`·`connectorKinds["local-files"]`를 부르는 시험이 없다 | R2 |
| #237 보류가 남은 `active` 위치가 다음 훑기에 `needs-confirmation` | 시험 없음 | `backend/src/adapters/local-files-connector.ts:626`의 `|| stillHeld`. I02F-C1(`backend/src/local-files-lifecycle.test.ts:202`)은 이미 `needs-confirmation`인 채로 돌아 이 갈래를 지나지 않는다. 삭제 자체는 `:620`이 막는다 | R3 |
| #237 삭제 확인의 `revoking` 거절 | 시험 없음(반) | 허용 상태 목록 `backend/src/local-locations.ts:452`. `paused` 거절은 `backend/src/local-locations.pause.test.ts:65`가 본다. `revoking`을 목록에 더해도 초록이다 | R4 |
| #237 `queued` 뒤 동기화가 실제로 시작됐는지 | 하지 않음 | 거짓 `queued`를 막는 판정(`instance-busy`)은 `backend/src/local-rescan-busy.test.ts`가 본다. 시작 여부(`boot.ts:405`~`:407`)는 허용·차단 가드가 아니고, 비동기 `void` 호출이라 관측하려면 시간에 기대는 시험이 된다 | D4 |
| #237 같은 폴더로 다시 연결하면 보류가 지워짐, `late.manager` 없을 때 `queued` | 이미 분류됨 | 다시 연결은 I02B-R9가 허용한 길(I02F 배경), `late.manager`는 BGL 배경 표(닿지 않음) | 하지 않음 |
| #258 C54의 `revoking` 단언이 정리 로직을 가려내지 못함 | 하지 않음 | 정리 함수(`backend/src/jsonl-file-instances.ts:46`~`:60`)는 행이 없는 쪽 단언(`backend/src/jsonl-file-location.test.ts:198`)이 지킨다. `revoking` 갈래(`jsonl-file-instances.ts:35`)를 지워도 남는 것은 dead letter뿐이다. 그 위치의 파일은 수집기가 읽지 않는다(`backend/src/adapters/jsonl-connector.ts:116`) | D4 |
| #263 F-3 이름 255자·형식 127자, 음수·소수 크기, 음수·소수 블록 번호 | 시험 없음 | `packages/contracts/src/connector.ts:152`(이름), `:159`(형식), `:166`(크기), `:179`(블록의 첨부 번호). 기존 묶음 `packages/contracts/src/connector.test.ts:186`~`:221`은 문자·모양·개수·번호 상한만 본다 | R5 |

## 목표

- 위 다섯 가드(R1~R5)가 지워지거나 어긋나면 빨개지는 시험·타입 검사를 저장소 안에 둔다.

## 비목표

- 제품 코드·계약 변경(시험 파일만 바꾼다). 포트를 함수 타입 속성으로 바꾸기(D1).
- 정규화기 포트의 인자 방향 검사(D5), `queued` 뒤 시작 확인, C54 `revoking` 단언 다듬기(D4).
- #179·#190·#237·#258·#263의 다른 줄(Windows, e2e, F-4·F-5, FU1·FU7).
- 다른 세션(NGT)이 쥔 파일: `backend/src/notify*`, `knowledge-engine/src/notify*`.

## 요구사항

- **IGT-R1** 실제 색인의 `updateEntry`·`insertEntry` 인자 타입이 포트(`LocalIndexPort`)의 같은 메서드 인자 타입과 양방향으로 같다는 것을 컴파일 시점에 검사한다(#179 FU2).
- **IGT-R2** 제품 목록의 `local-files` 인스턴스는 시작 뒤에도 `unavailable`이고, `withLocalFilesPorts`로 묶은 목록의 인스턴스는 `ok`이며, 묶은 뒤에도 원래 목록의 새 인스턴스는 여전히 `unavailable`이라는 것(묶기가 프로세스 전체로 새지 않음)을 시험한다(#190 FU-4).
- **IGT-R3** 보류가 남아 있고 제동 판정은 거짓인 위치가 `active`로 돌아오면, 다음 훑기가 그 위치를 `needs-confirmation`으로 돌리고 보류 수를 그대로 둔다는 것을 시험한다(I02F-R1 끝 문장).
- **IGT-R4** `revoking`인 위치의 삭제 확인은 `bad-request`이고 보류 표시를 바꾸지 않는다는 것을 시험한다(I02F-R3).
- **IGT-R5** 첨부 이름은 255자까지, 형식은 127자까지 받고 한 자 넘으면 거절하며, 음수·소수 크기와 음수·소수 블록 첨부 번호를 거절한다는 것을 시험한다(I02C-R1·R2·R3, #263 F-3).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| IGT-C1 | 실제 색인과 포트의 `updateEntry`·`insertEntry` `Parameters`가 서로 대입 가능하다는 타입 단언이 있고 `pnpm typecheck`가 0이다. 시험 삼아 `EntryFields`에 필드 하나를 더하면 그 단언에서 typecheck가 실패한다(R1) | `backend/src/local-files-connector.test.ts` 「the canonical index satisfies the port (compile-time)」 묶음 |
| IGT-C2 | ① `connectorKinds["local-files"]()`를 `initialize` 하면 `healthCheck`가 `{ state: "unavailable", reason: "the local file ports are not bound" }`다 ② `withLocalFilesPorts(connectorKinds, () => ports)`의 인스턴스는 `{ state: "ok" }`다 ③ ② 뒤에 만든 `connectorKinds["local-files"]()`는 다시 ①과 같다(R2) | `backend/src/composition.test.ts` 새 묶음 |
| IGT-C3 | 40개 중 25개를 지워 보류하고 새 파일 20개를 받아들인 뒤(25/60, 제동 거짓) 일시 정지·다시 켜기로 `active`가 된 위치를 한 번 훑으면 상태가 `needs-confirmation`이고 보류는 25개다(R3) | `backend/src/local-files-lifecycle.test.ts` 「C12: the deletion brake」 묶음 새 사례 |
| IGT-C4 | 보류 1개가 있는 위치를 `revoking`으로 두면 `confirmDeletions({count: 1})`이 `{ error: "bad-request" }`이고 그 항목의 `pendingDelete`는 1이다(R4) | `backend/src/local-locations.pause.test.ts:65`(I02F-C3) 옆 사례 |
| IGT-C5 | 이름 255자·형식 127자인 첨부는 받고, 256자·128자는 거절한다. 크기 `-1`·`1.5`, 블록 `attachment` `-1`·`0.5`는 거절한다(R5) | `packages/contracts/src/connector.test.ts` 「attachments (I02C-C1)」 묶음 |

다섯 다 지금 동작을 묶는 시험이라 처음부터 통과한다(D6). 대신 가드를 한 번씩 무너뜨려 빨개지는 것을 확인하고 되돌린다(되돌릴 때는 `git checkout`이 아니라 백업 사본으로).

| 기준 | 무너뜨릴 가드 | 빨개질 단언 |
|---|---|---|
| IGT-C1 | `storage/src/local-files.ts:131` `EntryFields`에 필수 필드 하나 추가(`pnpm typecheck`) | 타입 단언 |
| IGT-C2 | `backend/src/composition.ts:965` `? { ...kinds, "local-files": () => createLocalFilesConnector(ports) }`를 `? kinds`로 | ② |
| IGT-C3 | `backend/src/adapters/local-files-connector.ts:626` `if ((brake || stillHeld) && state === "active")`의 `|| stillHeld` | 상태 |
| IGT-C4 | `backend/src/local-locations.ts:452` 목록에 `"revoking"` 추가 | `bad-request` |
| IGT-C5 | `packages/contracts/src/connector.ts:152` `.max(MAX_ATTACHMENT_NAME_LENGTH)`, `:159` `.max(MAX_ATTACHMENT_MEDIA_TYPE_LENGTH)`, `:166`의 `.min(0)`, `:179`의 `.min(0)` — 하나씩 | 각 거절 |

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| IGT-D1 | FU2는 포트를 함수 타입 속성으로 바꾸지 않고 시험 파일의 양방향 타입 단언으로 막는다 | 계약 파일을 건드리지 않고 같은 드리프트(쓰기 인자)를 잡는다. 시험 파일도 `pnpm typecheck` 대상이다(`backend/tsconfig.json`의 `include: ["src"]`) | `LocalIndexPort`의 메서드를 `updateEntry: (…) => …` 꼴로 바꾸고 단언을 지운다 |
| IGT-D2 | FU-4는 부팅 없이 `composition.ts`의 함수만으로 시험한다. 포트 값은 `healthCheck`만 보므로 빈 객체를 `LocalFilesPorts`로 캐스트해 넘긴다 | 질문은 "묶기가 인스턴스마다인가"이고, 백엔드 둘을 띄우는 시험(`boot.connector-scopes.test.ts:99`)보다 훨씬 싸다 | 같은 프로세스에서 `bootBackend` 두 번으로 각 인스턴스의 동기화 결과를 비교한다 |
| IGT-D3 | IGT-C3의 `active` 복귀는 저장소 함수 `closeLocation(…, "paused")`·`reopenLocation`으로 만든다 | 위치 API의 일시 정지·다시 켜기(`local-locations.ts:446`·`:448`)가 부르는 같은 함수다. 이 시험 파일은 이미 `closeLocation`을 쓴다(`:134`) | `createLocalLocations`로 API의 `pause`·`resume`을 부른다 |
| IGT-D4 | #237 `queued` 뒤 시작 확인과 #258 C54 `revoking` 단언은 하지 않는다 | 둘 다 허용·차단·데이터 가드가 아니다(테스트 간략화 규칙 1·5). 거짓 `queued`와 행 없는 주기 정리는 이미 시험이 지킨다(배경 표) | 다음 묶음에서 시험 보강으로 잡는다 |
| IGT-D5 | FU3의 남은 캐스트와 정규화기 포트의 인자 방향 검사는 하지 않는다 | 캐스트는 시험 지원 코드뿐이다. 포트 인자 `format?: string`과 실제 `DocumentFormat`은 지금 다르므로(`packages/document-normalize/src/isolated.ts:70`) IGT-R1 같은 양방향 단언은 계약 변경 없이는 세울 수 없다. 수집기가 넘기는 형식은 고정 표(`local-files-connector.ts:87`~`:100`)에서만 나온다 | 포트의 `format`을 `DocumentFormat`으로 좁히는 계약 변경과 함께 단언을 더한다 |
| IGT-D6 | 처음부터 초록인 시험의 빨강은 가드 변이(C1은 타입 변이)로 보인다 | 동작이 이미 맞아 실패 시험을 먼저 만들 수 없다(KGT-D5와 같음) | — |

## 미검증 범위

- 위 사실은 읽기로 확인했다. 변이가 실제로 빨개지는지는 구현 때 처음 확인한다.
- IGT-C3: 새 파일 20개를 받아들이는 동안 이미 `needs-confirmation`이라 그 단계가 상태를 바꾸지 않는다고 읽었다(`local-files-connector.ts:626`의 `state === "active"`). `reopenLocation`이 보류 항목(`pending_delete = 1`)을 건드리지 않는 것도 읽기로만 확인했다(`storage/src/local-lifecycle.ts:48`~`:52`).
- IGT-C2: `initialize`가 인자를 읽지 않는다고 읽었다(`local-files-connector.ts:875`~`:879`).
- Windows, e2e.

## 작업

PR 하나, 구현자 한 명. 시험 파일·검증 명령은 작업 지도(`_workspace/pki-igt/phase1_architect_taskmap.md`)에 있다. `docs/README.md` 색인에 이 spec 한 줄을 더한다. 머지 뒤 #179(FU2·FU3·FU4), #190(FU-4), #237(남은 줄 넷), #258(C54 줄), #263(F-3)의 해당 체크박스를 고치고 이슈는 다른 줄이 남은 것만 열어 둔다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | I02F·LCF·PD3가 넘긴 가져오기 쪽 시험·타입 보강 줄을 코드와 대조해 가드 시험 다섯으로 정리 |
