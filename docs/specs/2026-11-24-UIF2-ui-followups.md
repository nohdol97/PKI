# 스펙: 화면 후속 둘째 묶음(UIF2) — 점검 보고의 분기·늦은 답·길이 안내, 피드백 두 번 누름, 질문 화면 진행 안내·시간대

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 D1~D4 포함)
- 관련: 이슈 #356(CUF 검토의 남은 줄 7개), #358(F1~F3). [CUF spec](2026-11-24-CUF-curation-ui.md), [UIF spec](2026-11-24-UIF-ui-followups.md), [LCF spec](2026-11-24-LCF-location-curation-followups.md)
- 번호: 요구사항 `UIF2-R<n>`, 완료 기준 `UIF2-C<n>`, 결정 `UIF2-D<n>`. **마이그레이션·계약·백엔드 변경 없음. `apps/web`만 고친다.**
- 기준 코드: `origin/main` `543811a5`. 아래 `파일:줄`은 그 커밋에서 열어 읽은 자리다(실행한 것은 아니다).

## 배경

| 줄 | 분류 | 처리 |
|---|---|---|
| #356 점검 보고 문구 | 문구 | 찾기 실패(`apps/web/src/lint-report.tsx:66`)가 보내기 실패와 같은 `reportFailedText`(`lint-text.ts:90`, "알리지 못했습니다: …")를 써서 찾기가 알리기 실패로 읽힘. R3 |
| #356 늦은 답이 고른 항목을 지움 | 동작(낮음) | 알리기 답이 `applied`면 `setPicked([])`(`lint-report.tsx:85`)로 고른 것을 모두 지워, 답을 기다리는 동안 새로 고른 항목도 사라진다. R2 |
| #356 200자 안내 없음 | 동작(안내 누락) | 찾기 입력(`lint-report.tsx:126-130`)에 길이 제한이 없어 201자부터 서버가 거절한다(`EXPLORE_QUERY_MAX`, `packages/contracts/src/explore.ts:12`). R3 |
| #356 있음/없음/오류 분기 시험 없음 | 시험 | 보내기의 답 분기(`lint-report.tsx:73-90`)가 컴포넌트 안에 있어 시험이 닿지 않는다(웹 단위 시험에 DOM 없음, X02F-D5). R1 |
| #356 피드백 두 번 누름 | 동작(낮음) | `useRecord`의 누름(`apps/web/src/feedback.tsx:46-61`)과 두 목록의 취소(`:159-169`, `:234-244`)에 잠금이 없다. 취소를 두 번 누르면 둘째가 404를 받아 "더 이상 없음" 안내가 잘못 뜬다. R4 |
| #356 0문장 진행 안내 겹침 | 문구 | 답 문장이 0개로 끝나면 진행 알림(`apps/web/src/ask-text.ts:91`)이 "끝났습니다. 답 0문장"이라, 같은 때 뜨는 다른 상태 문단(`ask.tsx:189`의 `ASK_NO_SENTENCES`, 또는 `:205`의 답 상태)과 같은 말을 겹쳐 읽는다. CUF-R5("다른 문단이 말하지 않는 단계")와도 어긋남. R5 |
| #356 C5 시간대 | 시험 | CUF-C5(`apps/web/src/ask.test.tsx:363-391`)는 현지 시각 단언이라 UTC 기계에서는 고치기 전 코드에도 초록이다(CUF spec 미검증 범위). R6 |
| #358 F1 | 시험(**받아들이고 닫음**) | `DistinctMarksSection`이 `latest` 하나를 넘기는 자리(`apps/web/src/entity-distinct.tsx:122-126`)는 컴포넌트 배선이라 DOM 없는 단위 시험이 닿지 않는다. 규칙은 이미 `createMarksSession`으로 빠져 UIF-C1이 본다. D3 |
| #358 F2 | 시험 | `pickBackupFolder`(`apps/web/src/backup.tsx:37-45`)의 취소(`ticket: null`, `failed` 없음) 사례가 `backup.test.tsx`에 없다. R7 |
| #358 F3 | 문서(**반영함**) | LCF-R2가 옛 문구 "위치를 추가하지 못했습니다"를 인용했다. 지금 상수(`local-locations-text.ts:88`)의 중립 문장으로 고치고 UIF-R2를 가리킴 |
| #358 `.sub-title` | 비목표 | 실제 브라우저 모양 확인. 이 묶음에서 다루지 않는다 |

## 목표

- 점검 보고의 보내기 답 분기를 시험으로 묶고, 늦은 답이 새로 고른 항목을 지우지 않게 하며, 찾기 실패와 길이 한도를 찾기의 말로 알린다.
- 피드백 기록·취소는 답을 기다리는 동안 두 번째 누름을 보내지 않는다.
- 질문 화면의 끝 알림이 다른 문단과 같은 말을 겹치지 않고, 날짜 시험은 어느 기계에서나 가드가 된다.

