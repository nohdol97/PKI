# 스펙: 알림 관문 시험 묶음(NGT) — 시험이 붙지 않은 알림 가드 여섯 줄

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D4 포함)
- 관련: 이슈 #251(NTF 진행 로그의 남은 지적, FU7·FU10·FU-H), #287(D1). [NTF spec](2026-11-24-NTF-notify-followups.md)(NTF-R1·C1), [P02 spec](2026-11-23-P02-notifications-digest-timeline.md)(P02-R7), [P5F spec](2026-11-24-P5-followups.md)(P5F-R4)
- 번호: 요구사항 `NGT-R<n>`, 완료 기준 `NGT-C<n>`, 결정 `NGT-D<n>`. 마이그레이션·계약 변경 없음.

## 배경

아래 여섯 줄은 코드는 이미 맞게 동작하지만(`origin/main` 57bb0a87에서 대조), 그 동작을 지우거나 바꿔도 빨개지는 시험이 없다.

| 줄 | 코드 | 지금 시험의 빈 곳 |
|---|---|---|
| #251 C1 Y쪽 | `knowledge-engine/src/notify-gate.ts:44`~`48`이 X·Y 끝 항목을 모두 묻는다 | `backend/src/notify-gate.test.ts:183`의 `hideEndItem`을 X에만 쓴다(`:212`, `:229`). `:48`의 Y 조건을 지워도 초록 |
| #251 C1 "이미 보냄" | flush의 `settle`이 줄을 철회한다(`backend/src/notify-outbox.ts:129`~`136`) | `:222` 시험이 flush 뒤 줄 상태를 단언하지 않는다 |
| #251 FU10 | `deliveryVerdict`의 숨김 분기(`notify-gate.ts:89`) | scan 때의 숨김은 `notify-rules.ts:38`이 먼저 막아 `:139` 시험은 이 분기를 지나지 않는다. 대기열에 든 뒤 숨기는 시험이 없어 분기를 지우면 줄이 철회 대신 요약(`muted`)으로 내려가도 초록 |
| #251 FU7 | 부팅 배선 `backend/src/boot.ts:415`~`426`(추출 성공 → scan 깨움, `notify` 성공 → flush) | `notifyChannel`을 넘겨 부팅하는 시험이 없다. `notify-flow.test.ts`는 자기 runner를 꾸려 이 배선을 거치지 않는다 |
| #251 FU-H | `notify-read.ts`의 `act`가 요약 줄에도 `read`·`dismiss`를 적용 | HTTP 조치 시험(`notify-flow.test.ts:255`)은 Insight 줄만 다룬다 |
| #287 D1 | 알림 줄도 선호 가중을 순위에 싣는다(`notify-read.ts:106`~`111`) | 음수 선호를 단언하는 시험은 목록·근거 응답뿐(`feedback-api.test.ts:225`) |

뺀 줄은 없다. 여섯 줄 모두 실제 빈 곳이다.

## 목표

1. 알림 직전 확인의 가림 판정(끝 항목 양쪽, 사용자의 숨김)이 지워지면 시험이 빨개진다.
2. 부팅한 백엔드에서 추출 → scan → OS 내보내기가 이어지는 것, 요약 줄의 HTTP 조치, 알림 줄의 음수 선호가 저장소 안 시험으로 묶인다.

## 비목표

