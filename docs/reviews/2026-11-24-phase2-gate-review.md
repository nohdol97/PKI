# Phase 2 (Information Ingestion) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `80a7962b` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 실제 메일·메신저·Wiki 수집 client, Windows 설치본, 배포처 실행이 필요한 기준은 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #4 `[Phase 2] Information Ingestion` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #18 [I01] Connector SDK·Source/Evidence 계약과 JSONL/API Import | open | site-verify |
| #19 [I02] 파일 Import·폴더 감시·문서 정규화 | open | in-progress |
| #20 [I03] Persistent Queue·Scheduler·재시도와 절전 복구 | open | site-verify |
| #21 [I04] 수정·삭제·권한철회와 파생 지식 무효화 | open | blocked |

에픽 체크박스 네 개가 모두 `[ ]`이고 실제도 모두 open이라 일치한다. 이 Phase의 구현 작업(I01 T01~T10, I02-A·I02-B T01~T06, I03 T01~T13, I04 T01~T14)은 모두 머지됐다. 같이 닫힌 연관 이슈: #113 #114 #115 #116(I01 후속, I05~I07로 처리), #121 #123(I04 후속), #122(첨부 metadata).

## 2. 완료 기준별 증거

### I01 Connector SDK (#18)

| 기준 | 근거 | 판정 |
|---|---|---|
| I01-C1 Connector 규격(initialize/sync/getChanges/getDocument/healthCheck, capability, cursor checkpoint, rate/backoff, pagination, full-rescan)을 버전 관리 | #75 (`1889f99d`) #100 (`9015372b`) #78 (`4706a5ff`); `backend/src/connector-v2.test.ts`, `backend/src/connector-sync-v2.test.ts`, `packages/testkit/src/connector.contract.test.ts` | 증거 있음 |
| I01-C2 SourceRecord 필드 보강(인스턴스·namespace·operation·schema_version·access_scope)과 Evidence의 불변 version·span 지시 | #97 (`4a0a9dc5`) #98 (`d8d7019b`) #111 (`11933242`) #265 (`c65931d3`); `knowledge-engine/src/arrival.test.ts`, `packages/contracts/src/connector.test.ts`, `backend/src/claimed-scope.import.test.ts`, `backend/src/evidence-api.test.ts`, `storage/src/evidence-view.test.ts` | 증거 있음 |
| I01-C3 JSONL/가져오기 API의 스키마 오류·중복·역순·부분실패 계약 시험, 같은 내용이라도 원본 정체·권한을 합치지 않음 | #108 (`d3f81fda`) #63 (`602ebcc3`); `backend/src/import.http.test.ts`, `backend/src/import.booted.test.ts`, `backend/src/jsonl-lines.test.ts`, `backend/src/jsonl-import.test.ts`, `backend/src/adapters/jsonl-connector.test.ts` | 증거 있음 |
| I01-C4a 타사 Connector fixture가 계약 묶음을 실행할 수 있음 | #78 (`4706a5ff`) #83 (`0e1c4abd`); `packages/testkit/src/connector.contract.test.ts`, `packages/connector-example/src/adapters/connector-example.contract.test.ts`, `packages/connector-example/src/adapters/connector-example.violations.test.ts` | 증거 있음 |
| I01-C4b 실제 메일·메신저·Wiki client가 공용 구현에 없음 | #84 (`00e57fcd`); `tooling/connectors/public-only.test.ts`, `backend/src/connectors.public-only.test.ts` | 증거 있음 |
| I01 배포처 확인: 실제 출처 시스템에 붙인 수집기, 설치본(site-setup S08·S18) | 문서: #117 (`4f4c883e`) `docs/connector-sdk.md`. 실행 결과 없음 | 미검증 — 배포처 필요 |

### I02 파일 Import·정규화 (#19)

