# 스펙: 복원·잠금 결정 묶음(RLD) — 마무리되지 않은 복원본은 제 상태를 스스로 말한다

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D7 포함)
- 관련: 이슈 #298, #304. [H01 spec](2026-11-23-H01-backup-restore.md)(H01-R11~R13), [H01F spec](2026-11-24-H01F-followups.md)(R1·R2·R7, D8), [LKH spec](2026-11-24-LKH-lock-hardening.md)(D7), [SLF spec](2026-11-24-SLF-shell-lifecycle-followups.md)(D7), [BRG spec](2026-11-24-BRG-backup-restore-guards.md)
- 번호: 요구사항 `RLD-R<n>`, 완료 기준 `RLD-C<n>`, 결정 `RLD-D<n>`, 작업 `RLD-T<n>`. **마이그레이션, 계약(API·셸 메시지) 변경은 없다.**
- 기준 코드: `origin/main` `7f19330a`. 아래의 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

| 말 | 뜻 |
|---|---|
| 복원본 | 백업 파일에서 풀어 `pki.sqlite` 자리에 들어간 DB |
| 마무리 | 복원본으로 처음 시작할 때 한 트랜잭션으로 하는 일(`finishRestore`, H01-R12): 실행 중 작업 회수, **전송 동의 모두 지움**, **읽을 수 있는 로컬 폴더 위치 멈춤**, 투영 다시 만들기 요청, 기록(`restore.last`) |
| 이전 사본 | 복원 전의 DB. `pki.sqlite.before-restore` |
| 표식 | 복원이 어디까지 갔는지 적은 파일 `restore/pending.json`. DB 밖에 있다 |
| 미완 표시 | 이 묶음이 더하는 것. 복원본 **안**의 설정 행 `restore.pending`. "이 DB는 아직 마무리되지 않은 복원본"이라는 뜻 |

## 배경

앞선 spec들이 "설계 필요"로 미룬 줄을 지금 코드와 대조했다. 고칠 결함은 **하나**다.

**결함.** 복원본이 마무리되지 않았다는 사실을 아는 것은 DB 밖의 표식과 이전 사본뿐이다. 시작은 표식이 `failed`·`rolling-back`이거나 없으면 `pki.sqlite`를 "복원 전 데이터"로 믿고 연다. 사용자가 파일을 손으로 치우면 그 믿음이 틀린다.

1. 복원본으로 바꾼 뒤 시작이 실패해 되돌리려는데 이전 사본이 SQLite 파일이 아니다 → `restore-previous-unverified`로 멈춘다(표식 `rolling-back`).
2. 사용자가 이전 사본만 치운다.
3. 다음 시작: 치울 사본이 없으니 되돌림이 "끝난 것"이 되고 표식이 `failed`로 바뀐 뒤 그대로 시작한다. `pki.sqlite`는 복원본인데 마무리가 돌지 않는다. **백업 시점의 전송 동의가 살아 있고, 그 뒤 권한을 거둔 폴더가 `active`로 읽힌다.**

같은 일이 `restore-state-inconsistent`·`restore-before-orphaned`·`restore-marker-unreadable`의 "지금 것을 쓰려면 사본(과 `restore` 폴더)을 옮긴다" 길에서도 생긴다. 표식만으로는 "되돌림이 이름 바꾸기까지 하고 꺼진 것(정본은 이전 데이터)"과 "사용자가 사본을 치운 것(정본은 복원본)"을 가를 수 없다. 둘 다 `rolling-back`에 사본 없음이다.

| 줄 | 분류 | 근거(`7f19330a`)와 처리 |
|---|---|---|
| #298·#304 사본만 치우면 마무리 없이 시작 | **결함(이번)** | `backend/src/restore-boot.ts:130-140`(사본이 없으면 `undoSwap`이 아무것도 하지 않음), `:173-181`(`failed`로 적고 `applied: false`로 돌려줌), `backend/src/boot.ts:327`(마무리는 `applied`일 때만). R1~R4 |
| #298 복구 절차를 운영 문서로(H01F-D8) | **문서(이번)** | `docs/site-setup.md`에 `restore-`로 시작하는 이유가 한 줄도 없다(217-219줄의 S43만 있음). R5 |
| #304 F2 잠금 없이 뜬 백엔드 | 보류 유지 | `backend/src/boot.ts:336-340`, `backend/src/backend-lock.ts:30-58` 그대로다. D5 |
| #304 F6 시작 실패 때 잠금이 runner보다 먼저 풀림 | 보류 유지(사유 고침) | `backend/src/boot.ts:233`·`:528` 그대로다. 읽어 보니 창은 `runner.start()` 뒤만이 아니다. D6 |
| #304 F4, F5, 미측정 | 시험·측정 | 동작 변경이 아니다. 이슈에 둔다 |

