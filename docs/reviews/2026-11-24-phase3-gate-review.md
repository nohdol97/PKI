# Phase 3 (Semantic Knowledge) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `80a7962b` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 실제 Provider로 한 추출, Windows 실행, 배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #5 `[Phase 3] Semantic Knowledge` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #22 [S01] Semantic Registry·후보 검증·사용자 교정 보존 | open | site-verify |
| #23 [S02] Entity Resolution·시간 그래프·충돌 처리 | closed | 없음 |
| #24 [S03] Analytical Semantic 후보와 데이터 근거 검증 | closed | 없음 |

에픽 체크박스는 #22 `[ ]`, #23·#24 `[x]`이며 실제 상태(#22 open, #23·#24 closed)와 일치한다. #23·#24는 닫혀 있으나 Windows·배포처 확인(S33·S34)이 남아 있다는 기록이 있어, 닫힌 상태가 "공용 범위 완료"를 뜻하는 것으로 읽어야 한다. #22는 같은 사정인데 열려 있다(일관되지 않음).

작업 단위(S01 T01~T10, S02 T01~T10, S03 T01~T10)는 모두 머지됐다.

## 2. 완료 기준별 증거

### S01 Semantic Registry (#22)

| 기준 | 근거 | 판정 |
|---|---|---|
| S01-C1 상태 전이(candidate/verified/disputed/superseded/rejected)와 변경 감사 이력, 조건 미충족 승격 거부, 사용자 조치 취소는 직전 상태로 복원 | #137 (`5cb64be0`) #144 (`cd384b75`) #169 (`d8a698f4`); `storage/src/semantic-lifecycle.test.ts`, `storage/src/semantic-user.test.ts`, `knowledge-engine/src/auto-verify.test.ts`, `knowledge-engine/src/auto-verify-flow.test.ts`, `backend/src/semantic-api.test.ts` | 증거 있음 |
| S01-C2 명시 사실·사용자 승인·추론·가설을 confidence와 별도 저장, 근거 없는 user override 덮어쓰기 거부, 재추출에도 사용자 교정 유지 | #148 (`a7ab41c0`) #156 (`c7348168`) #161 (`5084800d`); `storage/src/semantic-user-correction.test.ts`, `knowledge-engine/src/reextract-preserve.test.ts`, `knowledge-engine/src/correction-effective.test.ts`, `backend/src/correction-effective.test.ts` | 증거 있음 |
| S01-C3 동의어·약어·한영 표기와 문맥별 정의 보존, ontology 변경의 중복·schema·기존 데이터 영향 검사 | #146 (`dc5910b2`) #152 (`5cb61960`) #170 (`165123f8`) #206 (`1103318b`); `knowledge-engine/src/linking-forms.test.ts`, `knowledge-engine/src/ontology-enforce.test.ts`, `storage/src/ontology.test.ts`, `storage/src/ontology-user.test.ts`, `backend/src/ontology-api.test.ts` | 증거 있음 |
| S01 배포처 확인: 실제 Provider 추출의 Semantic 시나리오, Windows 분기(site-setup S32) | 실행기: #188 (`399d97f6`) `verification/tests/test_s01_semantic_scenario.py`(합성 SQLite 입력). 실행 결과 없음 | 미검증 — 배포처 필요 |

### S02 Entity Resolution·시간 그래프 (#23)

| 기준 | 근거 | 판정 |
|---|---|---|
| S02-C1 요청된 Entity·관계 유형을 versioned schema로 제공 | #155 (`20d447ba`) #166 (`49664e56`) #157 (`3ab9d688`); `packages/contracts/src/knowledge-schema.test.ts`, `knowledge-engine/src/extraction-v4.test.ts`, `storage/src/knowledge-schema.migration.test.ts`, `backend/src/knowledge-schema.api.test.ts` | 증거 있음 |
| S02-C2 식별자·조직·프로젝트·문맥·시간을 쓴 merge 후보, 동명이인 negative, merge undo/split | #163 (`2aad4c1f`) #168 (`95ed98cd`) #185 (`789183a7`) #194 (`e5831866`) #216 (`5e6050b8`); `knowledge-engine/src/entity-resolution.test.ts`, `knowledge-engine/src/link-guard.test.ts`, `knowledge-engine/src/split-reextract.test.ts`, `storage/src/entity-split.test.ts`, `backend/src/entity-api.test.ts` | 증거 있음 |
| S02-C3a valid time과 observed time 구분, SUPERSEDES/CONTRADICTS/SUPPORTS/DERIVED_FROM | #204 (`26cd38a4`) #214 (`d8bc813b`); `backend/src/conflicts-api.test.ts`, `storage/src/assertion-links.test.ts` | 증거 있음 |
| S02-C3b multi-hop 근거 추적, 권한이 교차하는 path 유출 방지 | #214 (`d8bc813b`) #216 (`5e6050b8`) #191 (`9af834d2`); `knowledge-engine/src/graph-read.test.ts`, `backend/src/graph-api.test.ts`, `knowledge-engine/src/scope-extraction.test.ts`, `providers/src/broker.scope-classes.test.ts` | 증거 있음 |
| S02-C3c 범위 교차 증명 표 ④·⑤·⑦·⑧ | 테스트 간략화 규칙에 따라 대표 시험만 두었다고 #23 댓글이 기록. 변이해도 초록인 가드는 #210이 추적 | 미검증 — 보류(대표 시험만 둠, 가드 시험 보강은 열린 이슈 #210) |
| S02 배포처 확인: 개체 해소 실행기 `record`(site-setup S33), Windows 설치본 | 실행기: #214 (`d8bc813b`) `verification/tests/test_s02_entity_scenario.py`(가짜 입력). 실행 결과 없음 | 미검증 — 배포처 필요 |

