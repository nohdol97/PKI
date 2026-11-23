# 스펙: H01 후속 묶음 — 백업·복원에 남은 정확성·보안·데이터 손실 결함

- 날짜: 2026-11-24 / 상태: 초안(잠정 결정 D1~D9 포함)
- 관련: 이슈 #270(H01 후속), #32(H01). [H01 spec](2026-11-23-H01-backup-restore.md), [H01-C3 spec](2026-11-24-H01-C3-vector-index.md)
- 번호: 요구사항 `H01F-R<n>`, 완료 기준 `H01F-C<n>`, 결정 `H01F-D<n>`, 작업 `H01F-T<n>`

| 말 | 뜻 |
|---|---|
| 표식 | 복원이 어디까지 갔는지 적는 `restore/pending.json`(H01-R9·R11) |
| 이전 데이터 사본 | 바꿔치기 때 옆으로 옮겨 둔 `pki.sqlite.before-restore`. 복원이 마무리되면 지워진다 |
| 머리말 | 백업 파일 앞의 평문 부분. 암호구 없이 읽히고, scrypt 비용 값이 여기 적혀 있다 |

## 배경

H01의 독립 검토 두 건이 "재작업 아님"으로 넘긴 지적과 뒤로 미룬 항목이 이슈 #270에 열세 줄로 남아 있다. 지금 코드(`origin/main` 0b498f93)와 한 줄씩 대조했다. **결함으로 확인된 것이 일곱 요구사항**이고, 나머지는 보류·확인 안 됨·이미 반영이다. 항목 번호는 #270 체크리스트의 순서다.

