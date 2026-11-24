# 스펙: Phase 3 결정 대기 묶음(P3D) — 열 이름 대조와 기각된 Dataset 항목

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D7 포함)
- 관련: 이슈 #218(첫째 줄), #209("기각된 Dataset 항목" 줄), Phase 3 #5. [S03 spec](2026-11-22-S03-analytical-semantic.md)(S03-R7·R14·R16), [P3F spec](2026-11-24-P3-followups.md)(P3F-D5가 첫째 건을 넘김), [RDF spec](2026-11-24-RDF-remaining-defects.md)(RDF-D5가 둘째 건을 넘김)
- 번호: 요구사항 `P3D-R<n>`, 완료 기준 `P3D-C<n>`, 결정 `P3D-D<n>`, 작업 `P3D-T<n>`. **마이그레이션과 계약 변경은 없다.**
- 기준 코드: `origin/main` `496701c6`. 아래의 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

| 말 | 뜻 |
|---|---|
| 인식 유형 | 그 값이 문서에 적힌 것(`explicit`)인지 모델의 짐작(`hypothesis`)인지. `hypothesis`는 자동으로 승격되지 않는다(S01-R9의 2) |
| 묶임 | Dataset 항목이 실제 표를 갖고 있다고 승격의 조건이 치는 것(`bound()`) |
| 표를 잃음 | `verified`인 행이 닿던 실제 표를 잃어 제품이 이의를 걸거나 승격을 되돌리는 판정(S03-R16) |
| 자리 | "표를 잃음"을 판정하는 때. S03-R16이 ①~④로 적는다 |

## 배경

두 건 모두 결함이 맞지만 "무엇을 맞다고 볼지"가 S03 spec에 적혀 있지 않아 앞선 묶음이 넘겼다. 이 spec이 그 규칙을 잠정으로 정하고 S03 spec의 문장을 함께 고친다.

| 건 | 분류 | 지금 코드에서 확인한 것 |
|---|---|---|
| #218 첫째 줄: 열 이름이 다른 낱말 안에서 맞음 | 고침(R1·R2) | `knowledge-engine/src/extraction.ts:568`·`:569`가 가공한 인용문에 열 이름이 **부분 문자열로** 들어 있는지만 본다(`quoted.includes(name)`). 열 `id`와 인용문 "valid orders only"는 "val**id**" 때문에 맞아, 모델이 낸 `explicit`이 그대로 저장된다(`:591`·`:599`). S03-R7의 문장 "인용문 안에 글자 그대로"가 이것을 허용한다(S03 spec 188행) |
| #209: 기각된 Dataset 항목도 묶인 것으로 셈 | 고침(R3·R4) | `storage/src/analytical-gate.ts:97`~`:105`의 `bound()`는 `dataset_tables` 줄과 tombstone만 보고 항목의 상태를 읽지 않는다. 그래서 사용자가 기각한 Dataset을 가리키는 계산 기준도 `no-dataset` 없이 승인된다(`:116`·`:184`). S03-R14의 `no-dataset` 정의가 항목 상태를 말하지 않는다(S03 spec 278행) |

같은 파일의 다른 `includes` 대조(`extraction.ts:555` 단위·판, `:577` 식별자, `:663` 표기)는 이슈가 가리키지 않았고 S03-R7·S02-R4가 "글자 그대로"로 정한 다른 규칙이라 건드리지 않는다.

## 목표

- 열 이름이 다른 영문 낱말의 일부로만 나오는 인용문은 `explicit`의 근거가 되지 않는다.
- 사용자가 기각한 Dataset 항목은 승격의 조건에서 실제 표로 치지 않고, 그 항목에 기대어 `verified`이던 행은 관계를 기각했을 때와 같은 판정을 받는다.

## 하지 않는 것

- **이미 저장된 행을 고치는 일**(D3·D7). 마이그레이션이 없다.
- 한글·한자·가나 열 이름의 낱말 경계 판정(D1의 한계).
- 읽기 API의 "실제 표" 표시, 검사 작업을 넣는 범위, 삭제 전파가 후보를 모으는 범위를 바꾸는 일(D6).
- `apps/web`의 변경. 응답의 모양과 조건 이름이 그대로라 화면은 고칠 것이 없다.
- #218의 나머지 세 줄과 #209의 나머지 줄(시험 보강·문구·측정으로 이미 분류됨).

