# Phase 0 (OSS Research & PoC) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `80a7962b` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.

## 1. 대상

에픽 #2 `[Phase 0] OSS Research & PoC` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #35 [R00] 빈 저장소 최초 base 확보와 브랜치 절차 확정 | closed | - |
| #10 [R01] OSS 엔진·완제품 코드와 재배포 조건 비교 | closed | - |
| #11 [R02] CLI Provider 인증 재사용·격리 가능성 PoC | open | site-verify |
| #12 [R03] 지식 엔진·임베딩·Embedded Storage 실행 비교 | open | blocked,site-verify |
| #13 [R04] Windows 최소 설치 파일과 런타임 포함 PoC | open | blocked,site-verify |
| #14 [R05] 골든 데이터셋·평가 기준과 측정 환경 고정 | closed | - |
| #15 [R06] 조사 근거로 아키텍처·보안·소유권 ADR 잠정 확정 | closed | - |
| #37 [R07] 배포처 실행 검증 결과 반영과 ADR 확정 | open | blocked |

에픽 본문의 체크박스는 #35·#10·#14·#15가 `[x]`, 나머지가 `[ ]`이며 실제 이슈 상태와 일치한다.

## 2. 완료 기준별 증거

Phase 0의 산출물은 대부분 문서이므로 "증거"는 `origin/main`에 있는 문서·검증 키트 경로다. 키트(`verification/`)의 단위 시험은 가짜 CLI·가짜 엔진으로 돌며, 배포처 실행 결과가 아니다.