| # | 이슈 항목 | 분류 | 이 spec | 지금 코드에서 확인한 것 |
|---|---|---|---|---|
| 1 | 새 시작 실패 상태가 분류돼 있지 않고 복구 절차가 없음 | 결함 | R1 | `classify`에 `RestoreStateError`·`RestoreMarkerError`가 없어 이유 없는 실패가 나간다(`backend/src/start-failure.ts:38`). 셸은 모르는 이유를 받으면 "예상 밖의 메시지"로 처리한다(`apps/desktop/src/backend-process.ts:85`·`:263`) |
| 2 | 실패 뒤 취소가 표식만 지워 영구 `restore-before-orphaned` | 결함(데이터 보호) | R2 | `cancel()`이 `failed` 표식이면 사본이 있는지 보지 않고 `restore/`를 지운다(`backend/src/backup-api.ts:263`). 다음 시작은 표식 없이 사본만 보고 멈춘다(`backend/src/restore-boot.ts:169`) |
| 3 | 읽을 수 없는 표식에서 `cancel()`이 `none` | 결함 | R2 | `backup-api.ts:265`. 새 준비도 `already-pending`으로 막혀(`storage/src/backup.ts:429`) 실행 중에는 나갈 길이 없다. 시작 때는 앱이 뜨지 않으므로(`restore-boot.ts:165`) 그쪽은 R1의 안내가 맡는다 |
| 4 | 마무리가 이미 커밋된 복원을 뒤 시작의 실패가 되돌림 | 결함 | R7 | `swapped` 표식이면 `applied`만 참이고 `finished`는 마무리 함수에 닿아야 참이 된다(`restore-boot.ts:193`·`:336`). 그 전에 시작이 실패하면 되돌린다(`backend/src/boot.ts:222`). 고칠 자리는 `boot.ts`가 아니라 `applyPendingRestore`다 |
| 5 | 장부로 인한 "restored" 멈춤의 같은 틈 | 보류 | — | 확인함: 재적용 커밋(`boot.ts:311`)과 폴더 멈춤(`boot.ts:465` → `backend/src/local-files-driver.ts:123`) 사이에 꺼지면 다음 시작은 재적용 건수가 0이라 멈추지 않는다. H01 이전(I04)의 길이고, 고치려면 재적용의 트랜잭션 경계와 다른 세션이 쥔 `boot.ts`의 `driver.start` 인자를 함께 바꿔야 한다. 두 세션이 합친 뒤 따로 정한다 |
| 6 | 머리말의 scrypt 비용을 만든 쪽이 정함, 남는 키가 500 | 결함(보안) | R3 | 상한이 1GiB이고 `p`는 16까지라 기본의 최대 128배 일을 동기로 시킨다(`storage/src/backup-file.ts:33`·`:76`·`:174`). `scrypt` 객체를 통째로 Node에 넘겨(`:86`) `cost` 같은 남는 키가 있으면 `BackupFileError`가 아닌 예외가 나고 처리기가 그대로 다시 던진다(`backup-api.ts:242`) |
| 7 | `createBackup`의 메모리 전체 읽기, 남는 `.partial` | 결함 | R4 | `readFileSync(snapshot)`(`backup.ts:192`). 2GiB를 넘는 파일은 Node가 한 번에 읽기를 거절해 백업 자체가 실패한다(아래 "미검증 범위"). 지우는 `.partial`은 같은 이름뿐이라(`backup.ts:208`) 쓰다 꺼진 파일은 영영 남는다 |
| 8a | 신원 키가 없는 사본은 D8 검사를 건너뜀 | 결함(데이터 보호) | R5 | `theirs !== undefined &&`(`backup.ts:505`). 키 없는 사본은 시작 때 새 키를 받고(`storage/src/identity.ts:246`) 지금 설치의 삭제 장부와 남이 된다 |
| 8b | 설정 행이 검사 없이 백업 시점 값으로 돌아옴 | 결함(보안) | R6 | 준비의 검사 ①~⑥(`backup.ts:477`)에 설정 행을 보는 단계가 없다. Provider 주소가 사본의 값이 되면 이 PC에 남아 있는 API 키가 그 주소로 간다 |
| 8c | 마무리 완료 판정이 복원된 파일의 `restore.last`를 믿음 | 결함(데이터 보호) | R6 | `restore-boot.ts:296`. 사본에 같은 값의 줄이 실려 있으면 동의 지움·폴더 멈춤을 건너뛴다 |
| 9 | 번들 SQLite 판이 오르면 자기 백업이 `foreign-schema`로 거절될 수 있음 | 확인 안 됨 | — | 본 것: 스키마 글의 정확 비교(`backup.ts:391`·`:520`). 다른 판의 SQLite로 만든 파일이 없어 실제로 어긋나는지 볼 수 없다. 시험 보강으로 이슈에 남긴다 |
| 10 | 키 확인 HMAC과 AES-GCM이 같은 키 | 보류 | — | `backup-file.ts:91`. 실질 약점이 없고, 나누려면 파일 형식 판을 올려야 한다 |
| 11 | H01-C3(embedding 교체) | 이미 반영 | — | PR #286(`874517b3`). 옆에 만드는 세대와 한 단계 전환이 규격에 있다(`packages/contracts/src/vector-index.ts:16`·`:29`) |
| 12 | 운영 DB 암호화 드라이버 조사 | 보류 | — | ADR 0010의 "다시 열 조건". 조사 단위 |
| 13 | Windows 설치본 실측 | 보류 | — | 배포처 항목 |

## 목표

1. 복원 때문에 시작이 멈추면 사용자가 **왜 멈췄고 어느 파일을 어떻게 해야 하는지**를 받는다.
2. 화면의 단추가 "매번 시작 실패"인 상태를 만들지 못하고, 읽을 수 없는 표식에서도 실행 중에 빠져나올 수 있다.
3. 남이 만든 백업 파일이 서버를 오래 붙잡거나, 설치 검사를 비켜 가거나, 이 PC의 전송 설정을 바꾸거나, 마무리를 건너뛰게 하지 못한다.
4. 큰 정본도 백업되고, 이미 마무리된 복원이 뒤늦게 되돌려지지 않는다.

## 비목표