### S03 Analytical Semantic (#24)

| 기준 | 근거 | 판정 |
|---|---|---|
| S03-C1 문서에서 KPI 정의를 후보로 추출하고 근거 문서·실제 dataset schema와 연결 | #142 (`622c7bc9`) #157 (`3ab9d688`) #164 (`5af6fd40`) #217 (`453a3886`) #230 (`f234f710`); `knowledge-engine/src/tabular-source.test.ts`, `packages/contracts/src/cell-grammar.test.ts`, `knowledge-engine/src/dataset-profile.test.ts`, `knowledge-engine/src/extraction-v5.test.ts`, `backend/src/analytical.e2e-import.test.ts` | 증거 있음 |
| S03-C2 실제 schema·grain·join·집계 검증 없이는 verified 승격 불가, 단위·통화·기간·version 충돌 fixture | #143 (`df35c739`) #186 (`07496f3c`) #208 (`142a823a`) #205 (`6192bdb8`); `knowledge-engine/src/analytical-checks.test.ts`, `knowledge-engine/src/analytical-check-job.test.ts`, `storage/src/analytical-gate.test.ts`, `backend/src/analytical-api.test.ts`, `knowledge-engine/src/conflict-fixtures.test.ts` | 증거 있음 |
| S03-C3 독립 BI·SQL 생성기 없이 Knowledge Semantic 확장과 사용자 검토 UI 계약으로 끝냄 | #228 (`a128e1f7`) #230 (`f234f710`); 결정 기록 `docs/adr/0023-analytical-semantic-rows-and-data-checks.md`, 읽기 계약 시험 `backend/src/analytical-api.test.ts`, `backend/src/analytical-handlers.test.ts`, `packages/contracts/src/analytical-types.test.ts`. 이 기준은 "만들지 않았다"는 부정 사실이라 ADR 0023(결정)과 읽기 계약 시험(Semantic 확장과 검토 UI 계약이 동작함)에 기대며, "SQL 생성기가 없다"를 기계적으로 막는 구조 시험은 없다. ADR과 코드 검토로만 뒷받침된다 | 증거 있음 |
| S03 배포처 확인: 실제 dataset 연결·Windows(site-setup S34, RUNBOOK 12절) | 실행기: #230 (`f234f710`) `verification/tests/test_s03_analytical_scenario.py`(합성 입력). 실행 결과 없음 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(S01·S03) | #207 `#173·#182 후속` 이력 순환 방어·count_distinct 시험·U3·U5, #209 승격 관문 검토 지적(일부는 다른 세션이 후속 묶음으로 착수 선언한 상태), #218 추출 스키마 5 지적, #227 분석 읽기 API 지적(unmet 의미·필드 범위·성능), #229 e2e grain 단언·실행기 집계 범위·문서 정정 |
| 열린 후속 이슈(S02) | #183 묶음 읽기 지적 3건, #192 이름 송신 등급 지적 2건, #193 후보·연결 관문 지적 7건, #210 그래프 읽기 지적 3건, #215 읽기 비용 측정과 D3 문구 보정 |
| 열린 하위 이슈 | #22(`site-verify`). #23·#24는 닫힘 |
| 보류 | 없음(Phase 3 항목에 느린 정규화기 시험은 걸리지 않는다) |
| 의도적으로 하지 않은 것 | Metric/Join을 BI·SQL 엔진으로 확장하지 않음(ADR 0023) |

## 4. 결론

공용 범위에서 확인된 것: S01-C1~C3, S02-C1~C3의 시험 가능한 부분, S03-C1~C3은 머지된 PR과 존재하는 시험 파일로 뒷받침된다. 증거는 합성 fixture와 test double Provider 위의 것이다.

남은 것: 세 작업 모두 배포처 실행(S32·S33·S34)이 남아 있어 실제 Provider 추출 품질과 Windows 동작은 확인되지 않았다. S02-C3의 일부 범위 교차 증명은 대표 시험만 있다. Phase 3의 Gate는 `미검증` 행이 남아 있어 충족되었다고 선언하지 않는다. 이 문서가 확인한 공용 범위에서 S01~S03의 구현은 머지됐고 인용한 시험 파일도 있다. 다만 S02-C3c의 일부 증명 표는 대표 시험만 있어 `보류`로 남아 있으므로 "시험이 다 들어와 있다"고까지는 말하지 않는다.