- 화면(`apps/web/src/notifications.tsx`), #251 FU3·FU12(결정 대기), FU-G(요약 줄 두 번 닫기의 답 차이 — 단언하지 않는다).
- 부팅 시계를 내보내기에 넘기기(#251 FU5), 줄마다 `visible` 두 번 부르기(성능).
- 가려진 요약 줄에 대한 조치의 `not-found`(조치 쪽 가림). 목록 쪽은 FU4 시험이 이미 본다.
- KGT(세션 77)의 K01·K02 파일(`reflection*`, `wiki*`, Insight 위키 쪽)과 HOC 후속(#346) 화면 파일.

## 요구사항

- **NGT-R1** Y 끝 항목만 가려진 Insight도 X와 똑같이 알림 직전 확인에서 막힌다: scan이면 `withdrawn/none`·메시지 0건·읽지 않은 수 0, 이미 `sent`로 나간 줄이면 flush 뒤 `withdrawn/cancelled`·메시지 0건·읽지 않은 수 0.
- **NGT-R2** 줄이 대기열(`sent/queued`)에 든 뒤 사용자가 Insight를 숨기면(`irrelevant`) flush가 메시지를 보내지 않고 줄은 `withdrawn/cancelled`가 된다(요약으로 내려가지 않는다).
- **NGT-R3** 부팅한 백엔드(`bootBackend`, `notifyChannel` 주입)에서 가져오기의 추출이 성공하면 scan이 깨어 중요한 Insight의 줄을 `sent`로 쓰고, 그 `notify` 작업이 끝나면 내보내기가 메시지 한 건(`kind: "insight"`)을 채널로 보낸다.
- **NGT-R4** 요약 줄(daily)에 `POST notificationAct`의 `read`는 `applied`이고 목록의 그 행 `readAt`이 채워지며, `dismiss`는 `applied`이고 그 행이 `digests`에서 빠진다.
- **NGT-R5** 유형 단계가 켜져 있고 숨긴 형제가 싫다는 표시를 받았을 때, 알림 줄의 `insight.ranking.preference`는 음수이고 같은 Insight의 `GET /api/insights` 값과 같다.

시험이 고치기 전에 빨갛게 나오면 그 줄은 결함이다. 그때는 해당 요구사항이 가리키는 코드 자리 하나만 최소로 고치고 이 spec 변경 이력에 적는다(NGT-D1).

## 완료 기준

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| NGT-C1 | 끝 항목 X·Y 각각을 가렸을 때 R1의 두 경우(scan, 이미 보냄)가 그대로 나온다. `notify-gate.ts`의 Y 조건을 지우면 Y 경우가 빨개진다(R1) | `backend/src/notify-gate.test.ts` 「notify.gate ③」 |
| NGT-C2 | 대기열에 든 줄의 Insight에 `irrelevant`를 기록하고 flush하면 메시지 0건, 줄 `withdrawn/cancelled`다. `notify-gate.ts`의 숨김 분기를 지우면 빨개진다(R2) | `backend/src/notify-gate.test.ts` 「user's feedback」 |
| NGT-C3 | 중요한 Insight를 둔 채 부팅하고 가져오기를 하면, 추출이 끝난 뒤 가짜 채널에 `kind: "insight"` 메시지가 한 건 있고 그 Insight의 줄이 `sent`다(R3) | `backend/src/notify-booted.test.ts`(새 파일) |
| NGT-C4 | daily 요약 줄 하나에 `read` → `applied`·`readAt` 채워짐, `dismiss` → `applied`·`digests`에서 빠짐(R4) | `backend/src/notify-flow.test.ts` 「the user's actions」 |
| NGT-C5 | R5의 상황에서 `notifications` 응답의 그 줄과 `insights` 응답의 `ranking.preference`가 같은 음수다(R5) | `backend/src/notify-flow.test.ts` |

기준마다 대표 사례 하나다. 변이 확인은 C1·C2(보호 검사)에만 한다. 기존 알림 시험은 고치지 않고 통과해야 한다(C1의 매개변수화와 단언 한 줄 추가는 예외).

## 잠정 결정

- **NGT-D1 시험만 더한다.** 제품 코드는 시험이 고치기 전에 빨간 경우에만, R이 가리키는 자리 하나를 고친다. 바꾸려면 이 절을 고친다.
- **NGT-D2 C3은 새 파일 하나로 부팅한다.** 내보내기가 부팅 시계를 받지 않으므로(FU5) Insight의 기한은 벽시계 기준 +2일로 두고, 방해 금지는 설정 경로로 끈다. FU5를 고치면 시계를 주입하는 쪽으로 바꾼다.
- **NGT-D3 C5는 숫자(-25)가 아니라 "음수이고 목록과 같다"를 단언한다.** P5F-R4의 약속이 "어느 응답에서나 같은 값"이기 때문이다. 숫자까지 고정하려면 단언을 바꾼다.
- **NGT-D4 C4는 FU-G를 단언하지 않는다.** 두 번 닫기의 답(`not-found`·`refused`)은 정해지지 않은 차이라 지금 값을 시험으로 굳히지 않는다.

## 미검증 범위

- 실제 Electron·OS 알림(C3은 가짜 채널), 배포처 범위 정책(C1·C2는 시험용 정책).
- C3이 10분 주기 scan이 아니라 추출의 깨움으로 실행됐다는 인과는 독립 검토에서 `boot.ts`의 깨움 연결을 없애는 변이로 한 번 확인했다(시험이 빨개짐). 저장소 안의 변이 시험은 두지 않는다. `notifyOutbox.flush()` 쪽 연결은 변이 확인하지 않았다.
- 조치 쪽에서 가려진 요약 줄의 `not-found`(비목표).

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(확정, 잠정 결정 포함) | 전체 | #251 NTF 남은 지적·FU7·FU10·FU-H와 #287 D1을 코드와 대조해 시험 묶음으로 정함 |
