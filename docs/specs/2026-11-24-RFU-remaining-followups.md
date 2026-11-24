# 스펙: 남은 후속 묶음(RFU) — 손상된 이력에서 멈추지 않기, 유일한 시험 셋, 시험용 DB 템플릿 전환

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D8 포함)
- 관련: 이슈 #192(S02-T03 후속), #207(#173·#182 후속), #212(#123 후속), #240(#181 후속). [S02 spec](2026-11-22-S02-entity-resolution-temporal-graph.md) 잠정 결정 28, [I04 재적용 비용 spec](2026-11-23-I04-ledger-reapply-cost.md), [T181 spec](2026-11-23-T181-test-db-template.md)
- 번호: 요구사항 `RFU-R<n>`, 완료 기준 `RFU-C<n>`, 결정 `RFU-D<n>`, 작업 `RFU-T<n>`. 마이그레이션·계약 변경·새 경로는 없다.

## 배경

한 번도 묶이지 않은 네 이슈의 남은 줄 14건을 지금 코드(`origin/main` `f3ddb240`)와 하나씩 대조했다. **제품 코드를 고치는 것은 1건**(손상된 이력에서 읽기가 끝나지 않음)이고, 시험만 더하는 것이 3건, 시험 준비 코드만 바꾸는 것이 1건이다. 1건은 이미 끝났고, 1건은 조건이 아직 생기지 않았으며, 7건은 이슈에 둔다.

> **이 묶음의 PR이 넣은 범위(2026-11-24)**: 세 자리 모두 들어갔다. 구현하는 동안 #233 세션이 `storage/src/semantic-lifecycle.ts`를 고쳐 제품 쪽 두 자리(`stateMaker`·`policyVerifiedLine`)와 C1을 RFU-D3에 따라 잠시 뺐고, #233이 머지된(PR #312) 뒤 그 위에 다시 얹었다.

### 이번에 하는 것

| 이 spec | 이슈 항목 | 종류 | 지금 코드에서의 모습 |
|---|---|---|---|
| R1 | #207 D1 | 결함(멈춤, 방어) | 이력의 "취소" 줄은 자기가 되돌린 줄 번호(`reverts_seq`)를 적는다. 읽는 쪽은 그 번호보다 앞 줄로 거슬러 간다. 번호가 **자기보다 뒤**를 가리키면 "그보다 앞 줄"이 다시 자기 자신이라 끝나지 않는다: `stateMaker`(`storage/src/semantic-lifecycle.ts:452-458`), `policyVerifiedLine`(`:312-319`), 배포처 실행기의 `_state_maker_actor`(`verification/v02-site-flow/semantic_scenario.py:39-45`). 제품의 두 자리는 쓰기 트랜잭션 안에서 불린다(`:359`·`:483`·`:537`). 이력 줄은 관문만 쓰고 고칠 수 없어(`migrations.ts:785-789`) 정상 경로로는 생기지 않는다. 손으로 고친 DB에서만 일어난다 |
| R2 | #207 FU1 | 시험 보강 | 코드는 맞다(`knowledge-engine/src/analytical-checks.ts:195`, `count`만 열 없이 됨). 열 없는 `sum`·`max`만 시험하고 `count_distinct`는 없다(`analytical-checks.test.ts:288-299`) |
| R3 | #212 FU1 | 시험 보강 | `identityKey`는 시험이 따로 다시 계산한 값과 견준다(`storage/src/identity.test.ts:42-51`·`:73-76`). 글자 그대로 적은 기대값은 없고, `keyedTextHash`의 바이트를 지키는 시험은 없다. 이 해시는 삭제 장부 파일과 DB에 저장되는 값이라 바이트가 바뀌면 옛 줄이 원본을 못 찾는다 |
| R4 | #212 FU3 | 시험 보강 | 실행 색인은 "재적용 중에 평문 원본이 새로 생기거나 지워지거나 해시가 풀리지 않는다"는 가정에 기댄다(F123 spec 가정). 지금 코드에서는 참이다(`ledger-reapply.ts:19-37`이 가져오는 `sources` 쓰기는 `ensureSourceByHash`·`hashSourceIdentity`뿐). 이를 지키는 시험은 없다 |
| R5 | #240 첫 줄 | 시험 속도 | 마이그레이션을 돌리면서 템플릿을 쓰지 않는 시험 파일이 91개 남았다. T181-R4로 바꿀 수 있고 다른 세션이 쥐지 않은 것이 30개(시험 256개)다. 목록은 아래 「R5의 대상」 |

