# 스펙: 백엔드 관문·수명 주기 묶음(BGL) — 기다리던 관계가 다시 말해졌을 때의 판정 자리, 데이터 폴더 링크 거절 시험

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D5 포함)
- 관련: 이슈 #291(착수 선언), #209(N1, 상세는 #5의 진행 로그), #221, #220, #237, #249, #295. [S03 spec](2026-11-22-S03-analytical-semantic.md)(S03-R16), [P3D spec](2026-11-24-P3D-pending-decisions.md)(P3D-R3·R4·D5·D7), [SLF spec](2026-11-24-SLF-shell-lifecycle-followups.md)
- 번호: 요구사항 `BGL-R<n>`, 완료 기준 `BGL-C<n>`, 결정 `BGL-D<n>`, 작업 `BGL-T<n>`. **마이그레이션과 계약 변경은 없다.**
- 기준 코드: `origin/main` `88d970d8`. 아래의 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

| 말 | 뜻 |
|---|---|
| 길 관계 | 검사가 필요한 사실이 실제 표에 닿는 관계 셋: `MEASURED_ON`·`JOIN_LEFT`·`JOIN_RIGHT` |
| 기다리는 행 | 길 관계가 문서의 새 version에 물려(`superseded`) 그 문서의 추출을 기다리는 행(S03-R16). 기다리는 동안은 "표를 잃음" 판정을 미룬다 |
| 자리 | "표를 잃음"을 판정하는 때. S03-R16이 ①~④로 적는다. ③은 "기다리던 원본의 추출이 결과를 쓴 때"다 |
| 다시 말해짐 | 새 version의 추출이 같은 관계를 또 내어, 물렸던 관계가 되살아나는 것(`evidenceReturned`) |

## 배경