## 목표

1. 마무리되지 않은 복원본은 표식과 이전 사본이 어떻게 되었든 **마무리 없이 시작하지 않는다.**
2. 이전 사본이 남아 있는 동안에는 앱이 어느 파일도 지우지 않는다.
3. 복구 절차가 운영 문서(`docs/site-setup.md`) 한 곳에 있다.

## 비목표

- **마이그레이션, 표식 파일의 새 상태, 새 시작 실패 이유, 셸(`apps/desktop`) 변경.** 있는 설정 표와 있는 이유(`restore-state-inconsistent`)만 쓴다.
- **F2·F6의 수정**(D5·D6), 잠금 모델, `backend/src/backend-lock.ts`.
- **이 변경 전에 준비된 복원**: 미완 표시가 없으므로 지금과 같다(D4).
- 시작 실패 문구의 고침, 화면 변경, Windows 실측, 시험 보강만인 줄.
- reflect·wiki·feedback 저장소, `backend/src/feedback-api.ts`, `backend/src/page-store.ts`(다른 세션의 범위).

## 요구사항

- **RLD-R1 준비는 복원본에 미완 표시를 적는다.** `stageRestore`는 준비 파일의 설정 행 `restore.pending`에 이 복원의 요약(`RestoreSummary`의 JSON)을 쓴다. 사본에 이미 그 키가 있으면 덮는다(사본의 값은 믿지 않는다). 표식 `staged`를 쓰기 전, 준비 파일을 디스크에 내리기(`syncPath`) 전이다.
- **RLD-R2 마무리는 표시를 지운다.** `finishRestore`의 트랜잭션이 `restore.last`를 쓰는 것과 **같은 커밋**에서 `restore.pending` 행을 지운다. 되돌림으로 돌아온 이전 데이터에는 이 행이 애초에 없다.
- **RLD-R3 표시가 남은 DB는 마무리하고 시작한다.** *(변이 확인 대상)* 시작이 정본을 연 직후, 이번 시작이 복원을 적용한 것이 아닌데(`applied`가 거짓) `restore.pending`이 있고 이전 사본이 없으면, 그 요약으로 `applied`를 참으로 만든다. 그 뒤는 평소의 복원 시작과 같다: `vectors` 폴더를 비우고, 장부를 다시 적용하고, `finishRestore`가 동의를 지우고 폴더를 멈추고 기록한다. 표시 값이 JSON으로 읽히지 않아도 표시는 표시다(요약의 빈 자리는 빈 문자열·`null`).
- **RLD-R4 이전 사본이 있으면 멈춘다.** *(변이 확인 대상)* R3의 조건에서 이전 사본(`pki.sqlite.before-restore`)이 **있으면** `RestoreStateError("restore-state-inconsistent")`로 시작을 멈춘다. DB를 닫고, 어느 파일도 옮기거나 지우지 않는다. 마무리가 사본을 지우기 때문이다(`finishRestore`의 끝). 사용자가 사본을 폴더 밖으로 옮기면 다음 시작이 R3으로 간다.
- **RLD-R5 복구 절차는 운영 문서에 있다.** `docs/site-setup.md`의 "백업·복원의 실측" 절에 H01F spec의 복구 절차(절차 A·B, 이유 다섯의 표)를 옮긴다. 다음 둘을 고쳐 적는다: ① `restore-previous-unverified`에서 이전 사본을 폴더 밖으로 옮기고 시작하면 복원본이 **정상 마무리된다**(동의는 다시 받아야 하고 폴더는 멈춘 상태로 뜬다). 절차 B도 그대로 쓸 수 있다. ② `restore-state-inconsistent`는 `pki.sqlite`가 마무리되지 않은 복원본이면 사본을 옮길 때까지 **매 시작이 멈춘다.** H01F spec의 그 절 머리에는 "운영 문서로 옮겼고 그쪽이 기준"이라는 한 줄만 더한다.

