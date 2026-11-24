# 스펙: H03 검증 도구 정확성 묶음 (HVT)

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D8 포함)
- 관련: 이슈 #296(H03C2F 검토 잔여 R-a~R-e), #317(H03-C3 검토 잔여 FU1~FU4). [H03C2F spec](2026-11-24-H03C2F-runner-followups.md), [H03-C3 spec](2026-11-24-H03-C3-final-scenarios.md)
- 번호: 요구사항 `HVT-R<n>`, 완료 기준 `HVT-C<n>`, 결정 `HVT-D<n>`. **제품 코드·마이그레이션·계약 변경은 없다**(고치는 곳은 시험 지원 코드와 `tooling/`뿐이다).
- 기준 코드: `origin/main` `6f99466a`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

H03의 두 검증 도구 — 측정 실행기(`backend/src/system-measure.test-support.ts`)와 최종 시나리오 검사기(`tooling/scenarios/final-scenarios.ts`) — 에 독립 검토가 남긴 지적을 코드와 대조했다. 아홉 건 모두 지금 코드에 그대로 있다(이미 고쳐진 것 없음).

| 지적 | 자리 | 분류 |
|---|---|---|
| R-a 유실 1건과 중복 1건이 한 실행에서 겹치면 상쇄돼 유실 0으로 적힘 | `system-measure.test-support.ts:609-618` | 정확성 → R1 |
| R-b 작업 목록이 잘리면(100건, `jobs-view.ts:35`) `failedJobCounts`가 모든 종류를 셈 | `:590-599` | 정확성(안전한 쪽) → R2 |
| R-c 검사기가 `knowledge: null`·`{}`를 통과시킴 | `:298-301` | 정확성 → R3 |
| R-e 뒷정리의 `rmSync`(또는 `stopBackend`)가 던지면 `stopCleaning()`에 닿지 않아 신호 처리기가 남음 | `:943-948`, `:1242-1247` | 정확성 → R4 |
| R-d H03C2F-C7 시험이 종료 코드를 `not.toBe(0)`로만 단언 | `system-measure.signal.test.ts:65` | 시험 보강 → R5 |
| FU1 `playwright.config.ts`의 `testIgnore`에 이름으로 든 스크립트도 `e2e` 증거로 통과 | `final-scenarios.ts:110` | 정확성 → R6 |
| FU2 `eval/`·`verification/`를 깊이와 무관하게 거절(vitest `exclude`는 루트 아래만) | `final-scenarios.ts:52` | 정확성 → R7 |
| FU3 같은 규칙이 대소문자를 구분해 `Eval/x.test.ts`가 통과 | `final-scenarios.ts:52` | 정확성 → R7 |
| FU4 H03-C3 spec C7은 변이 확인을 요구하는데 121줄은 "변이 확인은 하지 않는다" | H03-C3 spec 118·121줄 | 문서 → R8 |

## 목표

- 측정 결과의 유실·실패 작업 수가 겹친 사건에도 실제보다 적게 나오지 않고, 다른 종류의 실패로 측정이 멈추지 않는다.
- 검사기 두 개가 형식이 틀린 칸과 실제로 돌지 않는 증거를 거절하고, 돌 수 있는 증거는 거절하지 않는다.
- 끝난 실행은 어떤 경로로 끝나도 신호 처리기를 남기지 않는다.

## 비목표

