# 스펙: LCF·HOC 화면 후속 묶음(UIF) — 옛 세션의 늦은 답, 백엔드 없는 고르기 안내, 다시 읽기 중 오류 보존, 시험 보강

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D5 포함)
- 관련: 이슈 #342(F1~F4, LCF-D4), #346(F1~F4). [LCF spec](2026-11-24-LCF-location-curation-followups.md), [HOC spec](2026-11-24-HOC-heading-order-curation.md), [DPF spec](2026-11-24-DPF-deferred-features.md)
- 번호: 요구사항 `UIF-R<n>`, 완료 기준 `UIF-C<n>`, 결정 `UIF-D<n>`. **마이그레이션·계약·백엔드 변경 없음. `apps/web`만 고친다.**
- 기준 코드: `origin/main` `6dd14e78`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

## 배경

| 줄 | 분류 | 처리 |
|---|---|---|
| #342 F1 | 문서(**반영함**) | DPF 변이 ① 문장이 두 검사를 함께 빼면 C1이 빨개지는 것처럼 읽혔다. C1의 가린 항목은 자기 묶음 대표라 묶음 대표 검사(`backend/src/read-gate.ts:287`)가 계속 거르므로 C1은 초록이고, 빨개지는 것은 LCF-C4뿐이라고 고침 |
| #342 F2 | 문서(**반영함**) + D3 | DPF 변이 ①·LCF-R4·LCF-C4의 "같은 원본 합집합" 문구를 "`rowOk`는 두 항목의 원본, `itemOk`는 상대 항목 하나의 원본"으로 고침. `itemOk` 단독 가드 시험은 두지 않음(D3) |
| #342 F3 | 동작(잠재) | `DistinctMarksSection`이 `useMemo(() => createMarksSession(api, …), [api])`(`apps/web/src/entity-distinct.tsx:121`)라 `api`가 바뀌면 새 세션이 새 `latest`를 만들고, 옛 세션의 진행 중 읽기는 자기 `latest`로는 여전히 "가장 새것"이라 새 세션의 상태를 덮는다(`:75`·`:84`). 지금 `api`는 앱 시작에 한 번 만든다(`apps/web/src/main.tsx:18`). R1 |
| #342 F4 | 문구 | `PICK_BACKEND_UNAVAILABLE_TEXT`(`apps/web/src/local-locations-text.ts:87-88`)가 "위치를 추가하지 못했습니다"라 다시 연결(`local-locations.tsx:101`)에서도 추가로 읽힘. R2 |
| LCF-D4 | 동작(안내 누락) | 백업 폴더 고르기(`apps/web/src/backup.tsx:218-219`)가 `failed`를 읽지 않아 백엔드가 없으면 아무 말 없이 끝남. R2 |
| #346 F1 | 시험 | HOC-C1 e2e가 알림에서 피드만 검사해 `h1`뿐이다(`apps/web/e2e/a11y.e2e.ts:65-69`·`:255-261`). 요약 내용 제목(`apps/web/src/notifications.tsx:269`)·타임라인 날짜 제목(`:327`)은 시험이 없다. R5, D4 |
| #346 F2 | 시험 | 탐색의 `changed: reload`(`apps/web/src/explore.tsx:473-474`·`:520`)가 읽기 약속을 돌려주는 것(HOC-D4)을 되돌려도 초록. R3 |
| #346 F3 | 동작(낮음) | 합치기 되돌리기는 다시 읽기를 기다린 **뒤** `setNotice(undefined)`를 부른다(`apps/web/src/entity-curation.tsx:219-220`). 검색(`:140-156`)은 잠금 밖이라 그 사이 도착한 검색 오류가 지워진다. R4 |
| #346 F4 | 문서(**반영함**) | 잠금은 새 상태가 화면 갱신 큐에 들어간 뒤 풀린다(그려진 뒤가 아님). HOC 목표 문장을 고침. 같은 뜻의 코드 주석(`entity-curation.tsx:59`·`:122`)은 R4에서 고침 |

## 목표

- 다른 세션·다른 항목의 늦은 답이 "다른 것" 목록을 덮지 않는다.
- 백엔드가 없어 고르기를 넘기지 못하면 추가·다시 연결·백업 폴더 모두 같은 중립 문구로 알린다.
- 합치기 되돌리기 중 도착한 검색 오류가 남는다.
- 탐색 다시 읽기의 약속과 알림의 두 제목을 시험으로 묶는다.

## 비목표