## 요구사항

### 열 이름 대조(#218)

- **P3D-R1 열 이름은 낱말 경계에서 맞아야 한다.** `column`·`column-set`·`calculation`·`key-pairs` 값의 열 이름마다, 가공한 인용문 안에 그 이름이 나오는 자리 가운데 **양쪽 경계가 모두 서는 자리가 하나라도** 있어야 `explicit`을 받아들인다. 비교는 지금처럼 가공한 글끼리 한다(`normalizeColumnName`: NFKC, 소문자, 공백 한 칸. `storage/src/analytical-types.ts:113`).
  - **경계 글자**는 글자(`\p{L}`)·숫자(`\p{N}`)·밑줄 가운데 한글·한자·히라가나·가타카나가 **아닌** 것이다(영문·숫자·밑줄이 대표).
  - 한쪽 경계가 **서지 않는** 경우는 하나뿐이다: 열 이름의 그쪽 끝 글자와 인용문의 바로 옆 글자가 **둘 다** 경계 글자일 때. 인용문의 처음과 끝, 공백, 문장 부호, 한글 옆은 모두 경계가 선다.
  - 예: 열 `id`는 "valid orders only"에서 서지 않고(앞이 `l`), "id 열을 센다"와 "order의 id를 센다"에서 선다. 열 `order_id`는 "order_id를 센다"에서 선다(뒤가 한글). 열 `amount`는 "amount2"에서 서지 않는다.
- **P3D-R2 맞지 않으면 지금처럼 `hypothesis`로 낮춘다.** 버리지 않고 버린 수에도 세지 않는다(`extraction.ts:570` 그대로). 상태는 `candidate`다.

### 기각된 Dataset 항목(#209)

- **P3D-R3 기각되거나 물린 Dataset 항목은 묶인 것으로 치지 않는다.** `bound()`는 지금 조건에 더해 그 항목의 상태가 `rejected`도 `superseded`도 아닐 때만 참이다. `candidate`·`verified`·`disputed`는 친다. 조건은 **같은 SQL 한 문장 안에** 더한다(질의 수가 늘지 않아야 `analytical-views.read-cost`의 상한이 그대로다).
  - `bound()`를 부르는 곳은 `noDataset()` 하나이고(`analytical-gate.ts:116`), `noDataset()`을 부르는 다섯 자리는 모두 새 뜻을 그대로 받는다. 따로 고칠 줄은 없다.

    | 부르는 자리 | 달라지는 것 |
    |---|---|
    | `dataChecksUnmet` `:184` → 사용자 승인(`semantic-user.ts:361`), 자동 승격(`auto-verify.ts:153`), 읽기(`analytical-views.ts:300`), 거부의 답(`read-gate.ts:504`) | 기각된 Dataset만 가리키는 행에 `no-dataset`이 나오고 승인·승격이 막힌다 |
    | `judgeCheckJob` `:308`, `judgeClaims` `:328`, `judgePathCut` `:347`, `judgeWaitingOn` `:373` | 그 자리가 보는 행 가운데 Dataset이 기각된 `verified` 행도 "표를 잃음"으로 판정된다 |

- **P3D-R4 항목에 대한 사용자 조치도 "표를 잃음"의 자리다.** 사용자의 승인·기각·이의(`decide`)나 취소(`undo`)가 **항목**에 적용되면 같은 트랜잭션에서, 그 항목 자신과 그 항목을 살아 있는 `MEASURED_ON`·`JOIN_LEFT`·`JOIN_RIGHT`로 가리키는 항목마다 관계 기각(S03-R16의 ②)과 **같은 판정**을 한다: `verified`인 검사가 필요한 사실이 `no-dataset`이고 기다리는 행이 아니면 표를 잃는다. 근거 번호는 그 Dataset 항목의 표 원본과 그 현재 version, 이유 코드는 `data-basis-lost`다.
  - 입구(`semantic-user.ts`)는 항목의 ID만 넘기고 유형 이름을 보지 않는다(S01-R4. `analytical-gate.ts:5`의 약속 그대로). 표가 한 번도 프로파일된 적이 없으면 아무것도 읽지 않는다(`anyTable`, `:46`).
  - 항목이 지워지는 취소(`removed`)에서는 하지 않는다. 걸린 것이 있으면 그 취소가 거부된다(S02-R11, `semantic-user.ts:252`~`:256`).
  - 묶임이 늘어나는 조치(기각의 취소, 기각된 항목의 승인)에서는 판정이 아무것도 하지 않는다. 가르지 않고 항상 불러 둔다.

