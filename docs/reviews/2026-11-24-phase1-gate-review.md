# Phase 1 (Vertical Slice) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `d1384090` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. Windows 설치본·실제 Provider·배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다. 기본 `pnpm test`가 돌리는 시험과 `pnpm e2e`의 시험을 모두 "시험"으로 쓴다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #3 `[Phase 1] Vertical Slice` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #16 [V01] 공통 웹·API·Provider와 로컬 데이터 수직 골격 | open | site-verify |
| #17 [V02] 3개 출처 연결→일정 위험 Insight→근거 UI 수직 검증 | open | site-verify |

에픽 체크박스는 #16·#17이 모두 `[ ]`이고 실제도 open이라 일치한다. 두 이슈 본문의 진행 로그는 "미착수"로 남아 있으나(댓글에 실제 진행이 있음) 이는 본문 갱신 누락이다.

작업 단위(V01 T01~T17, V02 T01~T12)는 모두 머지됐다. 주요 PR: V01 #41 (`e8e73bbe`) #42 (`5704c597`) #43 (`dc4a2850`) #44 (`1cf67f5d`) #45 (`18fc69c7`) #46 (`431ab92e`) #47 (`b3e1befe`) #48 (`3d2f6716`) #49 (`7363302d`) #50 (`aca4f569`) #51 (`5eab4ae0`) #52 (`25c3f73d`) #56 (`feab8ad7`) #67 (`13cd52d3`) #73 (`e0ed81db`) #77 (`7133e8c1`) #81 (`a843c5b7`), V02 #53 (`b01cefab`) #55 (`05921be4`) #58 (`9cda5405`) #62 (`43278d28`) #63 (`602ebcc3`) #65 (`64baba01`) #66 (`c615b6f3`) #68 (`5052c525`) #69 (`11b81e68`) #70 (`d41b1b4a`) #76 (`2992a33f`) #82 (`a8078c50`).

## 2. 완료 기준별 증거

기준 문구는 이슈 #16·#17의 `V01-C*`·`V02-C*`다. 한 기준에 공용 부분과 Windows·배포처 부분이 섞여 있으면 행을 나눴다.