## 비목표

- `.sub-title`의 실제 브라우저 모양(#358 남은 줄), 백엔드·계약 파일, e2e 파일.
- 단위 시험용 DOM 환경(jsdom 등) 도입(D3).
- 점검 보고의 찾기(`find`) 늦은 답 — 이미 `createLatest`로 막혀 있다(`lint-report.tsx:59-64`).

## 요구사항

- **UIF2-R1** `lint-report.tsx`가 `sendReport(api, request)`를 내보낸다. 한 번 보내고 거절하지 않는 약속으로 `{ notice: { text, alert }, clear, reread }`를 준다: `applied` → `REPORT_APPLIED`, clear·reread 참 / `exists` → `REPORT_EXISTS`, reread만 참 / `not-found` → `REPORT_NOT_FOUND`, 둘 다 거짓 / 실패 → `reportFailedText(…)`, `alert: true`, 둘 다 거짓. 컴포넌트는 `busy` 안에서 이것을 부르고 결과대로 안내·고른 것·다시 읽기를 처리한다.
- **UIF2-R2** 알린 뒤 고른 것은 보낸 항목만 뺀다. `withoutSent(picked, request)`가 `request.a`·`request.b`가 아닌 항목만 순서대로 남기고, 컴포넌트는 `setPicked((p) => withoutSent(p, request))`로 부른다.
- **UIF2-R3** 찾기 실패의 안내는 `lint-text.ts`의 새 `reportSearchFailedText(message)`("찾지 못했습니다: …")다. 찾기 입력은 `maxLength={EXPLORE_QUERY_MAX}`이고, `REPORT_HINT` 끝에 이름은 200자까지 찾는다는 문장을 덧붙인다(숫자는 `EXPLORE_QUERY_MAX`에서). D1
- **UIF2-R4** `feedback.tsx`가 `createFeedbackCalls(api)`를 내보낸다. `record(target, kind)`와 `undo(id)`는 `createBusy` 하나를 함께 써서, 앞 부름의 답이 오기 전의 부름은 보내지 않고 `undefined`를 준다. 보낸 부름은 거절하지 않는 약속으로 `{ text, changed }`(지금 문구 규칙 그대로: 거절 사유·404의 `FEEDBACK_GONE`·"보내지 못했습니다/취소하지 못했습니다: …", `changed`는 성공 또는 404)를 준다. `useRecord`·`RecentFeedback`·`ItemFeedback`은 컴포넌트마다 하나(`useMemo(…, [api])`)를 만들어 쓰고, 두 목록의 같은 취소 코드는 이것으로 합친다. D2
- **UIF2-R5** `progressText`는 답 0문장으로 끝나면 "끝났습니다."만 말한다(문장 수는 다른 문단이 말한다). 1문장 이상은 지금 그대로다.
- **UIF2-R6** CUF-C5 시험은 시간대를 `Asia/Seoul`로 고정한 동안(`process.env.TZ`, 끝나면 되돌림) 보낸 `from`·`to`를 ISO 문자열 그대로 단언한다.
- **UIF2-R7** `backup.test.tsx`에 취소(`{ ticket: null }`) 사례를 더한다: `choose` 0회, 답 `undefined`.

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 · 빨개져야 하는 변이 |
|---|---|---|
| UIF2-C1 | `sendReport`에 `exists`·`not-found`를 답하는 가짜 `api`와 거절하는 가짜를 주면, 각각 `REPORT_EXISTS`·reread 참 / `REPORT_NOT_FOUND`·reread 거짓 / "알리지 못했습니다"로 시작하는 `alert: true`·reread 거짓이다(R1) | `apps/web/src/lint-report.test.tsx` 새 사례 "UIF2-C1". **`543811a5`에서 빨강**(함수 없음). 변이: `not-found`도 reread 참이면 빨강 |
| UIF2-C2 | 고른 것이 A·B·C이고 보낸 요청이 A·B이면 `withoutSent`는 C만 남긴다(R2) | 같은 파일 "UIF2-C2". **`543811a5`에서 빨강**(함수 없음). 변이: 늘 `[]`을 주면 빨강 |
| UIF2-C3 | 그려진 양식의 찾기 입력에 `maxlength="200"`이 있고 안내 문단에 "200자"가 있다(R3) | `lint-report.test.tsx` 「LintReport」 묶음 새 사례 "UIF2-C3"(`renderToStaticMarkup`). **`543811a5`에서 빨강** |
| UIF2-C4 | `createFeedbackCalls`의 `record`를 앞 답이 오기 전에 한 번 더 부르면(취소 `undo`도 포함) `api`는 한 번만 불리고 둘째 답은 `undefined`이며, 앞 답이 온 뒤의 부름은 보내진다(R4) | `apps/web/src/feedback.test.tsx` 새 사례 "UIF2-C4". **`543811a5`에서 빨강**(함수 없음). 변이: `busy`를 빼면 빨강 |
| UIF2-C5 | 문장 0개로 끝난 상태의 `progressText`는 "끝났습니다."이다(R5) | `apps/web/src/ask.test.tsx` 「progressText (CUF-C7)」 묶음 새 사례 "UIF2-C5". **`543811a5`에서 빨강**("끝났습니다. 답 0문장") |
| UIF2-C6 | `TZ=Asia/Seoul`인 동안 11월 1일~30일 양식의 `buildRequest`는 `from: "2026-10-31T15:00:00.000Z"`, `to: "2026-11-30T14:59:59.999Z"`다(R6) | `ask.test.tsx`의 CUF-C5 사례를 고침. 처음부터 초록. 변이: `localDay`를 `Date.UTC`로 만들면 어느 기계에서나 빨강 — 이슈가 이 가드 공백을 지적했으므로 한 번 확인 |
| UIF2-C7 | `pickBackupFolder`에 `{ ticket: null }`을 주는 `pick`이면 `choose`는 0회, 답은 `undefined`다(R7) | `apps/web/src/backup.test.tsx` 새 사례. 처음부터 초록. 변이 확인은 요구하지 않음 |

경계값·조합의 전수 시험은 하지 않는다. 보안·자료 보호 가드가 아니므로 변이 확인은 C6 하나만 한다(규칙 5). R3의 찾기 실패 문구는 시험하지 않는다.

## 잠정 결정

| 결정 | 고른 것 | 까닭 | 바꾸려면 |
|---|---|---|---|
| UIF2-D1 | 200자 안내는 입력의 `maxLength`와 안내 문단 한 문장으로 한다(글자 수 경고 문단은 두지 않음) | 같은 앱의 200자 입력(`App.tsx:461`, `ontology.tsx:204`)이 `maxLength`를 쓴다. 이름 찾기는 질문(CUF-R4)과 달리 잘려도 잃을 내용이 적다 | 질문 화면처럼 `searchLimitText(query)`를 두고 넘으면 안내를 보이며 찾기를 막는다 |
| UIF2-D2 | 잠금은 컴포넌트마다 하나이고 기록·취소가 함께 쓴다. 근거 화면의 Insight 기록(`evidence-view.tsx:596`)은 Insight가 바뀌어도 같은 잠금이라, 다른 Insight의 누름도 앞 답을 기다린다 | 한 번에 한 부름이면 두 번 누름과 늦은 404 안내가 함께 사라지고 코드가 가장 작다. 기다림은 한 요청 길이뿐이다 | `record`·`undo`에 `createBusy`를 따로 두거나, 대상 ID별 잠금으로 바꾼다 |
| UIF2-D3 | #358 F1은 시험을 두지 않고 받아들여 닫는다 | 남은 것은 `useState(createLatest)` 한 줄의 배선이고 규칙은 UIF-C1이 본다. 시험하려면 DOM 환경이나 훅 하나를 위한 새 이음새가 필요해 비용이 크다(X02F-D5) | 단위 시험에 jsdom과 렌더 도구를 들여와 `api`를 바꿔 다시 그리는 사례를 둔다 |
| UIF2-D4 | 0문장 끝 알림은 "끝났습니다."로 한다(빈 문자열이 아님) | 끝났다는 단계는 다른 문단이 말하지 않으므로 CUF-R5대로 남기고, 겹치던 문장 수만 뺀다 | `progressText`가 0문장이면 `""`를 준다 |

## 미검증 범위

- 이 문서의 코드 사실은 읽기로 확인했고 실행하지 않았다.
- 컴포넌트가 `sendReport`·`withoutSent`·`createFeedbackCalls`를 부르는 배선은 DOM 시험이 없어 기존 e2e(`lint.e2e.ts` CUF-C2, 피드백 흐름)로만 본다. 그 e2e 파일은 고치지 않는다.
- 실제 화면 낭독기에서 두 상태 문단이 읽히는 순서, Electron 묶음, Windows.

## 작업

PR 하나, 구현자 한 명. 전체 시험은 PR 직전에 한 번(`pnpm e2e` 포함 — 화면 파일이 바뀐다). 머지되면 #356·#358을 닫는다(#358의 `.sub-title` 줄은 다른 이슈로 옮기거나 미검증으로 남긴다는 댓글을 단다).

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀 | 전체 | #356·#358의 남은 지적을 코드와 대조해 동작 넷·시험 셋·문서 하나·받아들임 하나·결정 넷으로 정리 |