## 인터페이스 / 설계 개요

| 시작 때의 상태 | `restore.pending` | 이전 사본 | 결과 |
|---|---|---|---|
| 표식이 이번 시작에서 복원을 적용(`staged`·`swapped`) | 있음 | 상관없음 | 지금과 같음. 마무리가 표시를 지운다(R2) |
| 그 밖(표식 없음·`failed`·`rolling-back` 뒤) | 없음 | 상관없음 | 지금과 같음 |
| 그 밖 | **있음** | 없음 | 마무리하고 시작(R3) |
| 그 밖 | **있음** | 있음 | `restore-state-inconsistent`로 멈춤(R4) |

- `storage/src/backup.ts`: 상수 `RESTORE_PENDING_SETTING = "restore.pending"`을 내보낸다. 쓰는 자리는 `keepLocalSettings`의 트랜잭션(요약을 `checkAndLift`에 넘긴다).
- `backend/src/restore-boot.ts`: `adoptUnfinishedRestore(db, run)`을 더한다(R3·R4의 한 곳). `finishRestore`의 트랜잭션에 행 지우기 한 줄.
- `backend/src/boot.ts`: `openCanonicalDb` 바로 다음에 그 함수를 부른다. 던지면 DB를 닫고 다시 던진다. `vectors` 폴더를 비우는 줄(`:273`)보다 앞이어야 한다.
- 마무리 전에 다시 실패하면 지금의 되돌림(`rollbackRestore`)이 돈다. 이전 사본이 없으므로 파일은 그대로이고, 표시가 남아 있어 다음 시작이 다시 R3으로 온다. 마무리 없이 뜨는 길은 없다.