### 바꾸는 자리

| 파일 | 바꾸는 것 |
|---|---|
| `knowledge-engine/src/extraction.ts` | `:569`의 `quoted.includes(name)`을 R1의 경계 대조로 바꾼다. 대조 함수는 이 파일 안에 둔다(쓰는 곳이 하나). `:549`·`:550`의 주석 한 줄을 맞춘다 |
| `storage/src/analytical-gate.ts` | `bound()`의 SQL(`:100`~`:102`)에 항목 상태 조건을 더한다(`:26`의 `LIVE`와 같은 두 상태). `judgePathCut` 옆에 항목 하나를 받아 R4의 대상마다 같은 판정을 하는 함수를 더해 내보낸다 |
| `storage/src/semantic-user.ts` | `decide`(`:364`~`:366`)와 `undo`(`:425`~`:429`)에서 대상이 항목이고 결과가 `applied`이면 그 함수를 부른다 |

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| P3D-C1 | 문서 추출의 응답이 `metric.calculation` 둘을 `explicit`으로 낸다: ㉮ 열 `id`, 인용문 "valid orders only" ㉯ 열 `order_id`, 인용문 "order_id를 센다". 저장된 행은 ㉮가 `candidate`·`hypothesis`, ㉯가 `candidate`·`explicit`이고 버린 수는 둘 다 0이다(R1, R2) | `knowledge-engine/src/extraction-v5.test.ts`(X-C2 묶음에 한 건) |
| P3D-C2 | 표에 묶인 Dataset 하나를 `MEASURED_ON`으로 가리키고 검사 줄이 모두 통과한 `candidate` 계산 기준이 있을 때, 사용자가 그 Dataset 항목을 기각하면 `dataChecksUnmet`이 `no-dataset`을 답하고 그 사실의 승인이 `data-check-unmet`으로 거부된다. 기각을 취소하면 채우지 못한 조건이 없다(R3) | `storage/src/analytical-gate.test.ts`(`gate.user-approve`) |
| P3D-C3 | 같은 모양에서 계산 기준을 먼저 승인해 `verified`로 만든 뒤 사용자가 그 Dataset 항목을 기각하면, 같은 호출 뒤에 그 사실이 `disputed`이고 마지막 이력 줄이 주체 `policy`, 이유 `data-basis-lost`, 근거가 그 표 원본과 현재 version이다(R4) | `storage/src/analytical-gate.test.ts`(`gate.lost`, G-C4 ② 옆) |

경계값·조합의 전수 시험은 하지 않는다(열 이름 종류 넷 가운데 `calculation` 하나, 상태 다섯 가운데 `rejected` 하나, 관계 유형 셋 가운데 `MEASURED_ON` 하나로 대표한다). 변이 확인은 요구하지 않는다(보안·자료 보호의 허용·차단 가드가 아니다). 기존 시험 `extraction-v5.test.ts`의 나머지, `analytical-gate.test.ts`의 G-C1~G-C4와 F209-C3, `analytical-claims.test.ts`, `analytical-views.read-cost.test.ts`는 고치지 않고 그대로 통과해야 한다.

## S03 spec에 고치는 문장

이 커밋이 함께 고친다(문서만).