### 이슈에 두는 것

| 분류 | 항목 | 까닭 |
|---|---|---|
| 이미 반영 | #240 F1 | PR #246에서 끝남(이슈에 체크됨) |
| 조건이 아직 없음 | #192 FU1(이름을 고친 추출 항목의 `nameUnsourced`) | X02·X02B가 머지됐지만 항목 이름을 고치는 길이 없다. `items.name`은 넣을 때만 쓰이고(`storage/src/knowledge.ts:66`, `semantic-user.ts:182`) `UPDATE items`는 제품 코드에 없다. 사용자 결정은 `decide`·`add`·`replaceValue`(사실 값)·`undo`뿐이다(`semantic-user.ts:102-125`). 그래서 `nameUnsourced`(`knowledge-engine/src/linking.ts:117`)는 지금 틀린 답을 내지 않는다. 조건은 RFU-D1에 적어 둔다 |
| 배포처 | #192 FU2(`strictest`가 등급을 둘로 접음) | `providers/src/broker.ts:358-362`. 등급이 더 많은 매핑이 있어야 뜻이 있다. S08 배포처 매핑 작업의 몫 |
| 이름·구분 | #207 FU2(`BOOKKEEPING_KIND`가 `"extraction"`) | `storage/src/derivatives.ts:111`. 집계·로그에서 구분이 안 될 뿐 동작은 맞다. 값을 바꾸면 저장된 행과 어긋난다 |
| 시험 보강(큼) | #207 U3(`check:` 참조의 계약 묶음 두 번째 실행) | 새 fixture가 필요한 작업이다. 한 줄 보강이 아니다 |
| 측정 먼저 | #207 U5(수명 주기 훅 비용), #240 마이그레이션 v26 비용 | 재지 않았다. 이번에 잰 값으로는 마이그레이션 전체가 경우당 0.1초 안쪽이다(부하 2) |
| 하지 않기로 함 | #240 폴더를 새로 만들지 않는 backend 시험 9개와 `openCanonicalDb`를 여러 번 부르는 14개, `globalSetup` 공유 | RFU-D6·D7 |
| 동료 보유 | #240 가운데 `storage/src/analytical-*.test.ts` 6개 | #233 세션이 `analytical-views` 계열 시험을 고치는 중이고, 이 묶음은 그 계열을 건드리지 않겠다고 이슈에 적었다 |

### R5의 대상(30개)

메모리 DB(`openBetterSqlite3(":memory:")` 바로 다음 줄이 `migrate`) 26개:

- `backend/src/`: `lint-gate`, `notify-gate`, `notify-outbox`, `wiki-gate`, `derivative-coverage`
- `knowledge-engine/src/`: `canonical-kinds`, `feedback-eval`, `insight-code-rules`, `insight-interpret-grading`, `insight-interpret`, `insight-rules`, `lint-kind`, `notify-job`, `projection-kinds`, `reflect-job`, `reflection-refine-job`, `wiki-kind`, `retrieval/preference`, `retrieval/retrieve`, `retrieval/strategies`
- `providers/src/`: `broker.insight-interpret`, `broker.reflection-refine`
- `storage/src/`: `insights`, `local-lifecycle`, `reflection`, `wiki`

파일 DB(`beforeEach`에서 `openCanonicalDb` 한 번) 4개: `backend/src/`의 `ask-flow`, `jsonl-import`, `notify-no-egress`, `wiki-flow`.

남는 61개는 바꾸지 않는다. 시험이 하나뿐이라 얻을 것이 없는 7개, 이미 파일당 한 번(`beforeAll`)인 7개, 여는 것 자체가 시험 대상이거나 여러 번 열거나 준비 코드가 `beforeEach` 밖(시험 본문·헬퍼)에 있는 backend 시험 30개(boot·composition·ledger·restore 계열 등, T181-R4 밖), 마이그레이션·키·장부를 확인하는 시험과 파일 경로로 여는 시험 11개, 동료 보유 6개다.

## 목표