- 기본 크기(200건) 측정의 `--force` 재실행, Windows 장시간 실행, SIGINT 실측(#296에 그대로 둔다).
- 문서마다 근거 줄을 세는 일(제품 읽기 API가 사실별 `evidenceCount`만 주므로 계약 변경이 필요하다).
- Playwright의 글롭 일치를 검사기가 흉내 내는 일. #317 F2(제목 부분 일치, H03-C3 D6), #247의 C7 부하 불안정.
- 결과 파일 `schemaVersion` 올리기, `eval/results/h03-c2-dev.json` 다시 만들기.

## 요구사항

- **HVT-R1 (R-a)** 복구 단계의 유실·중복은 추출이 실패로 끝난 문서 수(`failedJobs`의 `dead_letter`+`cancelled`, `superseded` 제외)를 뺀 기대 근거 줄 수로 센다: 기대 = 문서 수 − 실패 수, 유실 = 검색 누락 + 실패 수 + max(0, 기대 − 근거 줄), 중복 = 같은 이름 항목 수 − 1 + max(0, 근거 줄 − 기대) (D1).
- **HVT-R2 (R-b)** 잘린 작업 목록에서 실패 수는 "보이는 줄 가운데 `extract`인 것 + 보이지 않는 그 상태의 줄 전부"다. 보이는 다른 종류의 실패는 세지 않는다(D2).
- **HVT-R3 (R-c)** 검사기는 `metrics.killRecover.knowledge`가 있으면 객체이고 `facts`·`evidence`·`expectedEvidence`가 모두 0 이상의 수인지 본다. 없으면 지금처럼 통과한다(D3).
- **HVT-R4 (R-e)** 실행기의 두 실행(본 측정, 복구 단계)은 뒷정리 도중 무엇이 던져도 신호 처리기를 떼고 끝난다(D4).
- **HVT-R5 (R-d)** H03C2F-C7 시험은 `SIGTERM`을 받은 명령의 종료 코드가 143인지 단언한다(D7).
- **HVT-R6 (FU1)** 검사기는 `e2e` 증거의 `path`가 `playwright.config.ts`의 `testIgnore`에 글롭 없이 이름으로 든 파일이면 그 시나리오 ID를 든 줄을 낸다. 그 목록을 찾지 못하면 표 전체의 어긋난 줄 하나를 낸다(D5).
- **HVT-R7 (FU2·FU3)** `unit` 폴더 규칙은 `vitest.config.ts`의 `exclude`와 같은 범위다: `node_modules/`는 깊이와 무관, `eval/`·`verification/`는 저장소 루트 바로 아래만. 대소문자를 구분하지 않는다. R6의 비교도 대소문자를 구분하지 않는다(D6).
- **HVT-R8 (FU4·문서)** H03-C3 spec의 변이 확인 문장을 C7(고정 목록 확인)만 하고 나머지는 하지 않는다로 고치고, R8의 2를 R7에 맞춘다. H03C2F spec의 R1·D2에 이 spec이 유실 식을 바꿨다는 한 줄을 단다. `docs/README.md`에 색인 한 줄.

## 완료 기준

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| HVT-C1 | 문서 3건·근거 줄 3개·실패한 추출 1건이 주어지면 유실 1·중복 1이고, 실패가 없으면 지금 H03C2F-C1의 값 그대로다(R1) | `backend/src/system-measure.test.ts` "HVT-C1" |
| HVT-C2 | 잘린 목록에서 보이는 실패가 `superseded`인 다른 종류 하나뿐이면 `{}`이고, 보이지 않는 `dead_letter` 2건은 2로 센다(R2) | `system-measure.test.ts` "HVT-C2" |
| HVT-C3 | 추적 중인 결과에 `knowledge: null`을 넣으면 검사기가 `knowledge`를, `{}`를 넣으면 `knowledge.facts`를 든 문제를 낸다. 넣지 않으면 문제 0(R3) | `system-measure.test.ts` "HVT-C3" |
| HVT-C4 | 실행 하나의 뒷정리 함수가 던지면 그 예외가 나오고, 신호 처리기 수는 실행 전과 같다(R4) | `system-measure.test.ts` "HVT-C4" |
| HVT-C5 | H03C2F-C7 시험이 `toBe(143)`으로 단언하고 통과한다(R5) | `backend/src/system-measure.signal.test.ts` |
| HVT-C6 | `e2e` 증거를 `testIgnore`에 이름으로 든 `backend/src/v02-seed.e2e.ts`로 바꾸면 그 시나리오 ID를 든 줄이 나오고, 저장소의 표(H03C3-C1)는 어긋남 0 그대로다(R6) | `tooling/scenarios/final-scenarios.test.ts` "HVT-C6" |
| HVT-C7 | `unit` 경로 `x/eval/a.test.ts`는 어긋나지 않고 `Eval/a.test.ts`는 어긋난다. H03C3-C8의 세 경로는 그대로 어긋난다(R7) | `final-scenarios.test.ts` "HVT-C7" |

R8은 문서뿐이라 `pnpm exec vitest run tooling/docs`가 통과하는 것으로 본다. C1~C4·C6·C7은 구현 전에 빨개야 한다. C5는 시험 보강이라 처음부터 초록이다. 변이 확인은 하지 않는다(두 도구 모두 보안·자료 보호의 허용·차단 가드가 아니다).

## 잠정 결정

| 결정 | 내용 | 바꾸려면 |
|---|---|---|
| **HVT-D1** | 실패한 추출 문서는 근거 줄을 내지 않는다고 보고 기대 근거 줄에서 뺀다. 그래서 유실과 중복을 둘 다 잡는다(검토가 제안한 `max(모자란 근거, 실패 수)`는 중복을 놓친다). `superseded`는 새 version이 대신 추출하므로 빼지 않는다(H03C2F-D2의 이유). 실패 뒤 같은 문서가 다시 추출되면 유실·중복을 하나씩 더 적는다(안전한 쪽) | `tallyKnowledge`의 식을 H03C2F-R1로 되돌리거나 `max` 식으로 바꾼다 |
| **HVT-D2** | 잘린 목록은 계약을 바꾸지 않고(작업 API에 종류 필터 없음) 보이는 줄만 종류로 거른다. 보이지 않는 실패는 종류를 모르므로 센다 | 작업 API에 종류별 수를 더하는 계약 변경 |
| **HVT-D3** | `knowledge`가 없는 옛 결과는 계속 유효하다(H03C2F-D1). 있으면 세 칸 모두 필수 | `schemaVersion` 2에서 `knowledge`를 필수로 |
| **HVT-D4** | `cleanOnSignal`이 돌려주는 끝내기 함수가 처리기를 **먼저** 떼고 뒷정리(프로세스 묶음 끝내기, 임시 폴더 지우기)를 한 번 돈다. 두 `finally`는 `try { stopBackend } finally { 끝내기() }`가 된다. 같은 뒷정리를 두 번 적던 중복도 사라진다. 시험을 위해 `cleanOnSignal`을 내보낸다 | `finally` 본문을 `try … finally { stopCleaning() }`으로만 감싸는 쪽(시험은 `vi.mock("node:fs")`가 필요해진다) |
| **HVT-D5** | `testIgnore`는 검사기가 받는 "파일 읽기" 함수로 `playwright.config.ts` 글자를 읽어 꺼낸다(설정 모듈을 불러오지 않는다 — vitest 안에서 `@playwright/test`를 불러오는 위험과 H03C3-R4 "시험을 실행하지 않는다"를 피함). 글롭(`*`)이 든 항목은 판정하지 않는다(`apps/desktop/**`는 다른 프로젝트가 돈다). 목록을 못 찾으면 어긋남(설정이 바뀐 것을 조용히 넘기지 않음) | 설정 모듈을 불러와 `path.matchesGlob`으로 모든 프로젝트의 `testMatch`·`testIgnore`를 판정 |
| **HVT-D6** | 폴더 규칙은 vitest `exclude`의 글롭 그대로(루트 기준)이고 대소문자 무시다. macOS 파일 시스템은 `Eval/x`를 `eval/x`로 읽어 주지만 vitest는 실제 이름 `eval/`로 제외하기 때문이다 | `final-scenarios.ts`의 정규식 한 줄 |
| **HVT-D7** | 종료 코드는 `SIGTERM`(143)만 단언한다. `SIGINT`(130)는 같은 처리기의 다른 인자라 시험을 늘리지 않는다(테스트 간략화 규칙 1) | C7 시험에 `SIGINT` 실행을 하나 더한다 |
| **HVT-D8** | #247의 C7 부하 불안정은 다루지 않는다(순수 main 대조가 없어 원인 미확정) | 별도 이슈에서 대조 후 처리 |

## 미검증 범위

- 문서 하나가 소리 없이 잃히고(실패한 작업 없음) 다른 문서가 두 번 반영되는 경우는 여전히 상쇄된다. 이때도 같은 이름 항목이 하나뿐이면 중복 0으로 적힌다. 문서별 근거 줄을 읽을 API가 없다(비목표).
- 검사기는 `testIgnore`의 이름 항목만 본다. 글롭 항목이나 다른 프로젝트의 `testMatch`에 걸리지 않아 실제로 돌지 않는 `*.e2e.ts`는 잡지 않는다.
- 기본 크기 측정을 새 실행기로 다시 돌린 값, Windows에서의 경로 대소문자·신호.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | #296·#317 검토 잔여 아홉 건을 코드와 대조해 고칠 것을 정함 |
| 2026-11-24 | 상태를 확정으로 바꿈 | 상태 | 구현·시험 완료(C1~C7 시험 이름 그대로) |
