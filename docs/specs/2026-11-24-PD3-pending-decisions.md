# 스펙: 결정 대기 묶음 3(PD3) — 지워진 해석의 재요청, 복합 값의 원소 상한, 장음 부호의 경계

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D5 포함)
- 관련: 이슈 #183(F5), #232(U4·D1-U7), #263(같은 개정 번호 줄), #218(첫째·셋째 줄), Phase 3 #5(N2). [P01 spec](2026-11-23-P01-insight-discovery.md)(P01-D13·D14), [P3F spec](2026-11-24-P3-followups.md)(P3F-D5), [P3D spec](2026-11-24-P3D-pending-decisions.md)(P3D-R1·D1), [I02F spec](2026-11-24-I02F-followups.md)(I02F-R5·D5), [MGV spec](2026-11-24-MGV-member-visibility-followups.md)(MGV-R1), [P5F spec](2026-11-24-P5-followups.md)(30행이 D1-U7을 넘김), [RDF spec](2026-11-24-RDF-remaining-defects.md)(47행이 U4를 넘김)
- 번호: 요구사항 `PD3-R<n>`, 완료 기준 `PD3-C<n>`, 결정 `PD3-D<n>`, 작업 `PD3-T<n>`. **마이그레이션과 계약 변경은 없다.**
- 기준 코드: `origin/main` `3d4528b5`. 아래의 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

| 말 | 뜻 |
|---|---|
| 해석 | 설정 `insight.interpret`이 켜졌을 때 모델이 Insight에 붙이는 이유 요약·영향·행동성 세 열(`llm_*`) |
| 기준 | 해석을 요청한 때의 Insight 내용의 해시. 작업 대상이 `<Insight id>#<기준>`이고, 한 번 시도한 기준은 다시 요청하지 않는다(P01-D14) |
| 복합 값 | 분석 값 유형 가운데 여러 조각으로 된 것: `column-set`(열 이름 목록), `key-pairs`(열 이름 짝 목록) |

## 배경

선언한 네 이슈의 결정 대기 줄과 #5의 N2를 코드와 대조했다.