여러 후속 이슈에 미뤄져 있던 일곱 줄을 지금 코드와 한 줄씩 대조했다. **고칠 결함은 하나**(#209 N1)이고, **시험이 없는 데이터 보호 가드가 하나**(#295 A5)다. 나머지 다섯 줄은 지금 제품에서 닿을 수 없거나, 이미 닫혔거나, 비용 항목이다.

| 줄 | 분류 | 이 spec | 지금 코드에서 확인한 것 |
|---|---|---|---|
| #209 N1: Dataset이 기각된 동안 기다리던 관계를 다음 추출이 다시 말하면 판정 자리가 없음 | **결함(관문의 상태)** | R1 | 아래 "고치는 한 건" |
| #295 A5: 데이터 폴더가 링크면 거절하는 가드에 빨개지는 시험이 없음 | **시험 보강(데이터 보호 가드)** | R2 | 가드는 `apps/desktop/src/data-removal.ts:69`~`:76`. `data-removal.test.ts`의 링크는 폴더 **안의** 링크 하나뿐이고(`:46`), 데이터 폴더 자체가 링크인 시험이 없다. 가드를 지우면 표시 파일 검사(`:78`)와 `readdirSync`(`:93`)가 링크를 따라가 **링크가 가리키는 폴더의 내용을 지운다** |
| #291: 시작 실패 때 `boot.ts`가 벡터 색인·정본 DB를 닫지 않음 | 지금은 결함 아님 | — | 시작이 실패하면 프로세스가 끝난다: 셸 쪽은 `process.exit(1)`(`backend/src/shell-main.ts:145`~`:150`)이고 한 프로세스에 시작은 한 번이다(`:171`). 개발 실행도 최상위 `await`라 같다(`backend/src/dev.ts:34`). 복원 되돌리기는 정본을 스스로 닫는다(`backend/src/restore-boot.ts:148`). 실제 벡터 색인은 `vectorIndexing`으로만 묶이는데 제품 코드에 그 값을 주는 곳이 없다(쓰는 파일은 `boot.ts`·`composition.ts`·`vector-index.boot.test.ts` 셋) |
| #291: 삭제 작업이 통지의 embed와 겹치면 벡터 검색이 꺼짐(`markStale`) | 지금은 닿지 않음 | — | 사실이다: 실행 중에 낡음 표시가 서면 재구축을 청하는 곳은 다음 시작의 `reconcile`뿐이다(`knowledge-engine/src/projections.ts:188`~`:196`, `:272`~`:279`). 다만 벡터 쓰기 길 전체가 위 `vectorIndexing` 뒤에 있어 제품에서는 돌지 않는다. 그 값을 켜는 작업의 선행 조건으로 이슈에 둔다 |
| #221 F4: 요약·사실 줄의 항목 이름이 계보 관문 밖 | 이미 닫힘 | — | 요약과 사실 줄에 들어가는 이름은 Insight의 두 끝 항목뿐이다(`knowledge-engine/src/insight-code-rules.ts:155`·`:455`·`:456`·`:473`). 읽기 관문은 두 끝 항목이 모두 보일 때만 Insight를 낸다: 목록(`backend/src/read-gate.ts:328`~`:339`), 근거(`:349`), 이어 걷기(`:496`), Wiki(`backend/src/wiki-read.ts:110`~`:113`). P01-R15·P5F-R2가 넣었다 |
| #220: 가져오기의 커밋과 엔진 전달 사이의 틈 | 지금은 닿지 않음 | — | 틈은 있다: 전달은 커밋 뒤 줄 세워 돌고(`backend/src/page-store.ts:330`), 그 전에 다른 깨우기가 추출을 잡을 수 있다. 잃는 것은 엔진의 제안뿐인데(`knowledge-engine/src/extraction.ts:242`) 제품에 묶인 엔진은 제안이 없는 빈 엔진이다(`backend/src/composition.ts:208`~`:210`). 실제 엔진을 꽂는 작업의 선행 조건으로 이슈에 둔다 |
| #237: `late.manager`가 없어도 다시 훑기가 `queued` | 닿지 않음 / 낮음 | — | `late.manager`는 서버가 생기기 전에 채워진다(`backend/src/boot.ts:450`, 서버는 `:481`). 요청이 그 사이에 올 수 없다. `sync`가 `connector-unavailable`을 답하는 갈래(`backend/src/connectors.ts:805`)는 `local-files` 인스턴스가 준비되지 않았을 때뿐이고, 공용 제품에서 그 상태에 이르는 길을 찾지 못했다. 자료는 바뀌지 않는다 |
| #249 F4·F7: `threads()`의 제곱 비용, 긴 참여자 이름 | 비용·한도(결함 아님) | — | 제곱이 되는 것은 답글이 한 줄로 길게 이어지거나 한 스레드가 아주 큰 입력뿐이고(`packages/document-normalize/src/formats/docx.ts:181`~`:194`), 호스트의 시간 한도가 그 파일 하나를 실패로 끝낸다. F7은 호스트 규약의 길이·개수 한도(`:202`·`:203`)이고 본문에는 전체 이름이 남는다. 느린 정규화기 영역이라 지금 건드리지 않는다 |

### 고치는 한 건이 실제로 무엇을 깨는가

P3D는 "사용자가 기각한 Dataset에 기대어 `verified`이던 사실은 그 기각과 같은 호출에서 이의에 걸린다"를 넣었다(P3D-R4). 그런데 그때 길 관계가 **기다리는 중**이면 판정이 미뤄지고, 미뤄진 판정을 받아 줄 자리가 한 갈래에서 빠져 있다.

1. Metric의 계산 기준이 `verified`이고, 그 Metric이 `MEASURED_ON`으로 표에 묶인 Dataset을 가리킨다. 이 관계의 근거는 문서 A에 있다.
2. 문서 A의 새 version이 들어와 관계가 물린다(기다리는 행). 계산 기준은 `verified` 그대로다.
3. 사용자가 그 Dataset 항목을 기각한다. 판정(`judgeItemAction`)은 **살아 있는** 관계의 주체만 모으므로 이 Metric을 보지 않는다(`storage/src/analytical-gate.ts:358`~`:365`). 기다리는 행을 건너뛰는 것 자체는 S03-R16대로다(`:349`).
4. 문서 A의 추출이 같은 관계를 다시 말한다. 관계가 되살아난다(`knowledge-engine/src/extraction.ts:864`). 자리 ③(`judgeWaitingOn`)은 **아직 기다리는** 관계만 보므로(`analytical-gate.ts:380`) 되살아난 이 관계를 보지 않는다.
5. 결과: 계산 기준이 `verified`인데 조건 `no-dataset`이 참인 채 남는다. 다음 자리(표 삭제, 그 행에 대한 다른 사용자 조치)가 오지 않으면 계속 남는다.

읽기는 그 행에 `no-dataset`을 함께 보여 주므로 값이 조용히 틀리게 나가지는 않는다. 틀린 것은 상태다: 사용자가 표를 기각했는데 그 표에 기댄 사실이 확정으로 남는다.

## 목표

- 기다리던 길 관계가 다시 말해진 추출에서도, 그 주체의 `verified` 사실이 표를 잃었으면 같은 트랜잭션에서 판정된다.
- 데이터 폴더가 링크일 때의 거절 가드를 지우면 빨개지는 시험이 저장소에 있다.

## 하지 않는 것

- 이미 저장된 행을 찾아다니며 고치는 일. P3D-D7 그대로다(마이그레이션 없음).
- 기다리는 동안의 판정을 앞당기는 일(S03-R16의 "기다리는 행" 규칙을 바꾸지 않는다).
- 위 표에서 "닿지 않음"·"이미 닫힘"·"비용"으로 분류한 다섯 줄의 코드 변경. `boot.ts`, `page-store.ts`, `job-runner.ts`, `projections.ts`, `docx.ts`는 건드리지 않는다.
- #295의 다른 시험 보강(부분 실패 뒤 종료 코드, `FILE` 이름 정규식 등), `apps/web`, 알림 파일, `README.md`.

## 요구사항

- **BGL-R1 추출이 다시 말한 길 관계도 자리 ③에서 판정한다.** 추출이 결과를 쓴 트랜잭션에서, 지금의 `judgeWaitingOn` 바로 뒤에, 그 추출이 근거를 붙인 관계(`judgedRelations`) 가운데 **길 관계이고 살아 있는 것**마다 관계 기각(S03-R16의 ②)과 **같은 판정**을 한다: 주체의 `verified`인 검사가 필요한 사실이 `no-dataset`이고 기다리는 행이 아니면 표를 잃는다. 근거 번호는 그 관계의 대상(Dataset 항목)의 표 원본과 그 현재 version, 이유 코드는 `data-basis-lost`다.
  - 판정은 기존 `judgePathCut`을 그대로 쓴다(`analytical-gate.ts:341`). 관문은 관계 ID만 받고 유형 이름은 관문 안의 SQL만 본다(S01-R4).
  - 표가 한 번도 프로파일된 적이 없으면 아무것도 읽지 않는다(`anyTable`, `:46`).
  - 대상에 표 묶음이 없으면 근거가 없어 움직이지 않는다(지금의 `lose`와 같다. `:235`).
  - Dataset이 기각되지 않았으면 `no-dataset`이 거짓이라 아무 일도 하지 않는다. 가르지 않고 항상 부른다.
- **BGL-R2 데이터 폴더가 링크면 지우지 않는다는 것을 시험이 붙잡는다.** 제품 코드는 바꾸지 않는다. `data-removal.ts:76`의 가드를 지운 변이에서 그 시험이 빨개져야 한다.

### 바꾸는 자리

| 파일 | 바꾸는 것 |
|---|---|
| `storage/src/analytical-gate.ts` | 관계 ID 목록을 받아 R1의 대상마다 `judgePathCut`을 부르는 함수 하나를 `judgeWaitingOn` 옆에 더해 내보낸다 |
| `storage/src/index.ts` | 그 함수의 내보내기 한 줄 |
| `knowledge-engine/src/extraction.ts` | `judgeWaitingOn` 호출(`:965`) 다음 줄에서 `judgedRelations`로 그 함수를 부른다 |
| `docs/specs/2026-11-22-S03-analytical-semantic.md` | S03-R16의 자리 ③ 문장에 "다시 말해진 길 관계의 주체도 같은 때에 판정한다"와 이 spec 가리킴, 변경 이력 한 줄 |

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| BGL-C1 | 표에 묶인 Dataset을 `MEASURED_ON`으로 가리키는 `verified` 계산 기준이 있고 그 관계의 근거 문서에 새 version이 들어와 관계가 물렸을 때: ㉮ 사용자가 그 Dataset 항목을 기각한 뒤 새 version의 추출이 같은 관계를 다시 내면, 그 추출 뒤 계산 기준이 `disputed`이고 마지막 이력 줄이 주체 `policy`, 이유 `data-basis-lost`, 근거가 그 표 원본과 현재 version이다 ㉯ 기각하지 않은 같은 흐름에서는 추출 뒤에도 `verified`다(R1) | `knowledge-engine/src/extraction.test.ts`(`gate.lost` 묶음, G-C4 ③ 옆) |
| BGL-C2 | 데이터 폴더 경로가 PKI 데이터 폴더처럼 보이는 실제 폴더(`pki.sqlite`가 든)를 가리키는 링크일 때 `delete`를 고르면, 코드 1과 "is not a data folder" 줄을 답하고 **가리키는 폴더의 파일과 링크가 그대로 남는다**(R2) | `apps/desktop/src/data-removal.test.ts` |

C2는 데이터 보호의 차단 가드라 **변이 확인을 한다**: `data-removal.ts:76`의 한 줄을 지운 채 C2 시험이 빨개지는 것을 한 번 보고 되돌린다(백업 복사본으로 복원). 가드를 지워도 마지막 `rmdirSync`가 링크에서 실패해 **코드는 그대로 1**이므로, 빨개지는 단언은 "파일이 남는다"와 문구다. 코드만 단언하면 가드가 아니다. C1은 상태 판정이라 변이 확인을 요구하지 않는다.

경계값·조합의 전수 시험은 하지 않는다(길 관계 셋 가운데 `MEASURED_ON` 하나, Dataset 상태 가운데 `rejected` 하나). 기존 시험 `extraction.test.ts`의 나머지와 `storage/src/analytical-gate.test.ts`는 고치지 않고 그대로 통과해야 한다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **BGL-D1 N1은 받아들인 잔여가 아니라 빠진 자리로 본다.** P3D-D7이 받아들인 것은 **그 변경 전에 이미 저장된** 행을 찾아다니지 않는다는 것이다. N1은 변경 뒤의 사용자 조치가 시점 때문에 판정을 못 받는 길이고, P3D-R4가 약속한 결과("기각과 같은 판정")가 나오지 않는다. S03-R16은 "한 번 놓친 행도 다음 때에 잡힌다"고 적지만 이 길에는 다음 때가 정해져 있지 않다. P3D의 결정은 하나도 되돌리지 않는다. 빼려면 `extraction.ts`의 호출 한 줄과 C1을 지운다(그 행은 다음 자리까지 `verified` + `no-dataset`으로 남는다).
- **BGL-D2 자리는 추출의 ③에 둔다.** 기각 시점(②)에 기다리는 행까지 판정하면 "기다리는 행은 추출을 기다린다"는 S03-R16의 규칙을 깨고, 새 version이 그 관계를 더는 말하지 않는 경우와 두 번 겹친다. 추출 뒤에는 관계가 살아 있는지가 정해져 있다. ②로 옮기려면 `judgeItemAction`의 SQL을 "살아 있거나 기다리는"으로 넓히고 `judgePathCut`의 기다림 건너뛰기를 그 호출에서만 끈다.
- **BGL-D3 다시 말해진 관계만이 아니라 그 추출이 근거를 붙인 길 관계 모두를 본다.** "방금 되살아났는가"를 따로 가르려면 이력을 한 번 더 읽어야 하는데, 판정 자체가 `verified` + `no-dataset` + 기다리지 않음일 때만 움직이므로 넓게 불러도 결과가 같다. 덧붙는 효과 하나: P3D-D7이 남긴 옛 행도 그 관계의 문서가 다시 추출될 때 판정된다(D7의 "자리가 그 행을 볼 때 판정된다" 그대로다). 좁히려면 새 함수 안에서 마지막 이력 줄이 되살림인 관계만 남긴다.
- **BGL-D4 닿지 않는 다섯 줄은 코드를 넣지 않고 이슈에 둔다.** 벡터 색인의 닫기와 `markStale`은 `vectorIndexing`을 켜는 작업의, 가져오기와 엔진 전달의 틈은 실제 엔진을 꽂는 작업의 선행 조건이다. 지금 넣으면 닿지 않는 코드에 시험만 는다. 넣으려면 그 작업의 spec에 요구사항으로 적는다.
- **BGL-D5 A5는 시험만 더하고 가드는 그대로 둔다.** 가드는 맞게 동작한다(읽기로 확인). 같은 줄의 "파일이면 거절"과 #295의 다른 시험 보강은 넣지 않는다(테스트 간략화 규칙: 대표 한 건). 더하려면 `data-removal.test.ts`에 건을 더한다.

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다. **N1의 재현은 C1 ㉮ 시험이 먼저 빨개지는 것으로 확인한다.** 추출이 기각된 Dataset 항목에 관계를 다시 잇지 않아(다른 항목을 새로 만드는 등) 시험이 고치기 전에도 초록이면, R1은 닿지 않는 길이므로 넣지 않고 그 사실을 보고한다.
- `JOIN_LEFT`·`JOIN_RIGHT`와 Dataset 자신의 사실은 같은 함수의 같은 고리라 따로 시험하지 않는다.
- #237의 `connector-unavailable` 갈래: `local-files` 인스턴스가 시작 뒤 준비되지 않은 상태가 되는 길을 끝까지 좇지 않았다.
- Windows(링크·junction의 동작), Electron, 배포처 정책, 실제 정본에서 영향받는 행 수.
- 동료 브랜치 `fix/ntf-followups`는 원격에 없어 로컬 브랜치와 작업 폴더 상태로만 봤다: 겹치는 파일은 `docs/README.md` 하나다(줄 덧붙임, 뒤에 머지하는 쪽이 rebase).

## 작업 분해

PR 하나, 한 worktree에서 한 사람이 이어서 한다. 전체 시험은 PR 직전에 한 번만 돈다.

| 작업 | 산출물 | 기준 | 선행 | 건드리는 파일 | 검증 명령 |
|---|---|---|---|---|---|
| BGL-T1 | 다시 말해진 길 관계의 판정 자리와 시험, S03-R16 문장 | C1 | 없음 | `storage/src/analytical-gate.ts`, `storage/src/index.ts`, `knowledge-engine/src/extraction.ts`, `knowledge-engine/src/extraction.test.ts`, `docs/specs/2026-11-22-S03-analytical-semantic.md` | `pnpm exec vitest run knowledge-engine/src/extraction.test.ts storage/src/analytical-gate.test.ts` |
| BGL-T2 | 링크인 데이터 폴더 거절 시험과 변이 확인 기록 | C2 | 없음 | `apps/desktop/src/data-removal.test.ts` | `pnpm exec vitest run apps/desktop/src/data-removal.test.ts` |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | 여러 후속 이슈에 미뤄진 일곱 줄을 코드와 대조해, 결함 한 건(#209 N1)과 시험 없는 데이터 보호 가드 한 건(#295 A5)만 남김 |