- **`boot.ts`·`shell-main.ts`·`composition.ts`·`apps/desktop/src/main.ts` 고치기.** 다른 세션이 쥐고 있다. 5번 항목도 그래서 뺀다.
- **시작이 스스로 고치기.** 읽을 수 없는 표식·고아 사본·모순 상태에서 "아무것도 지우지 않고 멈춘다"(H01-R11, 검토 M2)는 그대로다. 앱이 이전 데이터 사본을 대신 지우거나 되돌리는 단추도 만들지 않는다.
- **scrypt를 비동기·별도 스레드로 옮기기.** 상한만 낮춘다(H01-D11은 그대로).
- **파일 형식 판 올리기**(10번), **SQLite 판 시험**(9번), 드라이버 조사, Windows 실측.
- **마이그레이션.** 없다. 설정 행과 파일만 다룬다.
- **`docs/site-setup.md`·`ARCHITECTURE.md`에 절차 옮겨 적기.** 다른 세션이 쥐고 있어 복구 절차는 이 문서에 둔다(D8).

## 요구사항

- **H01F-R1 복원으로 멈춘 시작은 이유를 말한다.** `startFailureReport`는 `RestoreMarkerError`를 `restore-marker-unreadable`로, `RestoreStateError`를 그 코드가 `restore-before-orphaned`·`restore-live-missing`·`restore-state-inconsistent`·`restore-previous-unverified` 가운데 하나일 때 그 이름으로 보고한다(다른 코드는 지금처럼 이유 없음). 셸은 이 다섯을 받아들이고 이유마다 고정 문구를 보인다. 문구는 경로 없이 파일 이름(`pki.sqlite`, `pki.sqlite.before-restore`, `restore` 폴더)만 들고, **지우라고 하지 않고 "데이터 폴더를 먼저 복사한 뒤 옮기라"**고 말한다. 전체 절차는 아래 "복구 절차" 표다.
- **H01F-R2 이전 데이터 사본이 있으면 취소와 새 준비를 거절한다.** *(변이 확인 대상)*

| 표식 | `before-restore` | `DELETE /api/restore`의 답 |
|---|---|---|
| 무엇이든 | 있음 | `refused`. 아무것도 지우지 않는다 |
| `staged`·`failed`·읽을 수 없음 | 없음 | `restore/`를 지우고 `cancelled` |
| 없음·`swapped`·`rolling-back` | 없음 | `none`(지금과 같음) |

  사본이 있는 동안 `POST /api/restore`도 `already-pending`으로 거절한다(표식만 갈아 끼우고 다음 시작을 다시 멈추게 하지 않도록). `GET /api/backup`은 사본이 있는지를 `previousCopy`로 싣는다. 화면은 그때 "이전 데이터 사본이 데이터 폴더에 남아 있고 그 뒤의 삭제가 이 사본에는 닿지 않는다"와 복구 절차의 요약을 보이고, "알림 닫기"를 내지 않는다. "이전 데이터로 되돌렸습니다"는 실제로 되돌린 코드(`start-failed`·`swap-failed`)에만 쓴다.