- `.sub-title`의 실제 브라우저 모양 확인(#346 남은 줄), `apps/web`·위 spec 셋·a11y e2e 밖의 변경.
- 다른 세션이 쥔 파일: `backend/src/composition.ts`, `backend/src/local-files-connector.test.ts`.
- 배포처 정책을 쓰는 `itemOk` 단독 가드 시험(D3), 합치기·나누기의 await 개별 시험(D5).

## 요구사항

- **UIF-R1** "다른 것" 목록의 세션은 요청 순서 판정(`latest`)을 컴포넌트 수명 동안 하나로 공유한다. `createMarksSession(api, view, latest)`가 `latest`를 받고, `DistinctMarksSection`은 `useState(createLatest)`로 만든 하나를 넘긴다. `api`가 바뀌어 세션이 새로 만들어져도, 옛 세션의 읽기·풀기 답은 새 세션이 요청을 시작한 뒤에는 상태·안내를 쓰지 않는다. D1
- **UIF-R2** 고른 경로를 백엔드에 넘기지 못한 답(`failed: "backend-unavailable"`)의 문구는 추가·다시 연결·백업 폴더 어디서나 맞는 중립 문장 하나다(예: "백엔드가 응답하지 않아 고른 폴더나 파일을 넘기지 못했습니다. 잠시 뒤에 다시 시도해 주세요."). 백업 화면은 `backup.tsx`에서 내보내는 `pickBackupFolder(pick, choose)`로 고르기를 돌리고, 그 함수는 `failed`면 문구를 돌려주며 `choose`를 부르지 않고, 표가 있으면 `choose({ ticket })`, 취소면 아무것도 하지 않는다. 화면은 돌려받은 문구를 거절 자리(`backup.tsx:322`)에 보인다. D2
- **UIF-R3** `createExploreSession(...).changed(id)`는 그 다시 읽기의 약속을 돌려주고, 약속은 `show.read`가 불린 뒤에 끝난다(지금 동작을 시험으로 묶음). `Neighbourhood`의 `onChanged` 타입(`explore.tsx:235`)을 `() => unknown`으로 맞춘다.
- **UIF-R4** 합치기 되돌리기는 되돌리기 답을 받은 뒤, 다시 읽기를 **시작하기 전에** 안내를 지운다. `unmergeAndReread(api, mergeId, keepDistinct, onChanged, onUnmerged)`가 `unmerge` → `onUnmerged()` → `await onChanged()` 순으로 부르고, 컴포넌트는 `:220`의 지우기를 없애고 `() => setNotice(undefined)`를 넘긴다. 주석 `:59`·`:122`의 "shown"을 "다시 읽은 상태가 큐에 들어갈 때까지"의 뜻으로 고친다.
- **UIF-R5** HOC-C1의 `heading-order` e2e는 알림에서 피드에 더해 타임라인 탭과, 요약 탭에서 연 요약 내용(`내용 보기: 매일 요약 …`)을 각각 검사한다. D4

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 · 빨개져야 하는 변이 |
|---|---|---|
| UIF-C1 | `latest` 하나를 공유한 세션 둘에서 옛 세션의 `load(1)`이 끝나기 전 새 세션이 `load(2)`를 시작하고 끝내면, 그 뒤 옛 읽기가 끝나도 상태는 항목 2의 목록이다(R1) | `apps/web/src/entity-distinct.test.tsx` 새 사례 "UIF-C1". **`6dd14e78`에서 빨강**(세션마다 `latest`). 변이: 세션 안에서 `createLatest()`를 다시 만들면 빨강 |
| UIF-C2 | `pickBackupFolder`에 `{ ticket: null, failed: "backend-unavailable" }`을 주는 `pick`이면 `PICK_BACKEND_UNAVAILABLE_TEXT`를 돌려주고 `choose`는 0회, `{ ticket: "t" }`면 `choose`가 `{ ticket: "t" }`로 1회 불리고 `undefined`다(R2) | 새 파일 `apps/web/src/backup.test.tsx`. **`6dd14e78`에서 빨강**(함수 없음). 변이: `failed` 갈래를 지우면 빨강 |
| UIF-C3 | 다시 읽기(`exploreItem`)를 붙잡아 둔 채 `session.changed(1)`의 약속은 끝나지 않고, 읽기를 풀면 `show.read`가 불린 뒤 약속이 끝난다(R3) | `apps/web/src/explore.test.tsx` 「늦은 응답」 묶음 새 사례 "UIF-C3". 처음부터 초록. 변이: `changed: (id) => void reload(id)`면 빨강 — 이슈가 바로 이 변이를 지적했으므로 한 번 확인 |
| UIF-C4 | `unmergeAndReread`의 부름 순서가 `unmerge` → `onUnmerged` → `onChanged`이고, `onChanged` 안에서 적힌 안내가 끝까지 남는다(R4) | `apps/web/src/entity-curation.test.tsx` 「HOC-C3」 묶음 새 사례 "UIF-C4"(기존 HOC-C3 사례는 다섯째 인자를 더해 고침). **`6dd14e78`에서 빨강**. 변이: 지우기를 `await onChanged()` 뒤로 옮기면 빨강 |
| UIF-C5 | 브라우저 e2e에서 알림의 타임라인 탭과 연 요약 내용을 `heading-order` 규칙으로 검사하면 위반이 0이다(R5) | `apps/web/e2e/a11y.e2e.ts` 「heading-order」 사례. 처음부터 초록. 변이: `notifications.tsx:327`의 `h2`를 `h3`로 되돌리면 빨강(실행은 요구하지 않음) |

경계값·조합의 전수 시험은 하지 않는다. 변이 확인은 보안·자료 보호 가드가 아니므로 요구하지 않고, 이슈가 변이를 직접 지적한 C3만 한 번 확인한다(규칙 5). UIF-R2의 문구 변경은 시험하지 않는다(기존 `local-locations.test.tsx:84`·`:88`이 상수를 쓰므로 그대로 통과).

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| UIF-D1 | `latest`만 공유하고 세션은 `api`가 바뀔 때 새로 만든다. 풀기 중 잠금(`busy`)은 세션마다 둔다 | 예전 코드가 `latest`를 공유해 막던 방식 그대로다. 새 세션이 새 `api`로 요청해야 맞다. 지금 `api`는 한 번만 만들어져 잠재 결함이라 가장 작은 수정을 고름 | 세션을 한 번만 만들고 `api`를 ref로 읽게 한다 |
| UIF-D2 | 새 백업용 문구를 만들지 않고 `PICK_BACKEND_UNAVAILABLE_TEXT` 하나를 중립 문장으로 고쳐 백업 화면도 쓴다 | 셸의 답(`failed`)이 하나이고 뜻도 같다. 문구 표가 둘이면 어긋난다 | `backup-text.ts`에 백업 전용 문구를 두고 `pickBackupFolder`가 그것을 돌려준다 |
| UIF-D3 | `itemOk` 단독 가드 시험(빈 범위 목록을 거절하는 배포처 정책)은 두지 않는다 | 공용 제품은 기본 정책만 싣고, 그 정책에서는 상대 원본이 가려지면 두 검사가 함께 거절한다(LCF-C4가 두 겹을 함께 지운 변이로 이미 가드). 배포처 정책의 시험은 배포처 포크 몫이다 | `entity-distinct-marks.test.ts`에 그런 정책을 주입한 사례를 두고 `itemOk`만 지운 변이로 빨강 확인 |
| UIF-D4 | #346 F1은 spec 문장 정정이 아니라 e2e 검사를 넓힌다 | 이 묶음은 `apps/web` 화면 파일을 바꿔 PR 전 `pnpm e2e`가 어차피 필요하다(머지 규칙 2). 더하는 것은 탭 두 번 누르고 검사 두 번이라 비용이 작고, `notifications.tsx:269`·`:327`에 처음으로 가드가 생긴다. HOC-C1의 "고치기 전에는 알림에서 위반" 문장도 참이 된다 | HOC-C1 문장에서 "알림"을 빼고 e2e는 그대로 둔다 |
| UIF-D5 | 합치기·나누기의 `await onChanged()`는 따로 시험하지 않는다 | 같은 `attempt`와 같은 한 줄이고, 되돌리기(HOC-C3·UIF-C4)와 탐색 쪽 약속(UIF-C3)이 대표한다(규칙 1) | 합치기·나누기 규칙도 컴포넌트 밖 함수로 빼서 HOC-C3 모양의 사례를 둔다 |

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다.
- R1이 제품에서 닿는 길(지금은 `api`가 바뀌지 않는다). R2의 실제 Electron 대화 상자. 화면 쪽은 DOM 없는 함수 시험으로만 본다(X02F-D5).
- Electron e2e 묶음, Windows, 실제 화면 낭독기.

## 작업

PR 하나, 구현자 한 명. 전체 시험은 PR 직전에 한 번(`pnpm e2e` 포함 — 화면·e2e 파일이 바뀐다). 시험 파일·검증 명령은 작업 지도(`_workspace/pki-uif/phase2_architect_design.md`)에 있다. 머지되면 #342·#346 모두 남은 줄이 없으므로 닫는다(#346의 `.sub-title` 줄은 다른 이슈로 옮기거나 미검증으로 남긴다는 댓글을 단다).

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #342·#346의 남은 지적을 코드와 대조해 동작 셋·시험 둘·문서 셋·결정 다섯으로 정리 |
