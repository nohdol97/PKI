# Phase 6 (Knowledge Experience) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `80a7962b` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 실제 Provider의 답, 실제 코퍼스 측정, Windows·Electron 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #8 `[Phase 6] Knowledge Experience` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #30 [X01] 질문별 Hybrid Retrieval·근거 Q&A | open | site-verify |
| #31 [X02] Knowledge·Explore·Semantic·Evidence 전체 탐색 UX | closed | 없음 |

에픽 체크박스는 #30 `[ ]`, #31 `[x]`이며 실제 상태(#30 open, #31 closed)와 일치한다. #31(closed)의 `blocked` 라벨은 2026-11-24에 제거됐다([색인의 이슈 표류](README.md#이슈-표류) 참고). 구현 작업: X01 #255 (`8c1d4a98`) #259 (`16513bc7`) #261 (`d12ba24b`) #266 (`68a48c0e`) #292 (`e051fcf3`) #303 (`dbe60113`) #311 (`f3ddb240`) #315 (`b1b0e53c`), X02 #267 (`4ca07abc`) #288 (`a502fb6a`) #300 (`a46b4aeb`).

## 2. 완료 기준별 증거

### X01 Hybrid Retrieval·근거 Q&A (#30)

| 기준 | 근거 | 판정 |
|---|---|---|
| X01-C1a 질문별로 keyword/metadata/graph/concept/temporal/wiki/rerank 전략을 고르고, 선호 신호는 순위에만 반영하며 지식 상태를 바꾸지 않음 | #255 (`8c1d4a98`) #266 (`68a48c0e`) #303 (`dbe60113`); `knowledge-engine/src/retrieval/routing.test.ts`, `knowledge-engine/src/retrieval/strategies.test.ts`, `knowledge-engine/src/retrieval/retrieve.test.ts`, `knowledge-engine/src/retrieval/preference.test.ts` | 증거 있음 |
| X01-C1b CLI·embedding 모델이 없어도 keyword 탐색 가능(오프라인) | #255 (`8c1d4a98`); `backend/src/ask-flow.test.ts`, `backend/src/x01-ask-double.e2e.ts` | 증거 있음 |
| X01-C1c `vector` 전략의 질문별 routing | 실제 벡터 색인은 #286 (`874517b3`)이 구현했지만 `vectorIndexing` 옵션과 `vector` 전략은 기본 꺼짐이다(`docs/adr/0026-vector-index-generations.md`). 질의 embedding 전송 정책은 #292 (`e051fcf3`)가 넣었으나 켜진 상태의 실측은 없다 | 미검증 — 보류(기본 꺼짐, 실제 모델 측정 전에는 켜지 않음) |
| X01-C2a 스트리밍 답변·원본 citation·관련 지식 링크·부족/충돌/낡은 근거 표시를 실제 API로 검증 | #255 (`8c1d4a98`) #261 (`d12ba24b`); `backend/src/ask-flow.test.ts`, `backend/src/x01-ask-double.e2e.ts`, `backend/src/x01-ask-seed.e2e.ts`. Provider는 fake | 증거 있음 |
| X01-C2b 취소 | #255 (`8c1d4a98`); `backend/src/ask-flow.test.ts` | 증거 있음 |
| X01-C2c "질문" 화면에서 묻고 인용을 봄 | #259 (`16513bc7`); `apps/web/e2e/ask.e2e.ts`, `apps/web/src/ask.test.tsx` | 증거 있음 |
| X01-C3a 다섯 구성 ablation 실행기와 Recall@5·Precision@5·MRR 비교, 유지 조건 판정 ADR | #255 (`8c1d4a98`); `backend/src/retrieval-ablation.test.ts`, `eval/results/x01-dev-t0.json`, `eval/results/x01-dev-t0-no-vector.json`, `docs/adr/0025-retrieval-strategies.md`. 측정은 T0(방해 문서 없음)·라벨에서 심은 지식·Provider 없음 조건이다 | 증거 있음 |
| X01-C3b groundedness·citation accuracy 측정, 실제 추출 코퍼스(T1)에서의 단계 선택 판정 | ADR 0025가 "잠정 — 배포처 검증 대기"로 명시. 측정 파일에 해당 지표가 없다 | 미검증 — 배포처 필요 |
| X01-C4a 검색 결과·답 생성 직전에 access_scope·tombstone·전송 정책 재검사, 거부된 자료가 답·citation·로그에 없음 | #255 (`8c1d4a98`) #311 (`f3ddb240`) #315 (`b1b0e53c`); `backend/src/ask-gate.test.ts`, `knowledge-engine/src/retrieval/retrieve.test.ts`, `backend/src/read-gate.test.ts` | 증거 있음 |
| X01-C4b provider로 보내는 문맥은 허용 범위의 최소 payload | #255 (`8c1d4a98`); `backend/src/ask-gate.test.ts`, `providers/src/broker.answer.test.ts`, `tooling/docs/site-setup-x01.test.ts` | 증거 있음 |
| X01 배포처 확인: 실제 Provider의 답·인용 정확도(S37), 질문 글의 전송 등급(S38), 실제 벡터 구현(S39), Windows·Electron "질문" 화면(S41) | 실행 결과 없음 | 미검증 — 배포처 필요 |

### X02 탐색 UX (#31, closed)