| 기준 | 근거 | 판정 |
|---|---|---|
| V01-C1 Home/Sources/Activity/Settings가 backend 데이터를 보이고 브라우저·Electron이 같은 API 계약을 씀 | #46 (`431ab92e`) #50 (`aca4f569`); `apps/web/e2e/screens.e2e.ts`, `backend/src/api.contract.test.ts` | 증거 있음 |
| V01-C2 loopback·세션 token·Origin/Host 검사, renderer 보안 설정, 검증 IPC로 비인가 요청 거부 | #42 (`5704c597`) #50 (`aca4f569`) #77 (`7133e8c1`); `backend/src/api.security.test.ts`, `apps/desktop/src/shell.channel.test.ts`, `apps/desktop/e2e/shell.security.e2e.ts`, `apps/desktop/e2e/preload.surface.e2e.ts` | 증거 있음 |
| V01-C3a CLI 없음·오프라인·전송 거부 상태에서도 앱과 기존 자료 탐색이 동작 | #73 (`e0ed81db`); `backend/src/degraded.test.ts`, `apps/web/e2e/degraded.e2e.ts`, `storage/src/keyword-search.test.ts` | 증거 있음 |
| V01-C3b 시작·종료·single instance 통합(개발 OS) | #73 (`e0ed81db`) #201 (`45c906c7`); `apps/desktop/e2e/lifecycle.e2e.ts`, `apps/desktop/src/backend-supervisor.test.ts`, `apps/desktop/src/data-lock.test.ts` | 증거 있음 |
| V01-C3c Windows에서의 정상 종료 뒤 손자 프로세스 정리, 잠금 해제 시점 | #13 댓글과 #73 후속 기록이 "Windows 미검증"으로 남김 | 미검증 — Windows 필요 |
| V01-C4a Provider 어댑터(ClaudeCode·Codex CLI·API key OpenAI-compatible)·공통 broker·실행 조건 판정(공용 범위) | #47 (`b3e1befe`) #52 (`25c3f73d`) #56 (`feab8ad7`) #67 (`13cd52d3`) #81 (`a843c5b7`); `providers/src/broker.test.ts`, `providers/src/adapters/cli-argv.test.ts`, `providers/src/adapters/cli-kill.test.ts`, `providers/src/adapters/openai-compatible.test.ts`, `providers/src/execution-gate.test.ts`, `backend/src/cli-gate.test.ts` | 증거 있음 |
| V01-C4b 배포 빌드가 R02에서 격리를 검증한 설정·버전으로만 CLI를 실행 | 검증된 조합 목록 `providers/src/verified-cli-combinations.json`이 공용 저장소에서 빈 목록이다(`providers/src/verified-cli.test.ts`는 빈 목록 차단만 확인). 실제 CLI 실행 증거 없음 | 미검증 — 배포처 필요 |
| V01-C5a 전송 범위 승인·로그 redaction·외부 전송 표시의 허용/거부 시험 | #49 (`7363302d`); `backend/src/consent.binding.test.ts`, `backend/src/redaction.failure-paths.test.ts`, `providers/src/egress-policy.test.ts`, `apps/web/e2e/egress-label.e2e.ts` | 증거 있음 |
| V01-C5b 비밀 값 저장소(OS credential store 경로의 로직과 API key 보관) | #56 (`feab8ad7`); `apps/desktop/src/secret-store.test.ts`, `backend/src/secrets.test.ts` | 증거 있음 |
| V01-C5c Windows 자격 증명 저장소(`safeStorage`) 실동작 | 시험은 macOS 개발 환경에서 돈다. #16 댓글이 Windows 미시험(S11)으로 기록 | 미검증 — Windows 필요 |
| V01-C5d 저장 데이터(정본 DB) 암호화 | ADR 0010이 "정본 DB 평문, 비밀 값만 OS 저장소"로 결정했다(`docs/adr/0010-encryption-at-rest.md`). 암호화 드라이버 조사는 H01 후속 #270에 남음 | 미검증 — 보류(사용자가 Phase 1은 DB 평문으로 결정, 디스크 암호화가 확인된 PC에서만 실제 업무 데이터 사용) |
| V01-C6a embedding 계약을 CLI Provider와 분리해 연결, 합성 입력 왕복, 모델 없음 상태 표시와 탐색 유지 | #48 (`3d2f6716`) #51 (`5eab4ae0`); `providers/src/embedding.test.ts`, `providers/src/adapters/embedding.contract.test.ts`, `providers/src/adapters/embedding.integrity.test.ts`, `backend/src/embedding-status.test.ts`, `backend/src/embedding-prepare.test.ts`. 실제 bge-m3 왕복은 `providers/src/adapters/embedding.roundtrip.test.ts`가 맡지만 환경 변수가 있을 때만 돌고 기본 `pnpm test`는 건너뛴다 | 증거 있음 |
| V01-C6b 설치본에서의 실행과 배포처 모델 가져오기(A11·A12) | #16 댓글이 남은 것으로 기록. 설치본이 없다 | 미검증 — 배포처 필요 |
| V01-C7 엔진·Provider·저장소·embedding 어댑터 경계와 test double 교체 불변 | #44 (`1cf67f5d`) #81 (`a843c5b7`); `backend/src/adapter-swap.test.ts`, `packages/testkit/src/provider.contract.ts`, `packages/testkit/src/engine.contract.ts`, `packages/testkit/src/vector-index.contract.ts`, `packages/testkit/src/sql-driver.contract.ts`, `backend/src/swap-double.e2e.ts` | 증거 있음 |
| V02-C1a 의존 업무 지연 규칙으로 Insight를 만들고 날짜를 바꾸면 결과가 바뀜(저장·연결·코드 판정) | #53 (`b01cefab`) #58 (`9cda5405`) #65 (`64baba01`); `knowledge-engine/src/dependency-delay.test.ts`, `backend/src/extraction-flow.test.ts`, `providers/src/v02-fixtures.test.ts` | 증거 있음 |
| V02-C1b 실제 Provider로 추출 | 시험은 test double Provider로 돈다. 실제 Provider 결과 기록 없음 | 미검증 — 배포처 필요 |
| V02-C2 근거 3개를 UI에서 원본 version·span까지 열고 원문을 신뢰하지 않는 데이터로 표시 | #68 (`5052c525`); `apps/web/e2e/evidence.e2e.ts`, `apps/web/src/evidence-view.test.tsx`, `apps/web/src/evidence-text.test.ts`, `backend/src/evidence-api.test.ts` | 증거 있음 |
| V02-C3a 재입력 중복 없음·수정·삭제 뒤 stale 숨김·재시작 뒤 유지(개발 OS) | #63 (`602ebcc3`) #66 (`c615b6f3`) #69 (`11b81e68`) #76 (`2992a33f`); `apps/web/e2e/v02-flow.e2e.ts`, `backend/src/version-propagation.test.ts`, `backend/src/source-deletion.test.ts`, `knowledge-engine/src/deletion.test.ts` | 증거 있음 |
| V02-C3b Windows에서의 재시작 뒤 유지(S14) | 실행 기록 없음 | 미검증 — Windows 필요 |
| V02-C4a Playwright E2E(브라우저·Electron) | #76 (`2992a33f`); `apps/web/e2e/v02-flow.e2e.ts`, `backend/src/v02-shell.e2e.ts`. Provider는 `test-double`로 기록되며 실제와 구분됨 | 증거 있음 |
| V02-C4b Windows 설치본과 실제 Provider에서 같은 흐름 | 실행기·양식만 있다: #82 (`a8078c50`) `verification/v02-site-flow/run.py`, `verification/tests/test_v02_site_flow.py`(가짜 입력). 배포처 실행 결과 없음. 이슈 본문이 "그 전까지 미충족"으로 명시 | 미검증 — 배포처 필요 |
| V02-C5 파이프라인이 KnowledgeEngine·VectorIndex 규격을 정해진 지점에서 호출하고 구현 교체에도 파이프라인이 바뀌지 않음 | #70 (`d41b1b4a`); `backend/src/engine-projection.test.ts`, `knowledge-engine/src/projections.test.ts`, `packages/testkit/src/engine.contract.test.ts`, `knowledge-engine/src/adapters/visible-engine.test.ts`. Phase 1에서 호출되지 않던 벡터 쓰기 경로는 이후 H01-C3 #286 (`874517b3`)이 구현(Phase 7 문서 참조) | 증거 있음 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈 | 이 Phase에 직접 걸린 열린 후속 이슈는 없다. 화면 모양 작업 #281(PR #307 (`8bd2cc52`)로 머지, 이슈 closed)과 그 후속 #308은 Phase 6에 적었다 |
| 열린 하위 이슈 | #16, #17 — 모두 `site-verify`. 닫는 조건은 R04(#13) 설치본 → 배포처 S06·S07·S11·A11·A12·S14 실행 → R07(#37) 반영 |
| Windows 필요 | V01-C3c, V01-C5c, V02-C3b, V02-C4b의 설치본 부분 |
| 배포처 필요 | V01-C4b(검증된 CLI 조합), V01-C6b, V02-C1b, V02-C4b의 실제 Provider 부분 |
| 보류 | V01-C5d 정본 DB 암호화(ADR 0010, 사용자 결정) |
| 의도적으로 하지 않은 것 | 없음 |

## 4. 결론

공용 범위에서 확인된 것: 화면·API·보안 경계·Provider 규격과 broker·동의와 로그 redaction·embedding 규격·교체 불변(V01-C1, C2, C3a·b, C4a, C5a·b, C6a, C7)과 V02의 흐름(C1a, C2, C3a, C4a, C5)은 머지된 PR과 존재하는 시험 파일로 뒷받침된다. 테스트 double Provider와 개발 OS에서 얻은 증거다.

남은 것: 설치본·Windows 실행(C3c, C5c, C3b, C4b)과 실제 Provider·검증된 CLI 조합(C4b, C1b)은 배포처에서만 확인할 수 있다. 정본 DB 암호화는 사용자 결정으로 보류됐다. 에픽이 요구하는 "실제 수직 E2E와 설치본"은 설치본이 없으므로 충족되지 않았고, 에픽 #2의 R07(#37)이 닫혀야 Phase 1도 통과로 표시할 수 있다. 따라서 Phase 1의 Gate는 충족되었다고 선언하지 않는다.