- **H01F-R3 머리말은 믿지 않는 입력이다.** *(비용 상한: 변이 확인 대상)* 읽을 때 받아들이는 scrypt 값은 메모리 `128·N·r` ≤ 256MiB이고 일의 양 `N·r·p` ≤ 2^22다(제품 값의 2배·4배). `scrypt` 객체에 `N`·`r`·`p` 말고 다른 키가 있으면 받지 않는다. 둘 다 scrypt를 돌리기 **전에** `damaged`로 답한다. `deriveKey`는 그 세 값만 Node에 넘긴다.
- **H01F-R4 백업은 사본을 조각으로 읽는다.** `createBackup`은 사본의 바이트 수와 SHA-256을 조각 단위로 읽어 구한다(사본 전체를 메모리에 올리지 않는다). 시작할 때 백업 폴더에서 이름이 `pki-backup-*.pkibak.partial`이고 고친 지 1시간이 넘은 파일을 지운다. 그 밖의 파일은 건드리지 않는다.
- **H01F-R5 키 없는 사본은 다른 설치다.** *(변이 확인 대상)* H01-R9 ④에서 준비 파일에 신원 키가 없으면 키가 다른 것과 같이 본다: 지금 정본에 원본이나 tombstone이 있으면 `other-installation`으로 거절한다.
- **H01F-R6 이 PC의 전송·보관 설정은 복원이 바꾸지 않는다.** *(변이 확인 대상)* 준비의 마지막 단계(⑥ 뒤, 표식을 쓰기 전)에서 준비 파일의 설정 행을 한 트랜잭션으로 고친다. ① 키가 `backup.folder`이거나 `providers.`로 시작하는 행은 **지금 정본의 값**으로 바꾼다(지금 정본에 없으면 지운다). ② `restore.last` 행은 지운다. 다른 설정은 백업 시점 값 그대로다.
- **H01F-R7 마무리가 커밋된 복원은 되돌리지 않는다.** *(변이 확인 대상)* `applyPendingRestore`는 표식이 `swapped`일 때 정본 파일의 `restore.last`가 표식의 `backupId`·`stagedAt`과 같으면 `finished`를 참으로 돌려준다(읽지 못하면 거짓). 그러면 그 시작이 어디서 실패해도 되돌림이 돌지 않고, 남은 사본과 표식은 다음에 성공하는 시작의 마무리가 지운다. R6 ②가 있어 이 기록은 이 설치가 커밋한 것뿐이다.

### 복구 절차 (R1의 문서)

먼저 앱을 끄고 **데이터 폴더를 통째로 다른 곳에 복사**한다. 파일은 지우지 말고 폴더 밖으로 옮긴다.

- **절차 A(이전 데이터로 돌아가기)**: `pki.sqlite`가 있으면 밖으로 옮긴다 → `pki.sqlite.before-restore`의 이름을 `pki.sqlite`로 바꾼다 → `restore` 폴더를 밖으로 옮긴다 → 시작한다.
- **절차 B(빈 데이터에서 다시 복원)**: `pki.sqlite`, `pki.sqlite.before-restore`, `restore` 폴더를 모두 밖으로 옮긴다 → 시작한다 → 백업 파일에서 복원한다.

| 이유 | 상태 | 할 일 |
|---|---|---|
| `restore-marker-unreadable` | 표식 파일을 읽을 수 없다. 매 시작이 멈춘다 | `before-restore`가 없으면 `restore` 폴더만 옮기고 시작(지금 데이터 그대로, 복원은 다시 요청). 있으면 절차 A |
| `restore-before-orphaned` | 표식 없이 사본만 있다. 매 시작이 멈춘다 | `pki.sqlite`가 없으면 절차 A. 있으면 앱은 어느 쪽이 맞는지 모른다: 지금 것을 쓰려면 사본만 옮기고, 이전 것을 쓰려면 절차 A |
| `restore-live-missing` | 정본 자리가 비었다. 매 시작이 멈춘다 | 사본이 있으면 절차 A. 없으면 절차 B |
| `restore-state-inconsistent` | 준비 파일·사본·정본이 다 있다. 한 번 멈춘 뒤로는 `pki.sqlite`로 뜨고 사본이 남는다 | 지금 것을 쓰려면 사본과 `restore` 폴더를 옮긴다. 이전 것을 쓰려면 절차 A |
| `restore-previous-unverified` | 사본이 SQLite 파일이 아니다. `pki.sqlite`는 마무리되지 않은 복원본이다. 매 시작이 멈춘다 | 절차 B. 복원본을 그대로 쓰지 않는다(동의 지움·폴더 멈춤이 돌지 않았다) |

옮겨 둔 사본에는 그 뒤에 지운 자료가 남아 있을 수 있다. 확인이 끝나면 사용자가 지운다.

## 인터페이스 / 설계 개요