| 기준 | 근거 | 판정 |
|---|---|---|
| X02-C1 Home/Knowledge/Explore/Semantic/Ask/Sources/Activity/Settings를 실제 backend로 연결 | #267 (`4ca07abc`) #46 (`431ab92e`) #259 (`16513bc7`); `apps/web/src/nav.test.tsx`, `apps/web/src/ask.test.tsx`, `apps/web/e2e/screens.e2e.ts`, `apps/web/e2e/explore.e2e.ts`, `apps/web/e2e/wiki.e2e.ts`. "mock-only 화면이 없음" 자체를 막는 시험은 따로 없다(화면별 e2e가 실제 backend를 쓴다는 점이 증거) | 증거 있음 |
| X02-C2a 이름 검색·bounded 이웃·timeline·원본 version evidence viewer·backlink round trip | #267 (`4ca07abc`) #300 (`a46b4aeb`); `backend/src/explore-api.test.ts`, `backend/src/explore-read.test.ts`, `apps/web/src/explore.test.tsx` | 증거 있음 |
| X02-C2b 가려진 항목이 응답·로그·순서에 나타나지 않음(부정 시험) | #267 (`4ca07abc`) #311 (`f3ddb240`) #315 (`b1b0e53c`); `backend/src/explore-gate.test.ts`, `backend/src/read-gate.test.ts` | 증거 있음 |
| X02-C2c 후보 승인·교정·충돌 검토와 정리 기능(합치기·나누기·유효 기간) | #267 (`4ca07abc`) #288 (`a502fb6a`); `apps/web/src/semantic-review.test.tsx`, `apps/web/src/entity-curation.test.tsx`, `backend/src/curation-api.test.ts`, `backend/src/curation-gate.test.ts`, `apps/web/e2e/explore-curation.e2e.ts` | 증거 있음 |
| X02-C3a empty/loading/error 상태와 대량 데이터 pagination, 키보드로 고르기 | #267 (`4ca07abc`) #288 (`a502fb6a`); `apps/web/src/explore.test.tsx`, `apps/web/src/paged-list.test.tsx`, `apps/web/e2e/explore.e2e.ts` | 증거 있음 |
| X02-C3b 접근성 자동 점검(axe)과 키보드만으로 가는 흐름 | #325 (`80a7962b`); `apps/web/e2e/a11y.e2e.ts`(메뉴 열한 화면과 근거 원본을 연 탐색 화면을 axe WCAG 2.1 A·AA로 검사, `serious`·`critical` 위반 0건이 통과선, 키보드만으로 메뉴→탐색→항목→근거 제목에 초점이 닿는 흐름 하나), `docs/specs/2026-11-24-A11Y-accessibility-audit.md`. 점검 도구가 판정하지 못한 글자 명암비(홈·위키·탐색 근거)는 spec 남김 표에 적혀 있고 위반 0건에 세지 않았다 | 증거 있음 |
| X02-C3b 화면 낭독기 실제 낭독, Windows 화면 배율(125·150%)·고대비 모드, Electron·설치본에서의 점검 | #325가 "미검증"으로 남김(spec 미검증 범위). 자동 점검은 브라우저에서만 돌았다 | 미검증 — Windows 필요 |
| X02-C3c 주요 시나리오 E2E의 Electron·Windows 실행 | 탐색 E2E는 브라우저만 돈다(X02 spec C3b "브라우저만"). Electron·Windows는 H02로 넘겼다 | 미검증 — Windows 필요 |
| X02 배포처 확인(site-setup S42) | 실행 결과 없음 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(X02) | #268 탐색 UX 넘긴 기능과 검토 지적, #283 X02B 정리 기능 검토 지적 |
| 열린 후속 이슈(X01) | #291 검색·벡터 후속 묶음 후속(남은 항목·낮은 지적), #302 검색 전략 선행 조건 묶음 검토 지적, #310 읽기 가시성 후속 묶음 검토 지적 |
| 열린 화면 작업(교차) | #308 UI01 후속(검토의 남은 지적과 미검증 항목; 묶음 UI01F는 PR #319 (`0a4b8bff`), UI01G는 PR #323 (`3fa8f58b`)로 머지됐으나 이슈는 아직 open), #290 보류·기록(구현하지 않고 기록만). 화면 디자인 #281은 PR #307 (`8bd2cc52`)로 머지되어 closed이며, `apps/web/**` 전체를 바꿨으므로 이 문서의 화면 시험 경로는 머지 뒤 트리에서 다시 확인했다 |
| 열린 하위 이슈 | #30(`site-verify`). #31은 closed |
| 보류 | `vector` 전략 기본 꺼짐(X01-C1c) |
| 의도적으로 하지 않은 것 | #290(임원용 화면 조사의 기능 후보)은 구현하지 않고 기록만 하기로 함 |

## 4. 결론

공용 범위에서 확인된 것: 질문별 검색 전략과 오프라인 keyword 탐색, 근거 Q&A의 스트리밍·취소·citation·읽기 문 재검사, 화면 연결과 탐색·검토·정리 흐름, 가려진 항목이 새지 않는 부정 시험은 머지된 PR과 존재하는 시험 파일로 뒷받침된다. 증거는 fake Provider와 T0 합성 코퍼스 위의 것이다.

남은 것: 접근성은 자동 점검(axe)만 있고 화면 낭독기·Windows 배율·고대비·설치본 점검은 확인되지 않았다. `vector` 전략은 기본 꺼짐이고, 실제 Provider의 groundedness·citation 정확도와 실제 코퍼스 ablation, Electron·Windows 실행은 확인되지 않았다. 이 Phase의 Gate는 충족되었다고 선언하지 않는다.