| 건 | 분류 | 지금 코드에서 확인한 것 |
|---|---|---|
| #183 F5: 숨은 가운데 항목 때문에 보이는 `mergeId`로 풀기가 404 | 이미 반영(#310) | MGV-R1이 "길 전체가 보일 때만 구성원을 싣는다"로 닫는 쪽을 정했다(MGV-D1). A→B→C에서 B가 숨으면 A는 C 아래에 실리지 않으므로(`backend/src/read-gate.ts:318`~`:365`) A의 `mergeId`가 어느 응답에도 나가지 않는다. 시험: `backend/src/semantic-api.test.ts:334`, `backend/src/explore-read.test.ts:134`. 풀기의 닫힌 검사(`backend/src/server.ts:1139`~`:1144`)는 그대로 맞다 |
| #232 D1-U7: 삭제·정리·범위 변경 뒤 해석이 영영 다시 채워지지 않음 | 고침(R1) | `insight` 종류의 `invalidate`가 모은 Insight의 해석을 비운다(`knowledge-engine/src/canonical-kinds.ts:545`~`:551`). Insight 자신의 내용은 그대로라 기준도 그대로이고, 그 기준은 이미 시도됐으므로 `requestInsightInterpretations`가 다시 요청하지 않는다(`storage/src/insight-interpretation.ts:106`~`:110`). 모으는 범위가 "원본이 닿은 항목과 그 묶음의 모든 Insight"(`canonical-kinds.ts:523`~`:538`)라서, 정리(prune)가 돌 때마다 해석이 쌓여 사라진다. 설정을 켠 사용자에게 기능이 조용히 줄어든다 |
| #232 U4: 읽지 않은 활성 Insight를 한도 없이 읽음 | 이슈에 둠(측정) | `insight-interpretation.ts:91`~`:99`가 해당 행을 모두 읽지만 짧은 열 넷이고, 설정이 꺼져 있으면 읽지 않으며(`:89`), 넣는 작업 수는 한도가 있다(`:102`). 느리다는 관측이 없다(RDF 47행과 같은 판단) |
| #263 같은 개정 번호에서 첨부만 더한 다시 가져오기가 `revision-conflict` | 결정: 그대로 둠(D3) | `storage/src/sources.ts:213`~`:221`. 개정 번호는 내보내는 쪽이 주는 줄의 `version`이다(`packages/connector-sdk/src/jsonl.ts:96`~`:104`). 거절은 이유와 함께 보이고(`backend/src/page-store.ts:297`~`:299`), 내보내는 쪽이 번호를 올리면 받아들여진다. 계약 문장(`packages/contracts/src/import-record.ts:64`)과 같다 |
| #218 첫째 줄: 열 이름이 다른 낱말 안에서 맞음 | 이미 반영(#330) | P3D-R1, `knowledge-engine/src/extraction.ts:211`~`:220`(`namedAtBoundary`) |
| #218 셋째 줄: `column-set`·`key-pairs`의 원소 수 상한 없음 | 고침(R2) | `storage/src/analytical-types.ts:153`~`:172`에 원소 수 검사가 없다. 사용자 경로의 조각은 계약이 50개로 막지만(`packages/contracts/src/analytical-types.ts:182`~`:185`), 추출 경로(`extraction.ts:585`, 같은 판정 `storage/src/ontology.ts:214`)는 Provider 응답 크기(1~2 MiB)만 막는다. 값의 글자 수 상한도 없다(`providers/src/tasks.ts:147`). P3F-D5가 고칠 자리와 수를 이미 적어 두었다 |
| #5 N2: U+30FC "ー"가 라틴 문자 옆에서 경계 글자로 셈 | 고침(R3) | `extraction.ts:206`이 `Script=`로 가나를 고르는데 "ー"는 Script가 Common이라(Script_Extensions가 히라가나·가타카나) 빠진다. "ユーザーid"의 `id`가 경계를 못 세워 `hypothesis`로 떨어진다. P3D-D1의 규칙("가나는 경계 글자가 아니다")과 다르다 |

## 목표

- 원본 삭제·정리·범위 변경으로 비워진 해석은, 설정이 켜져 있으면 한 번 다시 요청된다.
- 복합 값은 원소 50개까지만 값으로 받아들인다. 사용자 경로와 추출 경로가 같다.
- 가나의 장음 부호는 가나와 같이 경계 글자에서 빠진다.

## 하지 않는 것

- 마이그레이션, 계약(`packages/contracts`), `backend/src/server.ts`, `apps/web`의 변경.
- 해석 기준의 정의(`insightBasis`) 바꾸기(D1이 고른 길이 아니다), U4의 읽기 한도.
- #263의 같은 개정 번호 판정 바꾸기(D3), #183 F5·#218 첫째 줄(이미 반영).
- 이미 저장된 원소 50개 초과 값을 찾아 고치는 일(D4).
- 네 이슈의 나머지 줄(아래 「이슈에 두는 것」).

## 요구사항

- **PD3-R1 지워진 해석은 한 번 다시 요청한다.** `insight` 종류의 `invalidate`가 해석을 비울 때, **비우기 전에 해석이 있던** Insight의 번호를 모은다. 같은 `invalidate`가 Insight를 다시 판정한 뒤(`recomputeInsights`, `canonical-kinds.ts:586`), 모은 번호마다 다음이 모두 참이면 `insight-interpret` 작업을 `<id>#<지금 기준>` 대상으로 하나 넣는다: 설정이 켜져 있다, Insight가 활성이다, 유형이 `opportunity`가 아니다, 해석이 비어 있다.
  - "이미 시도한 기준" 검사(`insight-interpretation.ts:106`)를 이 경로에서만 건너뛴다. 그 작업이 해석 없이 닫히면 그 뒤는 지금처럼 다시 묻지 않는다(재시도 폭주 없음, P01-D14 그대로).
  - 같은 대상의 열린 작업이 있으면 넣지 않는다(`registerJob`의 `ON CONFLICT DO NOTHING`).
  - 새 version(`new-version`)은 지금처럼 해석을 비우지 않으므로 이 경로도 타지 않는다.