| 자리 | 고친 것 |
|---|---|
| S03-R7 "열을 가리키는 값의 인식 유형" | "글자 그대로"를 P3D-R1의 낱말 경계 대조로 바꾸고 이 spec을 가리킴 |
| S03-R14 표의 `no-dataset` 행 | 기각되거나 물린 Dataset 항목은 묶음이 있어도 치지 않는다는 문장과 가리킴 |
| S03-R16 "표를 잃음을 판정하는 때"의 ② | 항목에 대한 사용자 조치를 같은 자리로 더함 |
| 변경 이력 | 한 줄 |

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **P3D-D1 경계는 영문·숫자·밑줄 쪽에만 세운다.** 우리말은 조사가 낱말에 붙는다("매출액을", "order_id를"). 모든 글자를 경계 글자로 치면 한글 문서의 열 이름이 거의 다 `hypothesis`로 떨어져 `explicit`이 쓸모를 잃는다. 그래서 한글·한자·가나는 경계 글자에서 뺀다. **남는 한계**: 한글 열 `매출`은 "매출액" 안에서 여전히 맞는다(띄어쓰기 없는 글자라 기계로 가를 수 없다). 영향은 자동 승격의 조건 하나이고 데이터 검사(S03-R14)가 따로 막는다. 바꾸려면 `extraction.ts`의 대조 함수 하나와 C1을 고친다. **갱신**: 가나의 범위는 `Script_Extensions`로 정했다. 장음 부호 "ー"(U+30FC)도 경계 글자에서 빠진다(PD3-R3, [PD3 spec](2026-11-24-PD3-pending-decisions.md)).
- **P3D-D2 맞지 않는 값은 버리지 않고 낮춘다.** 지금 동작 그대로다. 열을 짐작한 값도 후보로는 쓸모가 있고 사용자가 승인할 수 있다. 버리게 하려면 `extraction.ts:570`을 `drops`로 바꾼다.
- **P3D-D3 이미 `explicit`으로 저장된 행은 그대로 둔다.** 다시 추출해도 낮아지지 않는다: 같은 값의 행은 새로 쓰이지 않고(`storage/src/knowledge.ts:92`의 `ON CONFLICT DO NOTHING`), 추출이 인식 유형을 바꾸는 길은 `hypothesis`를 `explicit`으로 올리는 것뿐이다(`storage/src/semantic-lifecycle.ts:532`). 원본을 지우고 다시 들여오면 새 규칙으로 다시 쓰인다. 잘못 남은 `explicit`의 영향은 자동 승격(기본 꺼짐)의 조건 2를 지나는 것뿐이고 데이터 검사가 남는다. 한꺼번에 고치려면 근거의 인용문으로 다시 판정해 입구로 낮추는 일회성 작업이 필요한데, 그것은 사용자 자료의 마이그레이션이라 따로 정한다.
- **P3D-D4 `rejected`와 `superseded`만 묶임에서 뺀다.** 같은 파일이 관계에 쓰는 "살아 있음"(`analytical-gate.ts:26`)과 유효한 행의 정의(`storage/src/valid-row.ts:10`)와 같은 두 상태다. `disputed`는 사용자가 아직 정하지 않은 상태라 친다: 빼면 이의를 거는 것만으로 `verified` 행들이 함께 이의에 걸린다. 항목이 `superseded`가 되는 길은 지금 없지만(S01-R5: 항목은 사용자의 줄만 쓴다. `semantic-lifecycle.ts:130`~`:136`) 관계와 같은 술어를 쓰려고 함께 적는다. `disputed`도 빼려면 `bound()`의 조건 한 줄과 C2를 고친다.
- **P3D-D5 항목의 기각을 판정의 자리로 삼는다(R4).** R3만 넣으면 기각된 Dataset에 기대던 `verified` 행이 읽기에 `no-dataset`을 띄운 채 남는다. S03-R16은 "`verified`인데 `no-dataset`"을 아직 판정되지 않은 행으로 읽으므로, 길을 끊는 사용자 조치인 관계의 기각(②)과 같은 때에 판정한다. 빼려면 `semantic-user.ts`의 호출 두 줄을 지운다(그 행은 다음 자리가 올 때까지 `verified`로 남는다).
- **P3D-D6 묶임을 따로 읽는 다른 자리는 그대로 둔다.** 고치지 않는 까닭이 자리마다 있다.

  | 자리 | 그대로 두는 까닭 |
  |---|---|
  | 읽기의 "실제 표"(`storage/src/analytical-views.ts:339`, S03-R8의 3) | 표가 있다는 사실을 보여 주는 것이고 항목의 상태는 행마다 함께 나간다. 화면(`apps/web`)이 달라지지 않는다 |
  | 판정의 근거(`analytical-gate.ts:252`의 `tableBasis`) | 기각된 항목의 표가 바로 근거 번호다. 상태를 보면 R4가 근거를 잃어 움직이지 못한다(`:234`) |
  | 검사 작업을 넣는 범위(`analytical-check-lines.ts:56`), 삭제 전파의 후보(`knowledge-engine/src/canonical-kinds.ts:1003`), 나누기 기록(`analytical-check-lines.ts:469`) | 넓게 모으고 판정이 `no-dataset`으로 거른다. 좁히면 놓치는 행이 생긴다 |
  | `spec-conflict`의 길 세기(`analytical-gate.ts:120`, `:154`) | 기각된 Dataset으로의 살아 있는 관계가 다른 관계와 함께 있으면 지금처럼 충돌이다(승격을 막는 쪽). 사용자가 그 관계를 기각하면 풀린다 |

