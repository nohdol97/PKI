# Phase 7 (Production Readiness) 완료 Gate 검토

- 검토일: 2026-11-24 (origin/main `8bd2cc52` 기준, 이슈 상태는 같은 날 `gh`로 측정)
- 범위: 공용(개인 저장소) 쪽에서 확인할 수 있는 것만 판정한다. 이 Phase의 완료 기준은 대부분 Windows 11 설치본과 배포처 환경을 요구한다. 그 실행이 없으면 통과로 쓰지 않는다.
- 판정 말: `증거 있음` / `미검증 — Windows 필요` / `미검증 — 배포처 필요` / `미검증 — 보류(사유)` / `증거 없음`
- 증거 표기: PR 번호 뒤 괄호는 `origin/main`에 들어 있는 merge commit 짧은 SHA다.
- 이 문서는 시험 파일이 존재하는지까지만 확인했다. 이번 검토에서 시험을 다시 돌리지 않았다.

## 1. 대상

에픽 #9 `[Phase 7] Production Readiness` (open). 하위 작업:

| 이슈 | 상태 | 라벨 |
|---|---|---|
| #32 [H01] 백업·복구·암호화·마이그레이션·모델 재인덱싱 | open | in-progress |
| #33 [H02] Windows 배포·업데이트·OS Lifecycle 완성 | open | blocked |
| #34 [H03] 보안 부정 테스트·장시간 성능·14개 최종 시나리오 | open | in-progress |

에픽 체크박스 셋은 모두 `[ ]`이고 실제도 모두 open이라 에픽 쪽은 일치한다. 다만 #32 이슈 본문의 `H01-C1`~`C3` 체크박스는 세 개 모두 `[x]`로 바뀌어 있는데, 이슈는 open이고 진행 로그는 암호화 드라이버·Windows·실제 모델을 미검증으로 남겼다(이슈 표류 참고). #34 H03-C3의 공용 범위 작업(FS01~FS14 표와 검사 실행기)은 다른 세션이 진행 중이고 아직 머지되지 않았다.

## 2. 완료 기준별 증거

### H01 백업·복구·암호화·마이그레이션·모델 재인덱싱 (#32)

| 기준 | 근거 | 판정 |
|---|---|---|
| H01-C1a 일관된 스냅샷, 원본·지식·작업·피드백과 embedding 공간·색인 순번을 담은 목록표 | #271 (`99c12682`); `storage/src/backup.test.ts`, `backend/src/backup-api.test.ts` | 증거 있음 |
| H01-C1b 백업 파일 암호화와 키 분실 동작(틀린 암호구·변조·잘림 거절) | #271 (`99c12682`) #299 (`2338a820`); `storage/src/backup-file.test.ts`, `backend/src/backup-api.test.ts`. 키는 암호구에서만 만들며 OS 자격 증명 저장소에 두지 않는다(H01 spec D4). 이슈 문구의 "키 OS credential store"를 "OS 키에 묶인 비밀 값은 백업에 넣지 않는다"로 읽은 해석이다 | 증거 있음 |
| H01-C1c 정본 DB 자체의 저장 시 암호화 | ADR 0010이 정본 DB 평문으로 결정. 암호화 드라이버 조사는 #270에 남음 | 미검증 — 보류(사용자가 DB 평문으로 결정, 드라이버 조사 대기) |
| H01-C2a 손상·새 버전 파일·다른 설치 파일·확인값 불일치를 안전하게 거절 | #271 (`99c12682`) #299 (`2338a820`); `storage/src/backup.test.ts`, `backend/src/backup-api.test.ts`, `backend/src/restore-boot.committed.test.ts` | 증거 있음 |
| H01-C2b 복원 도중 crash의 각 단계에서 일관된 상태로 끝남 | #271 (`99c12682`); `backend/src/restore-boot.test.ts` | 증거 있음 |
| H01-C2c 복원 뒤 tombstone·권한 철회가 부활하지 않음 | #271 (`99c12682`); `backend/src/restore-ledger.test.ts`, `backend/src/ledger.boot-reconcile.test.ts` | 증거 있음 |
| H01-C3a embedding 교체는 세대별 shadow index→검증→atomic switch, 실패해도 기존 탐색 유지 | #286 (`874517b3`); `backend/src/vector-index.boot.test.ts`, `backend/src/vector-serving.test.ts`, `knowledge-engine/src/vector-build.test.ts`, `storage/src/adapters/sqlite-vector-index.contract.test.ts` | 증거 있음 |
| H01-C3b 실제 모델(bge-m3)의 재인덱싱 비용·큰 코퍼스의 60분 작업 한도·설치본이 `vectorIndexing` 옵션을 넘기는 방법 | #32 댓글이 "확인하지 않음"으로 기록(site-setup S39·S43) | 미검증 — 배포처 필요 |
| H01 Windows 실측 | #270이 "Windows 실측"을 남은 항목으로 기록 | 미검증 — Windows 필요 |