| 기준 | 근거 | 판정 |
|---|---|---|
| I02-C1 형식별 표·시트·페이지·인코딩 보존과 한계 명시, 첨부 metadata·첨부 안 근거 위치 | #64 (`98650072`) #265 (`c65931d3`); `packages/document-normalize/src/fixtures.test.ts`, `packages/document-normalize/src/encoding.test.ts`, `packages/document-normalize/src/formats/xlsx.test.ts`, `packages/document-normalize/src/formats/pdf.test.ts`, `packages/document-normalize/src/formats/docx.test.ts`, `packages/connector-sdk/src/jsonl.test.ts` | 증거 있음 |
| I02-C2a 폴더 범위 승인·symlink 경계·경로 정책, rename/move/debounce 처리 | #150 (`96708d34`) #184 (`44369d0b`) #195 (`0501ea28`) #223 (`9bb08439`) #242 (`8897f7c2`); `packages/connector-sdk/src/local-path.approval.test.ts`, `packages/connector-sdk/src/local-path.walk.test.ts`, `backend/src/local-locations.api.test.ts`, `backend/src/local-files-driver.test.ts`, `backend/src/local-files-lifecycle.test.ts`, `apps/web/e2e/local-files.e2e.ts` | 증거 있음 |
| I02-C2b HTML script·원격 자원, 대형·손상 파일, 압축 폭탄 위험 처리 | #64 (`98650072`) #158 (`3937f169`); `packages/document-normalize/src/formats/html.test.ts`, `packages/document-normalize/src/safety.test.ts`, `packages/document-normalize/src/host.test.ts`, `packages/document-normalize/src/isolated.test.ts` | 증거 있음 |
| I02-C2c 정규화 격리(30회 반복 격리 시험 I02B-C49)와 60초 제한(I02B-C17) | 느린 정규화기 시험: `vitest.normalizer-slow.config.ts`, `packages/document-normalize/src/trigger-repeat.slow.ts`, `packages/document-normalize/src/reproduction-inputs.slow.ts`. 머지된 머리에서의 결과가 없다 | 미검증 — 보류(느린 정규화기 시험 C49·C17은 사용자 결정으로 허락 전까지 실행 금지) |
| I02-C3a 스레드·참여자·댓글의 시간 순서 복원 | #250 (`ca88395c`) #273 (`14ad087b`); `backend/src/thread.golden.test.ts`, `storage/src/thread.test.ts` | 증거 있음 |
| I02-C3b watcher 누락 뒤 reconciliation, 원본을 임의 실행하지 않음 | #242 (`8897f7c2`) #260 (`dd0aec66`) #284 (`7e9b9162`); `backend/src/local-files-driver.test.ts`, `backend/src/local-files-lifecycle.test.ts`, `backend/src/local-rescan-busy.test.ts`, `backend/src/jsonl-file-location.test.ts` | 증거 있음 |
| I02 배포처·Windows 확인: 실제 문서 조사(S17), npm 미러 설치(S16), Windows 폴더 위치·열기(S23~S25), 퓨즈를 끈 설치본 | 이슈 로그가 "Windows·배포처 실행 미검증"으로 기록. 실행기: #260 (`dd0aec66`) | 미검증 — Windows 필요 |

### I03 Persistent Queue (#20)

| 기준 | 근거 | 판정 |
|---|---|---|
| I03-C1 작업 상태·lease·heartbeat·checkpoint, 강제 종료 뒤 lease 회수와 재처리로 효과 중복 없음 | #72 (`ae8f0a66`) #80 (`4c139699`) #86 (`0a72c4fc`) #305 (`f9058791`); `storage/src/jobs.test.ts`, `backend/src/job-runner.test.ts`, `backend/src/job-kill.test.ts`, `backend/src/job-outcomes.test.ts`, `backend/src/boot.lease-reclaim.test.ts` | 증거 있음 |
| I03-C2 10분/1시간/일간/주간 기본 주기 설정, 재시작·시계 변화 뒤 누락분의 한정된 합치기 | #74 (`5303d335`) #92 (`eb3be933`) #103 (`5d32a88e`); `backend/src/schedule.test.ts`, `backend/src/clock.test.ts`, `backend/src/scheduler.test.ts` | 증거 있음 |
| I03-C3 우선순위·공정성·동시 실행·호출/시간 예산·취소·backoff·수동 재시도·Activity 가시성 | #87 (`0cfc22c4`) #90 (`66899f78`) #91 (`67ebd871`) #107 (`b5effb26`) #94 (`2b1e651b`); `backend/src/job-concurrency.test.ts`, `backend/src/job-budget.test.ts`, `providers/src/broker.budget.test.ts`, `backend/src/job-cancel.test.ts`, `backend/src/jobs-api.test.ts`, `apps/web/e2e/activity.e2e.ts` | 증거 있음 |
| I03 배포처 확인: Windows 절전·최대 절전·강제 종료·시간대 변경(가정 A1~A5, site-setup S19·S20) | 실행기: #129 (`aa01d7b5`) `verification/v02-site-flow/queue_scenario.py`, `verification/tests/test_i03_queue_scenario.py`(가짜 입력). Windows 실행 결과 없음 | 미검증 — Windows 필요 |