- **R1**: `start-failure.ts`의 `StartFailureReason`과 `classify`에 다섯 이유. 셸은 `backend-process.ts`의 이유 목록 두 곳(타입과 zod `enum`)에 다섯 줄, `start-failure-text.ts`의 `REASON_TEXT`에 다섯 문구. 백엔드와 셸은 **같은 PR**이어야 한다(셸이 모르는 이유는 메시지 전체가 거절된다).
- **R2**: `backup-api.ts`의 `cancel()`·`restore()`·`status()`. 계약(`backup-types.ts`)은 `CancelRestoreResponseSchema`의 상태에 `refused`, 상태 응답에 `previousCopy`(둘 다 더하기). 화면의 문구 고르기는 `backup-text.ts`의 함수로 빼서 시험한다.
- **R3**: `backup-file.ts`의 `costOk`·`readHeader`·`deriveKey`. 쓰는 쪽은 그대로다.
- **R4·R5·R6**: `backup.ts`의 `createBackup`, `checkAndLift`(④의 조건 한 줄, ⑥ 뒤의 새 단계).
- **R7**: `restore-boot.ts`의 `applyPendingRestore` 한 곳(`swapped` 갈래). 같은 파일의 `readRestoreLast`와 넘겨받은 `open`을 쓴다. `finishRestore`와 `boot.ts`는 고치지 않는다.