### H02 Windows 배포·업데이트·OS Lifecycle (#33)

| 기준 | 근거 | 판정 |
|---|---|---|
| H02-C1 표준 사용자 Windows 11에서 설치·업데이트·제거, tray·autostart·notification·single instance·graceful stop·crash·sleep 복구 실행 | 논리 시험은 개발 장비에서 모의 환경으로 돈다: `apps/desktop/src/autostart.test.ts`, `apps/desktop/src/data-removal.test.ts`, `apps/desktop/e2e/lifecycle.e2e.ts`(#301 (`7a07952b`)). 설치본 실행 기록 없음(#33 댓글: S46 Windows 11 실행 남음) | 미검증 — Windows 필요 |
| H02-C2a 서명된 업데이트 manifest 검증(Ed25519)·버전·해시 검증과 실행 순서(공용 채널은 `미구현, 배포처 후속`으로 실패) | #301 (`7a07952b`); `apps/desktop/src/update.test.ts` | 증거 있음 |
| H02-C2b runtime·native dependency SBOM 생성 | #301 (`7a07952b`); `apps/desktop/build/sbom.test.ts` | 증거 있음 |
| H02-C2c 제거 때 데이터 보존·삭제 선택 | #301 (`7a07952b`); `apps/desktop/src/data-removal.test.ts` | 증거 있음 |
| H02-C2d 배포 채널·서명 자격·호스팅, 설치 프로그램과의 연결, Windows SBOM(S47·S48) | 미확정. 이슈 본문이 "서명 자격·호스팅 미확정은 명시한다"를 요구하고 #33 댓글이 남은 것으로 기록 | 미검증 — 배포처 필요 |
| H02-C3a CLI가 없어도 비 LLM 기능 사용 가능 | Phase 1의 저하 동작 시험: #73 (`e0ed81db`) `backend/src/degraded.test.ts`, `apps/web/e2e/degraded.e2e.ts` | 증거 있음 |
| H02-C3b Node·Python·DB·Docker 별도 설치 없이 설치본 실행 | 산출물 검사는 개발 OS에서 돈다: `apps/desktop/artifact/artifact.runtime.e2e.ts`(#77 (`7133e8c1`)). 깨끗한 Windows 설치본 확인 없음(#33 댓글: "설치본에서 확인하지 않음") | 미검증 — Windows 필요 |

### H03 보안 부정 테스트·장시간 성능·최종 시나리오 (#34)

| 기준 | 근거 | 판정 |
|---|---|---|
| H03-C1a prompt injection·HTML XSS·path traversal·로컬 API CSRF/DNS rebinding·IPC 우회·권한 교차추론·로그 민감값의 부정 시험(공용 소스 실행 기준) | #280 (`3accdf02`); `backend/src/api.security.test.ts`, `backend/src/ask-gate.test.ts`, `apps/web/src/no-html-sink.test.ts`, `apps/desktop/e2e/shell.security.e2e.ts`, `backend/src/read-gate.test.ts`, `providers/src/log.test.ts`(축별 대응표는 `docs/specs/2026-11-24-H03-C1-security-negative-tests.md`) | 증거 있음 |
| H03-C1b Windows 설치본에서의 sandbox·CSP·경로 처리(역슬래시·드라이브 문자·UNC), 실제 모델의 주입 문장 반응, 실제 CLI 도구 격리 | H03-C1 spec의 "미검증 범위"가 H03-C3으로 넘김 | 미검증 — Windows 필요 |
| H03-C2a 공용에서 도는 측정 실행기(유휴 CPU·RSS, 처리·검색 p50/p95, LLM 호출 수, 저장 증가율, 강제 종료 복구)와 개발 장비 값 | #297 (`1e966a48`) #316 (`f15aba81`); `backend/src/system-measure.test.ts`, `backend/src/system-measure.kill.test.ts`, `backend/src/system-measure.signal.test.ts`, `eval/results/h03-c2-dev.json`. 개발 장비(M1, 8GB)는 R05의 기준 등급이 아니다. 결과 파일의 값은 이 기준의 충족이 아니다 | 증거 있음 |
| H03-C2b R05 고정 환경(등급 A Windows 11, 코퍼스 T2)에서의 installer 크기·idle CPU/RSS·p95·장시간 안정성·실제 Provider | 그 환경과 설치 파일이 없음(#34 댓글: A등급 Windows·T2 코퍼스·설치본 크기·장시간·실제 Provider 미검증) | 미검증 — Windows 필요 |
| H03-C3 최종 시나리오 FS01~FS14를 Windows 설치본에서 증거 링크로 매핑, 실제 provider와 mock 구분, 미달·미검증은 release blocker | `git grep -n "FS01"`을 `origin/main`에서 찾으면 `docs/specs/2026-11-24-H03-C1-security-negative-tests.md`의 한 줄(넘김 문장)뿐이다. 매핑 표·검사 실행기는 이 시점에 없고, 다른 세션이 브랜치 `feat/h03-c3-final-scenarios`에서 작업 중이나 미머지다. FS 시나리오 목록은 총괄 #1 본문에 있다 | 증거 없음 |

## 3. 남은 항목

| 종류 | 항목 |
|---|---|
| 열린 후속 이슈(H01) | #270 백업·복원 지적과 이어 붙일 곳(장부 쪽 틈, 암호화 드라이버, Windows 실측), #298 H01 후속 묶음 지적 |
| 열린 후속 이슈(H02) | #295 제거·업데이트·SBOM 지적(A2는 잠금을 놓은 뒤의 틈, 중간 등급) |
| 열린 후속 이슈(H03) | #279 H03-C1 후속(F2: 셸 시작 실패 줄이 `error.message`를 그대로 stderr에 씀), #296 측정 실행기 지적, #304 백엔드 잠금 지적. #296의 지적 12건을 다룬 H03C2F 묶음은 PR #316 (`f15aba81`)으로 머지됐으나 #296 이슈는 아직 open이다 |
| 열린 하위 이슈 | #32(`in-progress`), #33(`blocked`), #34(`in-progress`) |
| 선행 | Windows 설치본(R04, #13)과 배포처 결과 반영(R07, #37)이 H02·H03의 전제다 |
| 보류 | 없음(느린 정규화기 시험 C49·C17은 Phase 2 항목) |
| 의도적으로 하지 않은 것 | 없음 |

## 4. 결론

공용 범위에서 확인된 것: 백업·복원·세대별 embedding 교체(H01-C1a·b, C2a·b·c, C3a), 업데이트 서명 검증·SBOM·제거 시 데이터 선택(H02-C2a·b·c), 보안 부정 시험(H03-C1a), 측정 실행기와 개발 장비 값(H03-C2a)은 머지된 PR과 존재하는 시험 파일로 뒷받침된다.

남은 것: H02-C1·C3b와 H03-C1b·C2b는 Windows 11 설치본이 있어야 하고, H02-C2d와 H01-C3b는 배포처 결정·환경이 필요하다. 정본 DB 암호화는 보류, H03-C3(최종 시나리오 매핑)은 증거가 없다. 따라서 Phase 7은 가장 많이 남은 Phase이며 Gate는 충족되었다고 선언하지 않는다. 에픽이 요구하는 "최종 14개 시나리오 통합 통과"는 아직 시작 전이다.
