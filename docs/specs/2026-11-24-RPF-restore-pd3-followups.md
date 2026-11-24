# 스펙: RLD·PD3 후속 묶음(RPF) — 시험 넷과 문서 정정

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1 포함)
- 관련: 이슈 #338(F1~F3), #340(F1~F4). [RLD spec](2026-11-24-RLD-restore-lock-decisions.md), [PD3 spec](2026-11-24-PD3-pending-decisions.md)
- 번호: 요구사항 `RPF-R<n>`, 완료 기준 `RPF-C<n>`, 결정 `RPF-D<n>`. **제품 코드·마이그레이션·계약 변경은 없다.**
- 기준 코드: `origin/main` `ba960478`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다.

## 배경

두 묶음의 독립 검토는 PASS였고 남은 지적은 시험 보강과 문구다. 코드와 대조한 결과 고칠 결함은 없다.

| 줄 | 분류 | 처리 |
|---|---|---|
| #338 F1 | 시험 | RLD-C3의 "다음 시작은 동의를 지우지 않는다"를 단언하지 않는다(`backend/src/restore-boot.test.ts:429-433`, 이전 데이터에 동의가 없다). R1 |
| #338 F2 | 문서(**반영함**) | `docs/site-setup.md`의 `restore-marker-unreadable` 행에 "현재 DB가 마무리되지 않은 복원본이면 그 시작이 마무리한다"를 더함 |
| #338 F3 | 시험 | 읽을 수 없는 미완 표시 갈래(`backend/src/restore-boot.ts:223-228`)에 시험이 없다. R2 |
| #340 F1 | 결정 | 기존 원소 50개 초과 값이 유형 정의 변경을 막는다. D1(유지), PD3-D4 문장에 반영함 |
| #340 F2 | 문서(**반영함**) | PD3-R2에 "중복 제거 전 목록 길이로 센다"를 적음. R4 |
| #340 F3 | 문서(**반영함**) | PD3-D5의 제외 글자를 한중일 공통 글자 53자로 고쳐 적음. R5 |
| #340 F4 | 시험 | 열린 같은 대상 작업이 있을 때, 다시 물은 작업이 해석 없이 끝났을 때를 읽기로만 확인했다. R3 |

## 목표

- 두 spec이 읽기로만 확인한 동작 넷을 저장소 안 시험으로 묶는다.
- 문서 셋을 코드와 맞춘다.

## 비목표

- 제품 코드 변경(시험 파일만 바꾼다). #340 F5(Provider 호출 수 측정), #304 F2·F6.
- 이미 저장된 원소 50개 초과 값을 찾거나 고치는 일(PD3-D4 그대로).
- 다른 세션이 쥔 파일: `backend/src/local-locations.ts`, `apps/web/src/entity-distinct*`, `backend/src/read-gate*`, I02·DPF spec.

## 요구사항

- **RPF-R1** RLD-C3의 되돌림 사례는, 이전 데이터에 있던 전송 동의가 되돌림 다음의 평소 시작 뒤에도 남는 것을 단언한다.
- **RPF-R2** 마무리되지 않은 복원본의 `restore.pending` 값이 JSON이 아니어도, 이전 사본이 없으면 다음 시작이 마무리한다(RLD-R3의 마지막 문장)는 것을 시험한다.
- **RPF-R3** PD3-R1의 두 경계를 시험한다: ① 같은 대상의 열린 작업이 있으면 새 작업을 넣지 않는다 ② 다시 물은 작업이 해석 없이 닫히면 평소 요청(`requestInsightInterpretations`)이 다시 묻지 않는다.
- **RPF-R4**(반영함) PD3-R2의 원소 수는 중복 제거 전 목록 길이다(계약 `SemanticPiecesSchema`의 `.max(50)`과 같은 셈, `storage/src/analytical-types.ts:158`·`:167`).
- **RPF-R5**(반영함) PD3-D5가 말하는 제외 글자는 Script=Common이고 Script_Extensions가 네 글자 체계인 단어 글자 53자다(`node`로 셈).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| RPF-C1 | 이전 데이터에 동의 한 건이 있을 때, 복원 시작이 실패해 되돌아간 뒤의 평소 시작은 동의 1건을 그대로 둔다(R1) | `backend/src/restore-boot.test.ts` 「restore.rollback (H01-R13)」 사례에 단언 더하기 |
| RPF-C2 | 마무리되지 않은 복원본의 `restore.pending`을 JSON이 아닌 글로 바꾸고, 확인되지 않은 되돌림 뒤 이전 사본을 지우고 시작하면: 시작이 성공하고 동의가 0건, 위치가 `paused`, `restore.pending`이 없다(R2) | `backend/src/restore-boot.adopt.test.ts` 새 사례 `C2b` |
| RPF-C3 | PD3-C1의 상황에서 같은 대상에 `queued` 작업이 이미 있으면, 원본을 지운 뒤에도 그 대상의 작업은 1건이다(R3 ①) | `knowledge-engine/src/insight-interpret-deletion.test.ts` 「PD3-R1」 묶음 새 사례 |
| RPF-C4 | PD3-C1로 넣은 작업을 해석 없이 `succeeded`로 닫은 뒤 `requestInsightInterpretations`는 0을 돌려주고 그 대상의 작업 수는 그대로다(R3 ②) | 같은 묶음 새 사례 |

넷 다 지금 동작을 묶는 시험이라 처음부터 통과한다. 대신 각 시험이 빨개지는 변이를 한 번 확인한다(작업 지도에 적음). 문서 정정(R4·R5, #338 F2)은 `pnpm exec vitest run tooling/docs`가 깨지지 않는 것으로 확인한다.

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| RPF-D1 | 원소 50개 초과 기존 값은 그 사실 종류의 유형 정의 변경을 **계속 막는다**(`existing-data-violation`) | 막는 자리는 `factViolations`(`storage/src/ontology.ts:406-409`)가 새 규칙의 값 유형으로 `valueFits`를 부르는 것 → `checkOntologyChange`의 `applicable`(`:500`) → `applyOntologyChange`의 거절(`:610`)이다. 다른 어긋난 기존 값(날짜가 아닌 `date` 따위)과 같은 규칙이고, 값 판정은 한 곳뿐이라는 원칙(S01-R21)을 지킨다. 화면이 "어긋남 N개"를 보여 주고, 사용자가 그 사실을 기각하거나 값을 고치거나 값 유형을 바꾸는 변경이면 풀린다. 데이터 유실은 없다 | `factViolations`에서 기존 규칙도 맞지 않던 줄만 빼거나(변경이 새로 만든 어긋남만 셈), 원소 수 검사를 뺀 판정을 저장된 줄에만 쓴다 |

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했다(R5의 53자만 `node`로 셈). 실제 자료의 원소 50개 초과 줄 수, Windows.
- `restore.pending` 값이 JSON으로 읽히지만 객체가 아닌 경우(`null`): `restore-boot.ts:230`이 `null.backupId`를 읽어 시작이 실패할 것으로 읽힌다. 사람이 DB를 손으로 고친 경우뿐이라 이 묶음에서 다루지 않는다.

## 작업

PR 하나, 구현자 한 명. 시험 파일·검증 명령은 작업 지도(`_workspace/pki-rpf/phase2_architect_taskmap.md`)에 있다. 이 PR이 머지되면 #338은 닫는다(F1~F3 반영, 넷째 줄은 RLD-D5·D6 보류 그대로). #340은 F1~F4를 체크하고 F5가 남아 열어 둔다.

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #338·#340의 남은 지적을 코드와 대조해 시험 넷·문서 셋·결정 하나로 정리 |
