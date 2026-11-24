# Phase 4 (Knowledge Consolidation) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `80a7962b` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 실제 Provider로 한 요약·의견, Windows 실행, 배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #6 `[Phase 4] Knowledge Consolidation` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #25 [K01] 근거 기반 LLM Wiki·Backlink·재생성 | open | in-progress |
| #26 [K02] Reflection·Consolidation·Knowledge Lint | open | site-verify |

에픽 체크박스 두 개가 모두 `[ ]`이고 실제도 모두 open이라 일치한다. 구현 작업(K01-T1·T2, K02-T1~T3)은 머지됐다. K01-T3(`metrics` 페이지)는 하지 않기로 했다.

## 2. 완료 기준별 증거

### K01 Wiki 투영 (#25)

| 기준 | 근거 | 판정 |
|---|---|---|
| K01-C1 항목 유형별 페이지 열두 종류와 index·log | #219 (`18e0b958`); `knowledge-engine/src/wiki-render.test.ts`, `knowledge-engine/src/wiki-kind.test.ts`, `storage/src/wiki.test.ts` | 증거 있음 |
| K01-C1 중 `metrics` 페이지의 분석 검사 결과 | K01-T3를 하지 않기로 함. `MetricView`에 유효 기간·대체·모순 상대가 아직 없다(K01 spec D10, #25 댓글). 페이지 종류는 있으나 검사 결과가 비어 있다는 것이 spec 시험의 기대값이다 | 미검증 — 보류(K01-T3 하지 않음, 읽기 계약이 넓어지면 다시 판단) |
| K01-C2a 관련 페이지 검색→증분 변경·신규 생성, cross-reference·backlink·근거·충돌 표시·변경 이력을 실제 입력으로 검증 | #219 (`18e0b958`) #236 (`ca7e45f7`) #269 (`620dabad`); `backend/src/wiki-flow.test.ts`, `backend/src/wiki-gate.test.ts`, `storage/src/wiki.test.ts` | 증거 있음 |
| K01-C2b 화면에서 페이지를 열고 근거·backlink·메모 확인 | #219 (`18e0b958`); `apps/web/e2e/wiki.e2e.ts`, `apps/web/src/wiki.test.tsx` | 증거 있음 |
| K01-C3a 부분 쓰기 실패 복구 | #219 (`18e0b958`); `knowledge-engine/src/wiki-build-job.test.ts` | 증거 있음 |
| K01-C3b 원본 삭제와 access_scope 승계 반영 | #219 (`18e0b958`) #236 (`ca7e45f7`) #269 (`620dabad`); `backend/src/wiki-gate.test.ts`, `backend/src/wiki-flow.test.ts`, `backend/src/scope-policy.test.ts` | 증거 있음 |
| K01-C3c 같은 knowledge revision에서 재생성해도 내용 해시가 같고 사용자 메모·숨김이 유지 | #219 (`18e0b958`); `backend/src/wiki-flow.test.ts`, `knowledge-engine/src/wiki-build-job.test.ts` | 증거 있음 |
| K01-C4 LLM 요약(spec이 더한 기준): 인용문이 원문에 있는 문장만 저장, 동의 없으면 held | #226 (`f6b27be4`); `knowledge-engine/src/wiki-summary-job.test.ts`, `providers/src/broker.wiki-summary.test.ts`; 동의 없으면 held는 `backend/src/wiki-flow.test.ts`의 "② without consent the job is held, no Provider is asked, the page says `held`; with consent it becomes `ready`", 설정이 꺼져 있으면 작업이 없음은 같은 파일의 "③ with the setting off (the default) queues no summary job and the page says `off`". 시험은 fake Provider로 돈다 | 증거 있음 |
| K01-C5 한 페이지의 변경 수 줄별 가리기(공개 주장 → 거부 범위 주장이 더해졌다 빠짐 → 공개 주장 추가; 빠진 수는 모든 줄에서 0) | #269 (`620dabad`); `backend/src/wiki-gate.test.ts`의 "gives a line's added count only while no later line of the page removed a claim, and never a removed count (K01-R18 1, C5)" | 증거 있음 |
| K01-C6 관계 끝이 숨은 구성원이면 관계 주체 페이지의 생성 줄 변경 수가 0 | #269 (`620dabad`); `backend/src/wiki-gate.test.ts`의 "gives no change count for a page whose relation claim names an end the reader cannot see (K01-R18 2, C6)" | 증거 있음 |
| K01-C7 사용자가 만든 항목의 만들기를 되돌리면 그 항목과 Insight의 페이지·계보 행이 지워짐 | #269 (`620dabad`); `storage/src/wiki.test.ts`의 "leaves no page, lineage or link row for the item or for the Insight that went with it" | 증거 있음 |
| K01 실제 Provider의 요약 품질·Windows 설치본(site-setup 해당 절) | 실행 결과 없음 | 미검증 — 배포처 필요 |

### K02 Reflection·Consolidation·Lint (#26)

| 기준 | 근거 | 판정 |
|---|---|---|
| K02-C1 동의어·중복·상충·오래된 관계·미해결 업무를 재검토해 신규 연결을 발견하는 고정 fixture | #248 (`06b5caf4`); `knowledge-engine/src/lint-rules.test.ts`, `backend/src/lint-flow.test.ts`, `backend/src/k02-seed.e2e.ts` | 증거 있음 |
| K02-C2a 후보 생성과 승인 적용 분리, oscillation 방지, 자기 생성 문서를 새 근거로 쓰지 않음 | #248 (`06b5caf4`) #282 (`72cd2587`); `knowledge-engine/src/reflect-job.test.ts`, `knowledge-engine/src/lint-decide.test.ts`, `backend/src/lint-gate.test.ts` | 증거 있음 |
| K02-C2b 예산 초과 시 진행을 저장하고 이어 감 | #248 (`06b5caf4`); `knowledge-engine/src/reflect-job.test.ts` | 증거 있음 |
| K02-C3a daily·weekly 주기와 범위 제한(전체 corpus 무조건 재처리 없음) | #248 (`06b5caf4`); `storage/src/reflection.test.ts`, `backend/src/lint-flow.test.ts` | 증거 있음 |
| K02-C3b lint 결과·근거·오탐/미탐 기록, 원본 삭제와 범위 거부에 따른 발견 정리 | #248 (`06b5caf4`) #282 (`72cd2587`) #306 (`70fd7bff`); `backend/src/lint-gate.test.ts`, `knowledge-engine/src/lint-kind.test.ts`, `storage/src/reflection.test.ts` | 증거 있음 |
| K02-C3c 화면에서 발견을 보고 근거를 열고 닫음 | #248 (`06b5caf4`); `apps/web/e2e/lint.e2e.ts` | 증거 있음 |
| K02-C4 LLM 의견(`reflection-refine`, spec이 더한 기준): 인용문이 원문에 있는 판정만 저장, 동의 없으면 held | #272 (`9a16dc03`); `knowledge-engine/src/reflection-refine-job.test.ts`, `providers/src/broker.reflection-refine.test.ts`, `backend/src/lint-opinion.test.ts`. 시험은 fake Provider로 돈다 | 증거 있음 |
| K02 실제 Provider·동의 흐름, Windows(site-setup S43) | 실행 결과 없음. #26 댓글이 "미검증: 실제 Provider·동의 흐름, Windows"로 기록 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(K01) | #220 Wiki 투영 검토 지적, #225 Wiki 요약 검토 지적, #235 정확성 수정 검토 지적 |
| 열린 후속 이슈(K02) | #247 재검토·점검 검토 지적(U1~U5, 시험 보강·비용 측정·문구 항목) |
| 열린 하위 이슈 | #25(`in-progress`), #26(`site-verify`) |
| 보류 | 없음(느린 정규화기 시험은 이 Phase에 걸리지 않는다) |
| 의도적으로 하지 않은 것 | K01-T3 `metrics` 페이지(구현 세션이 #25 댓글과 K01 spec D10에 사유와 함께 기록한 결정) |

## 4. 결론

공용 범위에서 확인된 것: Wiki 투영(K01-C1 대부분, C2a·b, C3a·b·c, C4~C7)과 Reflection·Lint(K02-C1, C2a·b, C3a·b·c, C4)는 머지된 PR과 존재하는 시험 파일로 뒷받침된다. 증거는 fake Provider와 합성 fixture 위의 것이다.

남은 것: `metrics` 페이지의 분석 검사 결과는 하지 않기로 해서 K01-C1 전체를 통과로 볼 수 없다. 실제 Provider의 요약·의견 품질과 Windows 동작은 배포처에서만 확인된다. 열린 후속 이슈가 남아 있다. 따라서 Phase 4의 Gate는 충족되었다고 선언하지 않는다.