그림은 넣지 않는다(서로 독립인 작은 변경이고, 갈래는 R2의 표 하나로 다 적힌다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| H01F-C1 | `RestoreStateError("restore-live-missing")`의 보고는 그 이유를, `RestoreMarkerError`의 보고는 `restore-marker-unreadable`을 싣고, 모르는 코드의 `RestoreStateError`는 이유가 없다. 백엔드가 `restore-before-orphaned`를 보고하면 셸의 문구가 일반 문구가 아니고 `pki.sqlite.before-restore`를 든다(R1) | `backend/src/start-failure.test.ts`, `apps/desktop/src/start-failure.test.ts` |
| H01F-C2 | 표식이 `failed`이고 `before-restore`가 있을 때 취소는 `refused`이고 표식과 사본이 그대로이며 상태가 `previousCopy: true`다. 읽을 수 없는 표식에 사본이 없을 때 취소는 `cancelled`이고 `restore/`가 없어지며 새 준비가 받아들여진다(R2) | `backend/src/backup-api.test.ts` |
| H01F-C3 | 머리말의 scrypt 값이 상한을 넘는 파일(`N`=2^20, `r`=8)과 `scrypt`에 남는 키(`cost`)가 든 파일은 머리말 읽기와 `openBackup`이 `damaged`로 답한다. 제품 기본값의 파일은 지금처럼 읽힌다(R3) | `storage/src/backup-file.test.ts` |
| H01F-C4 | 여러 조각에 걸친 사본을 백업하면 목록표의 바이트 수·SHA-256이 되풀어 낸 사본과 같다. 폴더에 있던 2시간 된 `.partial`은 백업 뒤 없고, 방금 만든 `.partial`과 다른 이름의 파일은 남는다(R4) | `storage/src/backup.test.ts` |
| H01F-C5 | 신원 키 행이 없는 사본은 지금 정본에 원본이 있으면 `other-installation`으로 거절되고 `restore/`가 없다. 지금 정본이 비어 있으면 준비된다(R5) | `storage/src/backup.test.ts` |
| H01F-C6 | `backup.folder`·`providers.openaiCompatible.baseUrl`·`restore.last`가 든 사본을, 두 값이 다른 지금 정본에서 준비하면 준비 파일의 두 설정은 지금 정본의 값이고 `restore.last`가 없으며, 목록 밖의 설정 하나는 백업 시점 값이다(R6) | `storage/src/backup.test.ts` |
| H01F-C7 | 마무리 커밋 직후에 꺼진 상태(`after-commit`)에서 `applyPendingRestore`를 다시 부르면 `finished`가 참이고 정본과 사본이 그대로다. 커밋 전에 꺼진 상태(`before-commit`)에서는 거짓이다(R7) | `backend/src/restore-boot.committed.test.ts`(새 파일) |

경계값·조합의 전수 시험은 하지 않는다. **변이 확인**(지우면 해당 기준이 빨개져야 한다)은 허용·차단을 정하는 다섯 줄에만 한다: R2의 사본 검사(C2), R3의 비용 상한(C3), R5의 키 없음 조건(C5), R6의 설정 고치기(C6), R7의 판정(C7). 기존 시험 한 줄(`backup-api.test.ts`의 "읽을 수 없는 표식의 취소는 `none`")은 R2에 맞게 고친다. `api.contract.test.ts`는 계약에 더한 값으로 그대로 통과해야 한다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **H01F-D1 4번 항목은 이 묶음에서 고친다.** 읽어 보니 `boot.ts`가 아니라 `applyPendingRestore`에서 닫힌다. `restore-boot.ts`는 다른 세션(4f)도 고치지만 그쪽은 `finishRestore` 둘레이고 이쪽은 한 갈래 몇 줄이다. 시험은 새 파일에 둔다. 합칠 때 겹치면 T4만 빼고 이슈에 남긴다(다른 작업이 기대지 않는다).
- **H01F-D2 사본이 있을 때의 취소는 거절만 한다.** 앱이 사본을 지우거나 되돌리면 어느 쪽이 사용자의 데이터인지 모르는 채로 한 파일을 없앤다. 단추로 풀려면 표식 `rolling-back`을 쓰는 경로를 더하고 그 확인 문구를 정한다.
- **H01F-D3 시작 실패 이유는 코드마다 하나(다섯)다.** 할 일이 코드마다 달라 하나로 묶지 않았다. 묶으려면 `classify`의 대응 표를 고친다.
- **H01F-D4 scrypt 상한은 메모리 256MiB, `N·r·p` 2^22다.** 제품 값(128MiB, 2^20)의 2배·4배라 앞으로 값을 한 단계 올린 파일까지 읽힌다. 넘는 파일의 답은 기존 코드 `damaged`다(새 코드를 만들지 않았다). 값은 `backup-file.ts`의 상수다.
- **H01F-D5 `.partial`은 1시간 넘은 것만 지운다.** 같은 폴더를 두 설치가 함께 쓸 때 쓰고 있는 파일을 지우지 않기 위해서다. 암호문이라 급하지 않다.
- **H01F-D6 지키는 설정은 `backup.folder`와 `providers.`로 시작하는 키다.** 어디에 쓰고 어디로 보낼지를 정하는 값이고, 이 PC에 남는 비밀 값(`secrets.json`)과 짝이다. 접두어로 정해 새 Provider 설정이 저절로 든다. 배경 기능 스위치(`wiki.summary`·`insight.interpret` 등)는 백업 시점 값으로 돌아오지만 마무리가 동의를 모두 지워(H01-D9) 전송은 다시 동의해야 열린다. 넓히려면 `backup.ts`의 목록을 고친다.
- **H01F-D7 설정은 준비 때의 값으로 고친다.** 준비와 다시 시작 사이에 바꾼 설정은 다른 변경과 같이 사라진다(H01-R10). 적용 때의 값으로 하려면 마무리(`finishRestore`)가 사본에서 읽어 덮게 한다.
- **H01F-D8 복구 절차는 이 문서와 시작 실패 문구에 둔다.** `site-setup.md`는 다른 세션이 고치고 있다. 그쪽이 합쳐진 뒤 운영 문서로 옮기는 일은 이슈에 남긴다.
- **H01F-D9 R5는 옛 스키마의 정상 백업을 막지 않는다고 본다.** 신원 키는 스키마 14부터 있고 백업 기능은 그보다 뒤에 나왔으므로, 제품이 만든 백업에는 늘 키가 있다.

## 미검증 범위

- **메모리 상한 자체.** C4는 결과가 같음을 볼 뿐, 사본을 통째로 읽지 않는다는 것은 검토가 diff로 본다. "2GiB를 넘으면 한 번에 읽기가 거절된다"는 개발 PC의 Node v26.5.0에서 3GiB 빈 파일로 본 것이고(`ERR_FS_FILE_TOO_LARGE`), 저장소가 고정한 Node 24와 실제 크기의 정본에서는 재지 않았다.
- **상한 안의 scrypt 시간.** 제품 값의 4배까지는 여전히 요청 하나가 서버를 붙잡는다. Windows 저사양에서의 시간은 재지 않았다.
- **Windows·Electron 실행.** 시작 실패 문구가 실제 대화상자에 뜨는 것, 파일 옮기기 절차는 실행해 보지 않는다. 화면 변경에 새 E2E는 더하지 않는다(문구 함수의 단위 시험).
- **손으로 고친 뒤의 상태.** `restore-previous-unverified`에서 사본만 치우고 시작하면 마무리되지 않은 복원본으로 뜬다. 절차가 그것을 금하지만 코드가 막지는 않는다(이슈에 남긴다).
- **6번의 "500".** 처리기가 예외를 다시 던지는 것까지 읽었고, 서버가 그것을 어떤 응답으로 바꾸는지는 다시 확인하지 않았다.
- **5번·9번 항목.** 5번은 재적용 함수 안의 트랜잭션 경계를 읽지 않았다.

## 작업 분해

PR 하나, 한 worktree에서 차례로 한다. 자세한 설명은 작업 폴더의 설계 보고에 있다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 증거 |
|---|---|---|---|---|---|
| H01F-T1 | 저장 계층: 머리말 검사, 조각 읽기와 `.partial` 치우기, 준비의 설치·설정 검사 | C3, C4, C5, C6 | 없음 | `storage/src/backup-file.ts`, `storage/src/backup.ts`와 두 시험 파일 | 두 시험의 통과 출력, 변이 셋(C3·C5·C6)의 빨간 출력 |
| H01F-T2 | 백엔드: 취소·새 준비 거절과 `previousCopy`, 시작 실패 이유 다섯 | C1(백엔드), C2 | T1 | `backend/src/backup-api.ts`, `backend/src/start-failure.ts`와 두 시험 파일, `packages/contracts/src/backup-types.ts`(더하기) | 두 시험과 `api.contract.test.ts`의 통과 출력, 변이 하나(C2)의 빨간 출력 |
| H01F-T3 | 셸과 화면의 문구: 이유 다섯의 수용과 문구, 사본 경고와 실패 문구 | C1(셸), C2(화면 문구) | T2 | `apps/desktop/src/backend-process.ts`(목록 두 곳에 줄 더하기), `apps/desktop/src/start-failure-text.ts`, `apps/desktop/src/start-failure.test.ts`, `apps/web/src/backup.tsx`, `apps/web/src/backup-text.ts`·`backup-text.test.ts` | 두 시험의 통과 출력, PR 직전 `pnpm e2e`의 기존 `backup.e2e.ts` 통과 |
| H01F-T4 | 커밋된 복원을 되돌리지 않기, H01 spec의 가리키는 줄과 이력 | C7 | T1 | `backend/src/restore-boot.ts`(`applyPendingRestore`의 `swapped` 갈래만), 새 파일 `backend/src/restore-boot.committed.test.ts`, `docs/specs/2026-11-23-H01-backup-restore.md`(R10·R11·D7에 이 spec을 가리키는 줄, 이력) | 새 시험과 기존 `restore-boot.test.ts`의 통과 출력, 변이 하나(C7)의 빨간 출력 |

`backend-process.ts`는 세션 53이, `restore-boot.ts`는 세션 4f가 다른 자리를 고치고 있다. 이 묶음은 적힌 자리만 고치고, 나중에 합치는 쪽이 rebase한다. `docs/README.md`에는 색인 한 줄만 더한다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | 이슈 #270의 열세 항목을 코드와 대조해 결함 일곱 요구사항을 한 묶음으로 정함 |