- **PD3-R2 복합 값은 원소 50개까지다.** `normalizeValue`의 `column-set`과 `key-pairs`는 목록의 원소가 50개를 넘으면 `null`(값이 아님)이다. 상한은 계약의 조각 상한과 같은 수이고, 계약처럼 중복을 없애기 전의 목록 길이로 센다(중복이 있는 목록은 어차피 값이 아니다. RPF-R4). 추출은 이 값을 지금처럼 버리고(`drops.other`), 사용자 경로는 `misfit`이다.
- **PD3-R3 장음 부호는 경계 글자가 아니다.** `extraction.ts`의 띄어 쓰지 않는 글자 판정을 `Script=`에서 `Script_Extensions=`(한글·한자·히라가나·가타카나)로 바꾼다. "ー"(U+30FC)와 반각 "ｰ"(정규화 뒤 같은 글자)가 경계 글자에서 빠진다.

### 바꾸는 자리

| 요구사항 | 파일 | 바꾸는 것 |
|---|---|---|
| R1 | `storage/src/insight-interpretation.ts`, `storage/src/index.ts` | 번호 목록을 받아 R1의 네 조건을 보고 작업을 넣는 함수 하나와 내보내기 한 줄. 머리 주석 한 줄 |
| R1 | `knowledge-engine/src/canonical-kinds.ts` | `:545`~`:551`의 비우기에서 해석이 있던 번호를 모으고, `:586`의 다시 판정 뒤 위 함수를 부른다. `:542`~`:543` 주석을 맞춘다 |
| R1 | `knowledge-engine/src/insight-interpret-deletion.test.ts` | C1 시험 하나 |
| R2 | `storage/src/analytical-types.ts`, `storage/src/analytical-types.test.ts` | 두 함수에 원소 수 검사와 상수 하나, C2 시험 하나 |
| R3 | `knowledge-engine/src/extraction.ts`, `knowledge-engine/src/extraction-v5.test.ts` | `:206` 한 줄, C3 경우 하나(P3D-C1 시험 옆) |
| 문서 | 아래 「앞선 spec에 고치는 문장」의 네 spec, `docs/README.md` | 문장과 변경 이력 한 줄씩, 색인 한 줄 |

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| PD3-C1 | 설정을 켠 상태에서 해석이 있는 활성 Insight와, 그 대상 `<id>#<기준>`에 이미 닫힌(`succeeded`) `insight-interpret` 작업이 있을 때, 그 Insight의 계보에만 있는 원본을 지우면 해석이 비고 같은 대상의 `queued` 작업이 하나 생긴다. 설정을 끈 같은 상황에서는 새 작업이 없다(R1) | `knowledge-engine/src/insight-interpret-deletion.test.ts`(기존 `seed` 사용) |
| PD3-C2 | `normalizeValue("column-set", 서로 다른 열 이름 50개)`는 값이고 51개는 `null`이다. `key-pairs`도 짝 51개는 `null`이다(R2) | `storage/src/analytical-types.test.ts`(`analytical.value-types` 묶음) |
| PD3-C3 | 열 `id`를 가리키는 값과 인용문 "ユーザーid 목록"을 받은 추출은 그 사실을 `explicit`으로 저장한다(R3) | `knowledge-engine/src/extraction-v5.test.ts`(P3D-C1 시험 옆) |

경계값·조합의 전수 시험은 하지 않는다(삭제 하나로 정리·범위 변경을, `column-set` 50·51과 `key-pairs` 51로 상한을, 장음 부호 하나로 Common 글자를 대표한다). 변이 확인은 요구하지 않는다: R1의 송신을 막는 가드는 처리기의 설정 검사(`knowledge-engine/src/insight-interpret.ts:65`)이고 고치지 않는다. R2·R3은 값 판정 규칙이다. 기존 시험은 고치지 않고 통과해야 한다.

## 앞선 spec에 고치는 문장

같은 PR이 함께 고친다(문서만).