| 기준 | 근거 | 판정 |
|---|---|---|
| R00-C1 최초 base 절차와 사용자 승인 기록 | #39 (`2869caac`) `docs/research/2026-11-21-R00-initial-base.md`; 승인 기록은 #35 댓글(참고용) | 증거 있음 |
| R00-C2 최초 commit은 README·`.gitignore`·LICENSE만 | `LICENSE`, `README.md`, `.gitignore` 존재; base commit `de24ded8`이 `origin/main`의 조상 | 증거 있음 |
| R00-C3 push 뒤 base 실재와 feature worktree 확인 | #39 (`2869caac`) `docs/research/2026-11-21-R00-initial-base.md`(명령·출력 보관). `git ls-remote` 출력은 당시 기록이며 이번에 다시 실행하지 않음 | 증거 있음 |
| R01-C1 후보별 LICENSE·의존성·확장점 표와 소스 링크 | #36 (`4ca96872`) `docs/OSS_EVALUATION.md`, `docs/specs/2026-11-21-R01-oss-evaluation.md` | 증거 있음 |
| R01-C2 스택(Electron·저장소·문서 처리 등) 재배포 조건과 유지보수 위험 | #36 (`4ca96872`) `docs/OSS_EVALUATION.md` 4절 | 증거 있음 |
| R01-C3 탈락 조건 먼저 적용, 채택/보류/기각과 대안 | #36 (`4ca96872`) `docs/OSS_EVALUATION.md` 1·5절 | 증거 있음 |
| R02-C1 CLI 설치·버전·인증·비대화형·취소 capability 표와 정상·미설치·미로그인 재현 | 조사 문서만: #36 (`4ca96872`) `docs/research/2026-11-21-cli-provider-terms-and-isolation.md`. 실행 키트: #40 (`439bd072`) `verification/r02-cli-isolation/run.py` | 미검증 — 배포처 필요 |
| R02-C2 격리 cwd·`shell:false`·설정/플러그인/hooks/MCP/웹검색 차단 검증 | 같은 키트(`verification/r02-cli-isolation/negative.py`, `judge.py`). 실제 CLI 호출 결과 없음 | 미검증 — 배포처 필요 |
| R02-C3 악성 문서 부정 시험과 Windows 자식 프로세스 종료 | 같은 키트. 실행 결과 없음 | 미검증 — 배포처 필요 |
| R02-C4 구독 로그인의 제품 자동화 허용 범위(공식 조건) | #36 (`4ca96872`) 조사 문서가 "모호함"까지 기록. 허용 확인은 사용자·벤더 결정 대기(#11 댓글) | 미검증 — 보류(구독 로그인 자동화 허용 여부가 미확정, 사용자 결정 또는 벤더 확인 필요) |
| R03-C1 Import→추출→관계→증분→삭제→재시작 실행 | #40 (`439bd072`) `verification/r03-engine-comparison/run.py`(키트). 후보 엔진 실제 실행 결과 없음 | 미검증 — 배포처 필요 |
| R03-C2 엔진의 generate/embed/rerank/structured를 CLI adapter로 충족 | #40 (`439bd072`) `verification/r03-engine-comparison/llm_gateway.py`, `shim_server.py`(키트). 실행 결과 없음 | 미검증 — 배포처 필요 |
| R03-C3 한국어·영어 CPU embedding 품질·메모리·속도, 모델 라이선스 | #40 (`439bd072`) `verification/r03-engine-comparison/embedding_bench.py`(키트). 측정 결과 없음. 이후 #51 (`5eab4ae0`)이 bge-m3 embedding을 개발 장비에서 왕복 시험했으나 비교 측정이 아님 | 미검증 — 배포처 필요 |
| R03-C4 저장소 선정·crash·동시 읽기·단일 writer 검증 | #40 (`439bd072`) `verification/r03-engine-comparison/durability.py`, `store.py`(키트). 실행 결과 없음. 저장소는 SQLite로 잠정 결정(ADR 0004) | 미검증 — 배포처 필요 |
| R04-C1 Windows 11 깨끗한 환경 설치·실행·제거, browser·Electron 왕복 | #40 (`439bd072`) `verification/r04-windows-installer/run.py`, `RUNBOOK.md`(키트). Windows 실행 결과 없음 | 미검증 — Windows 필요 |
| R04-C2 Python/native 모듈 포함 두 번째 설치 실험 | 같은 키트. R03 실행을 통과한 후보가 아직 없어 선행 조건 미충족 | 미검증 — Windows 필요 |
| R04-C3 크기·idle CPU·RSS·시작 시간 측정, 서명·업데이트 미확정 사항 | 같은 키트(`verification/r04-windows-installer/run.py`). Windows 없이는 통과 처리하지 않는다고 이슈가 명시 | 미검증 — Windows 필요 |
| R05-C1 시나리오(일정 지연·동명이인·약어·상충·시차·중복 스레드)와 원문 evidence·span | #38 (`64d16a24`) `eval/golden/labels/relations.jsonl`, `eval/golden/sources/mail.jsonl`, `eval/scorer/validate.py`, `eval/scorer/tests/test_validate.py`. 라벨 의미의 사람 전수 검토는 없음(구조 검사만) | 증거 있음 |
| R05-C2a 학습·튜닝용과 봉인 평가용 분리, scorer 기록 | #38 (`64d16a24`) `eval/golden/splits.json`, `eval/scorer/score.py`, `eval/scorer/tests/test_score.py` | 증거 있음 |
| R05-C2b 독립 검토 라벨 | #38 (`64d16a24`) `eval/golden/labels/REVIEW_STATUS.md`. 독립 검토는 기계 2차 검토뿐이고 사람 전수 검토는 없다(#14 닫을 때 사용자가 수용) | 미검증 — 보류(사람 검토자 미지정, 개발 세트·추가 평가 시나리오 6개·질문·엔티티 정답은 2차 검토 없음) |
| R05-C3 지표·ablation 정의와 수치 기준을 결과 확인 전에 고정 | #38 (`64d16a24`) `docs/EVALUATION.md`, `eval/golden/README.md`. 일부 지표는 채점 코드가 없어 "판정 보류"로 적혀 있다(#14 댓글: 6개만 채점 코드 있음) | 증거 있음 |
| R05-C3 잔여 지표의 채점 코드와 측정 | `docs/EVALUATION.md`의 "판정 보류" 칸 | 미검증 — 보류(사람 평가 지표와 일부 지표는 채점표·라벨이 없음) |
| R06-C1 평가·아키텍처·ADR·소유권·site-setup·V01/V02 spec을 PR로 남김 | #36 (`4ca96872`) `docs/OSS_EVALUATION.md`; #39 (`2869caac`) `docs/ARCHITECTURE.md`, `docs/ownership.md`, `docs/site-setup.md`, `docs/REUSE_AND_BUILD.md`, `docs/specs/2026-11-21-V01-vertical-skeleton.md`, `docs/specs/2026-11-21-V02-vertical-slice.md`, `docs/adr/0001-modular-monolith-and-stack.md` | 증거 있음 |
| R06-C2 정본·투영 구분과 부분 실패 복구 방식 | #39 (`2869caac`) `docs/adr/0002-authority-in-product-records.md`, `docs/adr/0013-failure-recovery.md`, `docs/ARCHITECTURE.md` | 증거 있음 |
| R06-C3 격리·암호화·전송 승인·embedding 경로·하위 포크 계약 결정 | #39 (`2869caac`) `docs/adr/0005-llm-providers.md`, `docs/adr/0006-embedding.md`, `docs/adr/0010-encryption-at-rest.md`, `docs/adr/0012-upstream-and-fork-ownership.md` | 증거 있음 |
| R06-C4 미검증 가정 목록화, 뒤집힐 선택은 어댑터 뒤에 둠 | #39 (`2869caac`) `docs/specs/2026-11-21-R06-provisional-architecture.md`(가정 A01~A22), 어댑터 경계의 계약 시험은 Phase 1 V01-C7 참조 | 증거 있음 |
| R06 전체: 실행이 필요한 가정 A01~A22의 확정 | ADR 머리말이 "잠정 — 배포처 검증 대기"로 남아 있음 | 미검증 — 배포처 필요 |
| R07-C1 R02·R03·R04 절차를 배포처에서 합성 데이터로 실행하고 결과를 남김 | 결과 기록 없음(#37 진행 로그 "미착수") | 미검증 — 배포처 필요 |
| R07-C2 결과를 잠정 ADR 가정과 대조해 확정·개정·기각 | 결과 기록 없음 | 미검증 — 배포처 필요 |
| R07-C3 실행하지 못한 항목을 release blocker로 표시 | 표시할 실행 결과가 없고 #37이 열려 있음 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈 | #198 `[R04 후속]` 데이터 폴더 잠금 검토의 남은 지적 4건 (잠금은 #201 (`45c906c7`)·#222 (`bc3a717a`)로 구현, `apps/desktop/src/data-lock.test.ts`; Windows 실행은 미검증) |
| 열린 하위 이슈 | #11(R02), #12(R03), #13(R04), #37(R07). 모두 배포처 실행이 필요하다 |
| 보류 | 구독 로그인 자동화 허용 여부(R02-C4), 사람의 라벨 전수 검토(R05-C2b) |
| 의도적으로 하지 않은 것 | 없음(Phase 0 범위에서 사용자가 기각한 기준은 확인하지 못함) |
| 느린 정규화기 시험 C49·C17 | Phase 2 항목이므로 Phase 2 문서에 기록 |

## 4. 결론

공용 범위에서 확인된 것: 조사·평가·아키텍처 결정은 문서 산출물로 `origin/main`에 있다(R00, R01, R05의 구조 검사, R06). 사외 준비물인 R02·R03·R04 실행 키트도 들어 있다.

남은 것: R02·R03·R04의 실제 실행 기준은 모두 배포처(R04는 Windows 11) 실행이 필요하고, R07이 그 결과를 반영해 잠정 ADR을 확정해야 한다. R02-C4(구독 로그인 자동화 허용)와 R05-C2b(사람 검토)는 외부 결정이 있어야 닫힌다. 따라서 Phase 0의 Gate는 공용 범위에서도 충족되었다고 선언하지 않는다. 에픽 본문이 말하듯 R07(#37)이 닫혀야 통과로 표시할 수 있다.