- **P3D-D7 마이그레이션은 없다.** 이미 기각된 Dataset에 기대어 `verified`인 행은 이 변경 뒤 읽기에 `no-dataset`이 보이고, R3의 표에 적힌 자리가 그 행을 볼 때 판정된다. 찾아다니며 판정하지 않는다. 한꺼번에 하려면 시작할 때 한 번 도는 판정을 더하는데, 상태를 바꾸는 일이라 따로 정한다.

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다. 완료 기준의 시험은 구현 작업이 쓴다.
- **D1의 글자 집합.** 한글·한자·가나 밖의 띄어 쓰지 않는 글자(태국어 등)는 경계 글자로 남아 `hypothesis` 쪽으로 기운다. 시험하지 않는다.
- **R4의 `JOIN_LEFT`·`JOIN_RIGHT`와 Dataset 자신의 사실.** 같은 함수의 같은 고리라 `MEASURED_ON` 하나로 대표하고 따로 시험하지 않는다.
- **이미 저장된 자료.** 잘못 `explicit`인 행과 기각된 Dataset에 기댄 `verified` 행이 실제 정본에 몇 건인지 세지 않았다.

## 작업 분해

PR 하나, 한 worktree에서 한다. 전체 시험은 PR 직전에 한 번만 돈다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 명령 |
|---|---|---|---|---|---|
| P3D-T1 | 열 이름의 경계 대조와 시험 | C1 | 없음 | `knowledge-engine/src/extraction.ts`, `knowledge-engine/src/extraction-v5.test.ts` | `pnpm exec vitest run knowledge-engine/src/extraction-v5.test.ts` |
| P3D-T2 | `bound()`의 항목 상태 조건과 시험 | C2 | 없음 | `storage/src/analytical-gate.ts`, `storage/src/analytical-gate.test.ts` | `pnpm exec vitest run storage/src/analytical-gate.test.ts storage/src/analytical-claims.test.ts storage/src/analytical-views.read-cost.test.ts` |
| P3D-T3 | 항목 조치의 판정 자리와 시험 | C3 | T2 | `storage/src/analytical-gate.ts`, `storage/src/semantic-user.ts`, `storage/src/analytical-gate.test.ts` | `pnpm exec vitest run storage/src/analytical-gate.test.ts` |

T1과 T2는 서로 다른 패키지라 나란히 할 수 있다. T2와 T3은 같은 두 파일을 고치므로 한 사람이 이어서 한다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #218 첫째 줄과 #209의 "기각된 Dataset 항목" 줄이 판정 규칙이 없어 미뤄져 있었음 |
| 2026-11-24 | D1에 한 문장: 가나·한글·한자의 범위를 Script_Extensions로 정함 | D1 | Phase 3 #5 N2를 [PD3 spec](2026-11-24-PD3-pending-decisions.md)이 처리 |