| 자리 | 고친 것 |
|---|---|
| P01-D13 | "비운 해석은, 비우기 전에 해석이 있었고 설정이 켜져 있으면 한 번 다시 요청한다(PD3-R1)" 한 문장 |
| P3F-D5 | 셋째 항목(원소 수 상한)을 PD3-R2가 넣었다는 가리킴 한 문장 |
| P3D-D1 | 가나의 범위를 Script_Extensions로 정했다는 한 문장(PD3-R3) |
| I02F-D5 | PD3-D3이 이 결정을 유지했다는 가리킴 한 문장 |
| 위 네 spec의 변경 이력 | 한 줄씩 |

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| PD3-D1 | 기준 해시를 바꾸지 않고, 비운 자리에서 작업을 직접 한 번 넣는다 | 이슈가 적은 대안(기준에 계보 version을 넣기)은 범위 변경(version이 그대로)과 "닿은 항목 묶음" 쪽 Insight를 놓치고, 정의가 바뀌는 순간 예전에 실패한 Insight 전부가 한꺼번에 다시 요청된다. 직접 넣으면 세 사건(삭제·정리·범위 변경)을 같이 덮고 새 열이 들지 않는다 | `canonical-kinds.ts`의 함수 호출 한 줄을 지우면 전으로. 계보 방식으로 가려면 `insightBasis`에 Insight·X·Y 계보 version을 더하고 그 호출을 지운다 |
| PD3-D2 | 다시 요청하는 것은 비우기 전에 해석이 있던 Insight뿐이고, 한 사건의 작업 수에 따로 한도를 두지 않는다 | Provider 호출은 사라진 해석의 수를 넘지 않는다(처음 해석 때 이미 그만큼 불렀다). 해석이 없던 Insight는 지금 규칙(P01-D14)대로다. 한도를 두면 넘친 Insight가 다시 영영 빠진다 | 함수에 `INSIGHT_INTERPRET_BATCH` 한도를 걸거나, 비우기 전 해석 조건을 빼서 모은 Insight 전부를 넣는다 |
| PD3-D3 | #263: 같은 개정 번호에서 첨부만 다르면 지금처럼 `revision-conflict`다(I02F-D5 유지) | 개정 번호 하나는 원본의 한 상태다(I01-R10). 거절은 이유와 함께 보이고 번호를 올리면 받아들여진다. 받아들이면 한 번호에 version이 둘 생겨 이후의 같은 번호 판정이 모호해진다 | `sources.ts:220`에서 "해시가 같고 저장된 첨부가 없을 때"를 새 version으로 받는 가지를 더하고 I02F-R5를 고친다 |
| PD3-D4 | 이미 저장된 원소 50개 초과 값은 찾지도 고치지도 않는다 | 합성 자료 밖에서 관측되지 않았고, 고치려면 사실 줄을 다시 써야 한다. 그런 줄은 분석 검사(`knowledge-engine/src/analytical-check-job.ts:229`)가 값이 아닌 것으로 읽어 검사가 실패로 끝난다(닫힌 쪽). 그 사실 종류의 유형 정의 변경도 새 규칙이 같은 값 유형을 유지하는 동안 그 줄을 어긋남으로 세어 적용할 수 없다(`existing-data-violation`, RPF-D1이 유지). 막힐 뿐 데이터 유실은 없다 | 시작할 때 한 번 두 유형의 사실을 훑어 `normalizeValue`가 `null`인 줄을 `rejected`로 바꾼다 |
| PD3-D5 | R3은 네 글자 체계를 Script_Extensions로만 넓힌다 | 경계 글자에서 빠지는 글자는 Script가 Common이고 Script_Extensions가 한글·한자·히라가나·가타카나인 **한중일 공통 글자 53자**다: "ー"·반각 "ｰ"·"〆"·반복 부호(〱~〵)·반각 탁점(ﾞﾟ)·한문 숫자(㆒~㆕)·괄호·원 안 한자 숫자(㈠~㈩, ㊀~㊉)·산가지 숫자(𝍠~𝍱). 라틴 문자·숫자·밑줄은 그대로다(`node`로 확인, RPF-R5). P3D-D1의 뜻 그대로다 | `extraction.ts:206`을 `Script=`로 되돌린다 |