그림은 넣지 않는다(갈래가 위 표 하나로 다 적힌다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| RLD-C1 | 동의 한 건과 읽을 수 있는 로컬 폴더 위치 하나가 든 백업을 준비해 복원본으로 바꾼 뒤, 이전 사본을 SQLite가 아닌 파일로 바꾸고 되돌림을 돌리면 `restore-previous-unverified`다. 그 사본을 지우고 `bootBackend`로 시작하면: 시작이 성공하고, 동의가 0건이고, 그 위치가 `paused`이고, `restore.last`가 이 백업의 것이고, `restore.pending`과 `restore/`가 없다(R1·R2·R3) | `backend/src/restore-boot.adopt.test.ts`(새 파일) |
| RLD-C2 | 복원본으로 바꾼 뒤 표식만 `failed`로 적어 이전 사본(온전한 DB)이 남은 상태에서 `bootBackend`는 `restore-state-inconsistent`로 거절하고, `pki.sqlite`와 이전 사본의 바이트가 그대로다(R4) | 같은 파일 |
| RLD-C3 | 평소의 복원(준비 → 시작)이 끝난 정본에는 `restore.pending`이 없다. 시작 실패로 이전 데이터로 되돌아간 정본에도 없고, 그 다음 시작은 동의를 지우지 않는다(R1·R2) | `backend/src/restore-boot.test.ts`(있는 두 사례에 단언 더하기) |
| RLD-C4 | `docs/site-setup.md`에 시작 실패 이유 다섯(`restore-marker-unreadable`·`restore-before-orphaned`·`restore-live-missing`·`restore-state-inconsistent`·`restore-previous-unverified`)과 절차 A·B가 있다(R5) | 문서라 시험이 없다. `grep -c "restore-" docs/site-setup.md`와 검토로 확인 |

경계값·조합의 전수 시험은 하지 않는다. **변이 확인**은 동의·폴더 보호를 정하는 두 줄에만 한다: `boot.ts`의 `adoptUnfinishedRestore` 호출을 지우면 C1이 빨개지고, 그 함수의 이전 사본 검사를 지우면 C2가 빨개져야 한다.

## 잠정 결정

- **RLD-D1 멈추지 않고 마무리한다.** 이전 사본이 없으면 잃을 것이 없고, 마무리는 사용자가 요청한 복원이 원래 하던 일이다(동의는 다시 받으면 되고 폴더는 다시 켜면 된다). 멈추게 하면 절차 B(전부 옮기고 다시 복원)만 남는다. 멈추는 쪽으로 바꾸려면 `adoptUnfinishedRestore`가 사본 유무와 상관없이 던지게 한다.
- **RLD-D2 표시는 DB 안의 설정 행이다.** 표식 파일에 상태를 더하면 사용자가 `restore` 폴더까지 치운 경우를 못 막는다. DB 안의 표시는 파일을 어떻게 옮겨도 DB를 따라간다. 설정 표는 이미 있어 마이그레이션이 없다.
- **RLD-D3 이전 사본이 있으면 지우지 않고 멈추며, 있는 이유 `restore-state-inconsistent`를 쓴다.** 새 이유를 만들면 셸의 목록 두 곳과 문구가 같은 PR에 묶인다. 그 이유의 지금 문구("지금 것을 쓰려면 사본과 restore 폴더를 옮기고…")가 이 상태의 할 일과 같다. 따로 이름을 주려면 `start-failure.ts`와 셸 세 곳에 한 줄씩 더한다.
- **RLD-D4 이 변경 전에 준비해 둔 복원은 보호하지 않는다.** 표시가 없어 지금과 같다. 준비와 다시 시작 사이에 앱을 올린 한 번뿐이다.
- **RLD-D5 F2는 그대로 둔다(LKH-D7 유지).** 닫으려면 모든 백엔드가 공유 잠금을 쥐는 모델로 바꾸거나 잠금 없는 시작을 막아야 한다(P7F-D2를 뒤집음). 잠금 없는 백엔드가 주기적으로 잠금을 다시 얻어 보는 작은 수정은 창을 좁힐 뿐 닫지 못한다. 영향은 개발용 백엔드와 앱을 한 폴더에 띄웠을 때의 작업 한 건 중복 실행까지다(임대 토큰이 옛 실행의 쓰기를 거절).
- **RLD-D6 F6도 그대로 둔다.** 다시 읽은 사실: `wake()`는 `start()` 없이도 작업을 잡는다(`backend/src/job-runner.ts:423-426`, `boot.ts:363`). 그래서 창은 `runner.start()`(`:528`) 뒤만이 아니라 runner가 만들어진 뒤의 모든 실패다. 제품 길은 실패 즉시 프로세스를 끝내(`backend/src/shell-main.ts:145-151`) 잠금과 작업이 함께 사라진다. 제품 밖(시험·소스 실행)에서 바르게 닫으려면 실패한 시작의 runner·스케줄러·로컬 파일 감시·DB를 차례로 거두는 정리가 필요하고, 시작 중간에 실패를 넣는 시험 틈도 새로 만들어야 한다. 작지 않다. 출발점: `holder`에 runner를 실어 `boot.ts:233`의 잠금 풀기 앞에서 `runner.stop()`을 기다린다.
- **RLD-D7 시작 실패 문구는 고치지 않는다.** `restore-previous-unverified`의 문구는 절차 B를 말하고 그 절차는 여전히 맞다. 더 쉬운 길(사본만 옮기기)은 운영 문서에만 적는다.

## 요구사항별 파일

| 요구사항 | 파일 |
|---|---|
| R1 | `storage/src/backup.ts` |
| R2·R3·R4 | `backend/src/restore-boot.ts`, `backend/src/boot.ts`(호출 한 곳), 시험 `backend/src/restore-boot.adopt.test.ts`(새 파일)·`backend/src/restore-boot.test.ts` |
| R5 | `docs/site-setup.md`, `docs/specs/2026-11-24-H01F-followups.md`(한 줄), `docs/README.md`(색인 한 줄) |

## 미검증 범위

- Windows 설치본에서의 동작(S43의 실측 대상).
- 표시 값이 읽히지 않는 경우(R3의 마지막 문장)는 시험하지 않는다.

## 이슈에 두는 것

- #304 F2, F6(D5·D6의 사유와 출발점), F4(동작 차이 0), F5(시험 보강), 미측정 세 줄.
- #298 F5(`.partial` 정리의 시계), F6(부하에서의 시간 초과), F7(문구), R4 메모리 상한 실측, F3(부모 spec 문장).
- `restore-previous-unverified` 시작 실패 문구에 "사본만 옮겨도 된다"를 더하는 일(D7).