### I04 무효화 (#21)

| 기준 | 근거 | 판정 |
|---|---|---|
| I04-C1 영향 범위 기록, tombstone 직후 검색·Q&A·알림 차단, 범위·전송 정책의 파생물 승계 | #71 (`09290f11`) #101 (`e77bc503`) #102 (`eab83cb0`) #105 (`9b6db291`) #106 (`7c31b2f0`); `backend/src/read-gate.test.ts`, `backend/src/scope-policy.test.ts`, `backend/src/invalidation-record.test.ts`, `knowledge-engine/src/scope.test.ts`, `packages/testkit/src/derivatives.contract.test.ts` | 증거 있음 |
| I04-C2 처리 중 삭제·낡은 결과 재유입을 version fence로 차단, 멱등 정리·재구축 | #95 (`5d1ade30`) #96 (`c52bdc2d`) #101 (`e77bc503`); `backend/src/fence-fresh.test.ts`, `knowledge-engine/src/tombstone-entry.test.ts`, `storage/src/tombstones.test.ts` | 증거 있음 |
| I04-C3 다른 근거가 남은 사실의 재평가, 삭제 범위·보존, 복원 뒤 tombstone 재적용 | #79 (`95c656ac`) #88 (`40d96faf`) #118 (`3493a75e`) #126 (`f9f7cc32`) #271 (`99c12682`); `knowledge-engine/src/ledger-reapply.test.ts`, `backend/src/ledger.boot-reconcile.test.ts`, `knowledge-engine/src/purge-canary.test.ts`, `knowledge-engine/src/prune-versions.test.ts`, `backend/src/restore-ledger.test.ts`(복원 실행은 H01-C2) | 증거 있음 |
| I04-C4~C12 종류를 모르는 빌드가 건너뛴 삭제 줄의 보류와 재적용(#121) | #167 (`65934533`); `knowledge-engine/src/ledger-reapply.test.ts`, `backend/src/ledger.boot-reconcile.test.ts`, `tooling/docs/connector-sdk.test.ts` | 증거 있음 |
| I04 배포처 확인: 실제 범위 정책(공용 기본은 모두 허용), Windows(site-setup S21·S22) | 실행기: #110 (`d6f957c2`) `verification/v02-site-flow/delete_scenario.py`, `verification/tests/test_i04_delete_scenario.py`(가짜 입력). 실행 결과 없음 | 미검증 — 배포처 필요 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(I02) | #179 local-files 시험·타입 보강, #190 승인 티켓 만료·포트 묶기 시험, #200 폴더 선택 지적 3건, #237 위치 수명 주기 지적, #249 스레드 읽기 API·화면 지적, #258 JSONL 파일 위치 지적(F5는 D33 뒤집기 결정 필요), #263 첨부 metadata 지적 |
| 열린 후속 이슈(I04·I06) | #197 I06F 후속 지적 3건, #212 장부 재적용 색인 지적 2건 |
| 열린 후속 이슈(공통) | #240 시험 파일 템플릿 전환 지적 |
| 열린 하위 이슈 | #18, #20 `site-verify`; #19 `in-progress`; #21 `blocked`([색인의 이슈 표류](README.md#이슈-표류) 참고) |
| 보류 | 느린 정규화기 시험 C49·C17(사용자 결정, 실행하지 않았다) |
| 의도적으로 하지 않은 것 | I04-T12(원본 이전 version 지우기)의 화면은 만들지 않았다(spec 후속 표 14) |

## 4. 결론

공용 범위에서 확인된 것: Connector 규격·계약 묶음·JSONL 가져오기(I01-C1~C4), 문서 정규화·로컬 파일 위치 수명 주기·스레드 복원(I02-C1, C2a·b, C3a·b), 작업 대기열·주기·예산(I03-C1~C3), 무효화·tombstone·장부 재적용(I04-C1~C3, C4~C12)은 머지된 PR과 존재하는 시험 파일로 뒷받침된다.

남은 것: 느린 정규화기 격리 시험(C49·C17)은 사용자 결정으로 보류됐고, 실제 출처 시스템·실제 문서·Windows 절전/시계/위치 시나리오·실제 범위 정책은 배포처 또는 Windows에서만 확인할 수 있다(I01·I02·I03·I04의 배포처 확인 행). 에픽 완료 Gate는 이 항목이 남아 있어 충족되었다고 선언하지 않는다.