1. 손상된 이력이 있어도 이력을 읽는 세 자리가 반드시 끝난다.
2. 저장되는 해시의 바이트, 재적용의 가정, 열 없는 `count_distinct`에 각각 시험이 하나씩 있다.
3. 남은 시험 파일 30개가 마이그레이션을 파일당 한 번만 돌린다.

## 비목표

- **항목 이름 고치기 기능**과 `nameUnsourced`의 뜻 바꾸기(#192 FU1). 조건이 생길 때의 요구만 RFU-D1에 적는다.
- **위 "이슈에 두는 것" 전부.** `providers/src/broker.ts`는 고치지 않는다.
- **없는 줄을 가리키는 `reverts_seq`의 처리 바꾸기.** 앞쪽의 없는 번호를 가리키면 지금도 끝나고(그보다 앞 줄을 읽음) 그대로 둔다.
- **이력 표에 제약(CHECK·트리거) 더하기.** 마이그레이션이 생긴다.
- **시험의 단언·경우 수·제목 바꾸기**(R5). 바뀌는 것은 준비 코드뿐이다(T181과 같음).
- **다른 세션의 파일.** `storage/src/analytical-views.ts`·`valid-row.ts`·`assertion-links.ts`·`analytical-gate.ts`·`knowledge.ts`와 그 시험, `backend/src/analytical-api.ts`, `apps/web/**`, `apps/desktop/**`.

## 요구사항

- **RFU-R1 뒤를 가리키는 취소 줄은 "가리키는 줄 없음"이다.** 취소·복원 줄의 `reverts_seq`가 그 줄 자신의 번호보다 작지 않으면, 세 자리 모두 `reverts_seq`가 비었을 때와 같은 답을 낸다: `stateMaker`는 `"unreadable"`, `policyVerifiedLine`은 `undefined`, `_state_maker_actor`는 `None`. 정상 이력의 답은 바뀌지 않는다.
- **RFU-R2 열 없는 `count_distinct`는 `column-missing`이다.** 코드는 고치지 않고 시험으로 못 박는다.
- **RFU-R3 저장되는 해시의 바이트를 고정 벡터로 못 박는다.** 키를 정해진 32바이트(`00`~`1f`)로 바꾼 DB에서 `identityKey("c1", "ns", "e1")`와 `keyedTextHash("domain", "text")`가 글자 그대로 적은 값과 같다. 기대값은 제품 코드가 아닌 것으로 계산한다(RFU-D4).
- **RFU-R4 재적용은 평문 원본을 늘리지도, 지우지도, 해시를 풀지도 않는다.** 재적용 앞뒤의 `sources`를 견줄 때 ① 앞에 있던 행 번호는 뒤에도 모두 있고 ② 뒤에 평문인 행은 앞에서도 같은 `namespace`·`external_id`의 평문이었다.
- **RFU-R5 대상 30개 파일의 준비 코드를 템플릿으로 바꾼다.** 규칙은 T181-R4·R5 그대로다: 바꾼 뒤 실패하면 단언을 고치지 않고 그 파일을 되돌린 다음 PR 본문에 파일과 이유를 적는다. T181 spec의 「미루는 항목」을 결과에 맞게 고친다.

## 인터페이스 / 설계 개요

- **R1**: 세 자리 각각 조건 한 줄이다. `stateMaker`와 `policyVerifiedLine`은 줄 배열만 받는 순수 함수라 읽기 코드(`linesOf`, `readRow`)는 손대지 않는다. 시험은 새 파일(`storage/src/semantic-lifecycle.corrupt-history.test.ts`)에 둔다(RFU-D3).
- **R2~R4**: 기존 시험 파일에 시험 하나씩. R4는 `ledger-reapply.test.ts`의 F123-C1이 쓰는 배치(백업본에 장부를 재적용)를 그대로 쓰고, 알려진 평문 원본의 삭제 줄 하나와 본 적 없는 정체의 줄 하나를 둔다.
- **R5**: `@pki/testkit`의 `memoryDbTemplate`·`dirTemplate`을 쓴다. 새 helper는 만들지 않는다.

그림은 넣지 않는다(서로 독립인 작은 변경이라 순서 있는 교환·상태 전이·네 개 이상 부품의 구조가 없다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 | 변이 검사 |
|---|---|---|---|
| RFU-C1 | 가장 새 줄이 취소이고 그 `reverts_seq`가 자기 번호보다 클 때 ① `superseded` 사실에 `evidenceReturned`를 부르면 `refused`·`invalid-transition`이 돌아오고 이력 줄이 늘지 않는다 ② `verified` 사실에 사용자 승인을 부르면 `unchanged`가 돌아온다. 둘 다 돌아온다는 것 자체가 기준이다(R1) | `storage/src/semantic-lifecycle.corrupt-history.test.ts`(새 파일) | 불필요(허용·차단을 가르는 보안 관문이 아님) |
| RFU-C2 | `_state_maker_actor`에 같은 모양의 줄(둘째 줄이 취소, `reverts_seq`가 5)을 주면 `None`이 돌아온다(R1) | `verification/tests/test_s01_semantic_scenario.py` | 불필요 |
| RFU-C3 | 열 없이 `count_distinct`를 돌리면 `[false, "column-missing"]`이다(R2) | `knowledge-engine/src/analytical-checks.test.ts` | 불필요 |
| RFU-C4 | 키를 `00`~`1f`로 바꾼 DB에서 `identityKey("c1","ns","e1")`가 `76e4cfdacc9154f321d6069c70716a254bc03d1683dcf9704dc9bcd441590f11`이고 `keyedTextHash("domain","text")`가 `1f72b68891ee2a4b0824c1ee9da23e37b2c0fda09f59cd347d270675a4f35340`이다(R3) | `storage/src/identity.test.ts` | 불필요(시험만 더함) |
| RFU-C5 | 평문 원본이 여럿인 백업본에 삭제 줄(알려진 원본 하나, 본 적 없는 정체 하나)을 재적용한 뒤 R4의 ①·②가 참이다(R4) | `knowledge-engine/src/ledger-reapply.test.ts` | 불필요(시험만 더함) |
| RFU-C6 | 바꾼 파일의 diff에 import와 준비 코드 외의 변경이 없고 `it(`·`test(` 줄의 추가·삭제가 없으며, PR 직전 전체 실행이 통과한다. 되돌린 파일은 PR 본문에 이유와 함께 있다(R5) | diff 확인, `pnpm lint`·`pnpm typecheck`·`pnpm test` | 불필요 |

C1의 시험은 고치기 전 코드에서 **실패하지 않고 멈춘다**(동기 무한 반복이라 vitest의 시간 제한이 끊지 못한다). 빨간 상태 확인은 시간 제한을 건 별도 실행으로 하고 프로세스를 끝낸다. C4·C5는 지금 코드에서 처음부터 통과해야 한다. 통과하지 않으면 제품 결함이므로 기대값을 고치지 않고 멈춰 보고한다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **RFU-D1 #192 FU1은 조건으로 남긴다.** 항목 이름을 고치는 길을 만드는 spec은 "사용자가 이름을 고친 항목은 자기 계보가 남아 있어도 `nameUnsourced`가 참"을 요구사항으로 가져야 한다. 지금 표시는 "자기 계보가 빔"만 뜻하므로(`linking.ts:117`) 이름을 고친 추출 항목은 거짓이 되어 사용자가 쓴 이름이 합성 원본의 등급으로 나갈 수 있다. 이 문장이 그 작업의 선행 조건이다.
- **RFU-D2 R1은 같거나 뒤를 가리키면 모두 "없음"으로 본다.** 자기 자신을 가리키는 줄은 지금도 끝나지만 관문이 쓸 수 없는 값이라 함께 거절한다. 뒤만 막으려면 조건을 `>`로 바꾼다.
- **RFU-D3 R1의 시험은 새 파일에 둔다.** #233 세션이 `semantic-lifecycle.ts`의 읽기 함수를 고칠 예정이라(분석 읽기 일괄화 spec 「인터페이스」) 겹침을 제품 파일의 두 줄로 줄인다. 머지 때 그 세션이 같은 자리를 이미 고쳤으면 제품 쪽 두 줄은 이 PR에서 빼고 #207에 남긴다(Python 쪽과 나머지는 그대로 간다).
- **RFU-D4 고정 벡터의 기대값은 Python `hmac`으로 계산했다.** 키 `bytes(range(32))`, 부분마다 4바이트 길이(big-endian) 뒤에 UTF-8 바이트. 제품 함수의 출력을 베끼면 시험이 지금 동작을 따라갈 뿐이다.
- **RFU-D5 R4는 SQL 문장이 아니라 앞뒤 상태를 견준다.** 문장 글자에 묶이지 않는다(F123-D4와 같은 이유). 시험이 지나가는 길에서만 지킨다는 한계가 있다.
- **RFU-D6 backend 시험 9개·14개는 바꾸지 않는다.** boot·composition·ledger·restore 계열은 DB를 여는 것 자체가 시험 대상이거나 한 시험이 같은 폴더를 여러 번 연다. 파일마다 판단해야 하고, 이번에 잰 값으로는 경우당 얻는 것이 0.1초 안쪽이다. 바꾸려면 파일 하나씩 T181-R4를 넓히는 별도 결정이 필요하다.
- **RFU-D7 `globalSetup` 공유는 하지 않는다.** 파일당 한 번이 남아도 부하가 낮을 때 0.1초 안쪽이고, 실행 전체에서 하나를 나누면 worker 사이의 수명 관리와 낡은 템플릿 위험이 생긴다. 전체 실행 시간이 다시 문제가 되면 측정부터 한다.
- **RFU-D8 `storage/src/analytical-*.test.ts`는 R5에서 뺀다.** #233 세션이 쥔 것은 그 가운데 둘이지만 이슈에 계열 전체를 건드리지 않겠다고 적었다. 넣으려면 #233 머지 뒤 `analytical-check-lines`·`analytical-runner-schema`·`analytical-types`·`analytical-values`를 대상에 더한다.

## 미검증 범위

- **R5의 전환 뒤 시간.** 재지 않았다. 전환 전은 쟀다: 부하 2에서 `storage/src/insights.test.ts`는 경우당 64~98 ms(시험 본문 포함), 세 파일 42개가 1.9~2.8초였다. T181이 잰 템플릿 열기는 4~5 ms다. 줄어드는 마이그레이션은 약 226번이므로 부하가 낮을 때 합쳐 십수 초, T181이 잰 부하 30~80(한 번에 0.3~0.4초)에서는 1분 남짓으로 **추정**한다. PR에 두 파일의 전후를 적는다.
- **대상 30개가 모두 바뀌는지.** 목록은 준비 코드의 모양으로 골랐다. 가짜 시계나 서로 다른 키가 필요한 파일은 R5의 되돌리기 규칙으로 걸러진다.
- **손상된 이력이 실제로 생기는 길.** 찾지 못했다. 관문만 줄을 쓰고 줄은 고칠 수 없다. R1은 손으로 고친 DB에 대한 방어다.
- **#192 FU2, #207 U5, v26 비용**은 살피지 않았다.

## 작업 분해

PR 하나, 구현자 한 명이 순서대로. 자세한 그래프는 설계 보고에 있다.

| 작업 | 산출물 | 기준 | 선행 |
|---|---|---|---|
| RFU-T1 | 이력 읽기 세 자리의 방어와 시험(TypeScript 새 파일, Python 한 건) | C1, C2 | 없음 |
| RFU-T2 | 시험 셋(열 없는 `count_distinct`, 고정 벡터, 재적용 앞뒤 상태) | C3, C4, C5 | 없음(T1 뒤에 이어서) |
| RFU-T3 | 시험 파일 30개의 템플릿 전환, T181 spec 「미루는 항목」 갱신 | C6 | 없음(T2 뒤에 이어서) |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | 이슈 #192·#207·#212·#240의 남은 줄 14건을 코드와 대조해 한 묶음으로 정함 |
| 2026-11-24 | 확정. 제품 쪽 두 자리와 C1을 이번 PR에서 빼고 #207에 남김(배경의 범위 알림) | 배경, 상태 | RFU-D3: #233 세션이 같은 파일(`storage/src/semantic-lifecycle.ts`)을 고친 커밋을 올림. 독립 검토 F1 |
| 2026-11-24 | 제품 쪽 두 자리와 C1을 다시 넣음 | 배경 | #233(PR #312)이 머지돼 같은 파일을 동시에 고치는 상태가 끝남 |