## 이슈에 두는 것

| 줄 | 사유 | 남는 곳 |
|---|---|---|
| #232 U4(읽지 않은 활성 Insight를 한도 없이 읽음) | 측정 먼저. 느리다는 관측이 없다 | #232 |
| #183 F2(N+1), F3(개수의 뜻) | 측정(#215로 옮김)·문구 | #215, #183 |
| #263 F-3·F-4·F-5 | 시험 보강 | #263 |
| #218 둘째(전송 시험 대조군)·넷째(CSV fixture) | 시험 보강 | #218 |
| #5 N1·N3 | N1은 BGL(#332)이 다룸, N3은 시험 보강 | #209, #5 |

이 PR이 머지되면 #183 F5, #232 D1-U7, #263의 같은 개정 번호 줄, #218 첫째·셋째 줄, #5 N2를 각 이슈에서 닫는다(F5·#218 첫째는 이미 반영으로).

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다(R3의 글자 판정만 `node`로 확인). 완료 기준의 시험은 구현 작업이 쓴다.
- **R1의 정리·범위 변경.** 같은 `invalidate` 가지라 삭제 하나로 대표한다.
- **R1과 설정을 끈 동안의 사건.** 해석이 있던 Insight가 설정이 꺼진 동안 비워지면, 나중에 켜도 그 기준은 이미 시도된 것이라 다시 요청되지 않는다(D2의 한계, 시험하지 않음).
- **R1의 작업 깨우기.** 넣은 작업은 실행기의 주기 깨우기로 집힌다고 읽었다(`backend/src/job-runner.ts:288`). e2e로 확인하지 않는다.
- **R2의 기존 자료**(D4). 실제 자료에서 원소 50개를 넘는 줄 수는 모른다.
- 실제 Provider로 R1의 호출 수를 재지 않았다. Windows·Electron 설치본.

## 작업 분해

PR 하나, 한 worktree, 구현자 한 명이 차례로 한다. 전체 시험은 PR 직전에 한 번만 돈다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 명령 |
|---|---|---|---|---|---|
| PD3-T1 | 지워진 해석의 재요청과 시험 | C1 | 없음 | `storage/src/insight-interpretation.ts`, `storage/src/index.ts`, `knowledge-engine/src/canonical-kinds.ts`, `knowledge-engine/src/insight-interpret-deletion.test.ts` | `pnpm exec vitest run knowledge-engine/src/insight-interpret-deletion.test.ts knowledge-engine/src/insight-interpret.test.ts storage/src/insight-interpretation.test.ts` |
| PD3-T2 | 복합 값의 원소 상한과 시험 | C2 | 없음 | `storage/src/analytical-types.ts`, `storage/src/analytical-types.test.ts` | `pnpm exec vitest run storage/src/analytical-types.test.ts storage/src/analytical-values.test.ts` |
| PD3-T3 | 장음 부호의 경계와 시험 | C3 | 없음 | `knowledge-engine/src/extraction.ts`, `knowledge-engine/src/extraction-v5.test.ts` | `pnpm exec vitest run knowledge-engine/src/extraction-v5.test.ts` |
| PD3-T4 | 앞선 spec 네 건의 문장과 `docs/README.md` 색인 한 줄 | — | T1~T3 | `docs/specs/`의 P01·P3F·P3D·I02F, `docs/README.md` | `pnpm exec vitest run tooling/docs` |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #183·#232·#263·#218의 결정 대기 줄과 #5 N2를 코드와 대조해, 세 줄을 고치고 한 줄을 결정으로 닫고 두 줄을 이미 반영으로 분류함. 사용자가 잠정 결정을 위임 |
| 2026-11-24 | R2에 "중복 제거 전 목록 길이로 센다", D4에 유형 정의 변경도 막힌다는 사실, D5의 제외 글자를 한중일 공통 글자 53자로 고쳐 적음 | PD3-R2·D4·D5 | #340 F1·F2·F3, [RPF spec](2026-11-24-RPF-restore-pd3-followups.md) |
