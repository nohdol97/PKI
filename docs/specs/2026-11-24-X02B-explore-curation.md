# 스펙: X02B — 탐색·지식 검토의 정리 기능과 넘긴 읽기

- 날짜: 2026-11-24 / 상태: 확정(잠정 결정 포함)
- 관련: 이슈 #268(X02 후속, "넘긴 기능" 일곱 줄), [X02 spec](2026-11-23-X02-explore-ux.md)("넘기는 것"), [S01 spec](2026-11-22-S01-semantic-registry.md)(이력 R6, 유형 정의 R23), [S02 spec](2026-11-22-S02-entity-resolution-temporal-graph.md)(합치기 R11·R12, 묶음 R13, 나누기 R15, 구별 R16, 유효 기간 R17, 범위 검사 R24), [I02 첨부 spec](2026-11-23-I02-attachment-metadata.md)(I02C-R6), [I04 spec](2026-11-21-I04-invalidation.md)(R13 읽기 문, 등록표)
- 번호: 요구사항 `X02B-R<n>`, 완료 기준 `X02B-C<n>`, 결정 `X02B-D<n>`, 작업 `X02B-T<n>`. **마이그레이션, 새 테이블, 새 의존(패키지), 새 ADR은 없다**(X02B-D1). `site-setup.md` 항목은 합쳐지는 때 main의 다음 번호를 쓴다(지금 S45).

| 말 | 뜻 |
|---|---|
| 항목, 이웃, 읽기 문, 가려진 것 | X02 spec의 뜻 그대로 |
| 구성원 | 다른 항목에 합쳐진 항목. 묶음은 대표 하나로 보인다(S02-R13) |
| 별칭 | 종류가 `alias.`로 시작하는 사실(`alias.synonym` 등, S01-R2). 따로 저장된 별칭 표는 없다 |
| 유형 정의 | 항목 종류·사실 종류·관계 종류와 그 규칙(ontology, S01-R23) |

## 배경

X02는 한 PR 범위를 지키려고 일곱 가지를 넘겼다. main을 확인한 결과는 다음과 같다.

- **백엔드에 이미 있고 화면만 없는 것.** 합치기·되돌리기·나누기·구별 표시(`entityMerge`, `entityUnmerge`, `entitySplit`, `entityDistinct`, `entityCandidates`), 유효 기간 고치기(`semanticValidity`), 조치 이력(`semanticHistory`), 유형 정의(`ontology`, `ontologyCheck`, `ontologyChange`, `ontologyDecide`, `ontologyUndo`, `ontologyHistory`). 모두 읽기 문 뒤에 있고, 가려진 대상은 없는 번호와 같은 `not-found`다.
- **읽기가 모자란 것.** ① `exploreItems`는 이름만 본다(SQLite `LIKE`, ASCII만 대소문자 무시). 별칭은 `facts`의 `alias.*` 줄로 이미 있다. ② `semantic`은 처음 100개 항목에서 자르고 상태로 거르지 못한다. ③ `sources`·`activity`는 최근 100줄만 답하고 이어 읽는 길이 없다. ④ `exploreSource`는 `sourceVersion`만 답한다. 첨부·위치를 계산하는 코드는 `evidenceSource`에 이미 있다(`storage/src/evidence-view.ts`의 `locatorAt`·`attachmentAt`). ⑤ `entityCandidates`는 항목 번호만 답하고 `exploreItem`의 중심 항목에는 구성원(되돌리기에 필요한 `mergeId`)이 없다.
- **그리기.** 웹 앱의 의존은 `react`·`react-dom`뿐이다. 그리기 라이브러리는 설치돼 있지 않다.

## 목표

1. 사용자가 탐색 화면에서 항목을 합치고, 되돌리고, 나누고, "다른 것"으로 표시하며, 사실·관계의 유효 기간을 고치고 조치 이력을 본다.
2. 유형 정의를 보고 더하고 고치고 물리는 화면이 있다.
3. 이웃을 그림으로도 본다. 표는 그대로 남는다.
4. 별칭으로 항목을 찾고, 100개 밖의 후보를 서버가 상태로 걸러 주며, 원본·활동 목록을 이어 읽고, 질문의 인용 원본에 첨부·위치가 보인다.
5. 새로 더하거나 넓힌 읽기는 모두 읽기 문을 지나며, 가려진 것은 응답·개수·순서·오류 모양 어디에도 흔적이 없다.

## 비목표

- **새 백엔드 조치.** 합치기·나누기·유효 기간·유형 정의의 판정 규칙은 손대지 않는다. 화면이 기존 경로를 부른다.
- **그래프 끌기·확대·자동 배치 라이브러리, 전체 그래프.** 한 항목의 이웃(S02-R22 한계 그대로)만 고정된 자리에 그린다.
- **구별 표시 목록.** 표시된 쌍을 읽는 경로가 없다. 새 읽기를 만들지 않는다(넘기는 것).
- **구성원의 이름·별칭으로 대표 찾기, ASCII 밖 글자의 대소문자 무시, 전문 검색.**
- **원본 검색 결과(`searchSources`)와 작업(job) 목록의 이어 읽기.**
- **이슈 #268의 "검토의 남은 지적"(백엔드·화면).** 이 spec은 "넘긴 기능"만 다룬다.
- **기존 `semantic`·`sources`·`activity` 경로의 요청·응답 바꾸기와 삭제.** 다른 호출자와 시험이 쓴다.
- **Electron 전용 E2E, Windows 확인, 성능 측정.**

## 요구사항

### 읽기 (백엔드)

새 경로는 `routes` 표의 행이고 본문이 있는 `POST`다. 저장하는 것은 없다.

- **X02B-R1 별칭으로 찾기(`exploreItems` 넓힘).** `query`가 있으면 이름에 그 글이 있는 항목과, 그 항목 자신의 별칭 사실(상태가 기각·대체됨이 아닌 것) 값에 그 글이 있는 항목을 답한다. 응답 줄에 `alias`(문자열 또는 `null`)를 더한다. 이름으로 맞았으면 `null`, 별칭으로만 맞았으면 맞은 별칭 가운데 보이는 첫 값이다. 쪽 크기·순서·`next`는 X02-R1 그대로다.
- **X02B-R2 구성원과 이름(`exploreItem` 넓힘, `POST /api/explore/names` 신설).** ① `exploreItem`의 중심 항목에 `members`(번호·종류·이름·`mergeId`, 번호 오름차순)를 더한다. ② `exploreNames`는 요청 `{ ids }`(1~200개)에 응답 `{ items: [{ id, type, name }] }`를 답한다. 없는 번호와 가려진 번호는 똑같이 빠진다(오류가 아니다).
- **X02B-R3 상태로 거른 지식 목록 `POST /api/semantic/page`.** 요청 `{ status?, after? }`, 응답 `{ items, next }`. `items`의 줄은 `semantic` 목록과 같은 모양(구성원 포함)이고 대표만, 번호 오름차순, 한 쪽 50개다. `status`가 있으면 그 상태인 **보이는** 줄(항목 자신, 구성원, 그들의 사실·관계)이 하나라도 있는 항목만 남긴다. `next`는 X02-R1과 같은 뜻이다. 전체 개수는 답하지 않는다.
- **X02B-R4 목록 이어 읽기 `POST /api/sources/page`, `POST /api/activity/page`.** 요청 `{ before? }`, 응답은 기존 목록과 같은 줄에 `next`를 더한 것(`{ sources, next }`, `{ calls, next }`). 최신순, 한 쪽 50개. `before`는 앞 응답의 `next`이고, `next`는 더 있을 때만 숫자다.
- **X02B-R5 인용 원본의 첨부·위치(`exploreSource` 넓힘).** 요청에 `start`(본문의 code point 위치, 선택)를 더하고 응답에 `locator`·`attachment`를 더한다. `start`가 있으면 `evidenceSource`와 같은 계산(그 위치를 담은 블록의 위치 정보와 첨부)을 쓰고, 없으면 둘 다 `null`이다.
- **X02B-R6 읽기 문.** R1~R5는 `display` 용도로 기존 검사(`semanticShown`, `sourceShown`, `filled`)를 지난다. ① 가려진 항목·구성원·사실·관계·원본은 어느 응답에도 없다. ② **별칭**: 가려진 별칭 사실로만 맞는 항목은 결과에 없고(그 별칭이 없는 항목과 같다), `alias` 칸에 가려진 값이 실리지 않는다. ③ **상태 걸러 내기**: 그 상태인 줄이 모두 가려졌으면 그 항목은 그 상태의 목록에 없다. ④ R1·R3·R4의 쪽은 가려진 것 때문에 짧아지지 않고, 보이는 것의 순서와 `next`는 가려진 것이 없을 때와 같다. ⑤ 가려진 구성원의 번호와 `mergeId`는 `members`에 없다. ⑥ R5는 version이 가려졌으면 `start`와 상관없이 없는 번호와 같은 `not-found`(404)다. ⑦ 응답과 로그에 가려진 것의 이름·값·번호가 없다. 활동 목록의 줄에는 원본 글이 없으므로(기존 `activity`와 같은 줄) 따로 거를 것이 없다.

### 화면

- **X02B-R7 항목 정리(탐색 화면의 중심 항목).** ① **합치기**: 이름으로 다른 항목을 찾아 고르면 그 항목이 중심 항목의 구성원이 된다(`entityMerge`, `member`=고른 항목, `into`=중심). ② **되돌리기**: 구성원 줄마다 "합치기 되돌리기"(`entityUnmerge`, 그 줄의 `mergeId`). "다른 것으로 남기기"는 기본으로 켜져 있다(`keepDistinct`). ③ **나누기**: 사실·관계 줄을 골라 새 이름을 적으면 `entitySplit`을 부르고, 만들어진 항목으로 가는 버튼을 보인다. ④ **다른 것 표시**: 고른 항목과 중심 항목을 `entityDistinct`(`on: true`)로 표시하고, 방금 한 표시는 그 자리에서 풀 수 있다(`on: false`). ⑤ 조치 뒤 중심 항목을 다시 읽고, 거절이면 이유 코드를 우리말로 보인다(합치기·나누기의 코드 목록 전부에 글이 있다).
- **X02B-R8 줄 상세(탐색 화면의 사실·관계 줄).** ① **유효 기간 고치기**: 시작·끝 날짜(비우면 없음)를 적어 `semanticValidity`를 부른다. 고친 뒤 다시 읽은 기간을 보이고, 응답의 `previous`로 "이전 기간으로 되돌리기"를 한 번 할 수 있다. 날짜가 없거나 시작이 끝보다 늦지 않으면 거절(400)을 우리말로 보인다. ② **조치 이력**: `semanticHistory`의 줄을 시간순으로(언제·누가·무슨 조치·상태 변화) 보인다. 아는 조치 코드는 우리말로, 모르는 코드는 코드 그대로 보인다. 항목 자신의 이력도 중심 항목에서 본다.
- **X02B-R9 이웃 그림.** 탐색 화면의 이웃 표 위에 같은 응답(`items`·`edges`)을 SVG로 그린다. 중심은 가운데, 이웃은 걸음 수별 동심원 위에 번호순으로 놓고, 선은 관계 종류를 글로 단다. 관계 종류 걸러 내기는 그림과 표에 같이 듣는다. 그리는 이웃은 60개까지이고 넘으면 "표에서 전부 볼 수 있다"고 알린다. 그림은 `role="img"`와 요약 이름(항목·관계 개수)을 갖고, 이웃 표가 그대로 남아 키보드·화면 낭독기의 길이 된다. 이름은 글로만 그린다.
- **X02B-R10 지식 검토 화면.** ① 목록은 R3으로 읽는다. 상태를 고르면 서버가 걸러 주고 "더 보기"가 `next`로 이어 읽는다. "목록이 잘렸습니다" 안내는 없앤다. ② **합치기 후보**: `entityCandidates`의 쌍을 R2의 이름과 함께 보이고, 줄마다 "‹A›에 합치기"·"‹B›에 합치기"·"다른 것"을 한다. 조치 뒤 다시 읽으면 그 쌍이 사라진다.
- **X02B-R11 유형 정의 화면.** 내비게이션에 "유형 정의"를 더한다. ① 요소를 종류별로(항목 종류·사실 종류·관계 종류) 이름·상태·판·출처·규칙 요약과 함께 보인다. ② 줄마다 승인·기각·이의·되돌리기(`ontologyDecide`, `ontologyUndo`), 이력(`ontologyHistory`), 물리기(`retire`). ③ 더하기와 규칙 고치기는 같은 입력 틀을 쓴다. "미리 확인"(`ontologyCheck`)이 겹침 수·규칙 오류·영향(남은 줄 수·어긋남 수)을 보이고, 적용은 `ontologyChange`다. 거절이면 이유와 그 수를 우리말로 보인다. 규칙의 `dataChecks`는 화면에서 고치지 않고 있던 값을 그대로 보낸다.
- **X02B-R12 원본·활동의 더 보기, 인용의 첨부·위치.** ① "원본" 목록과 "활동"의 Provider 호출 목록은 R4로 읽고 "더 보기"로 뒤에 붙인다. ② "질문"의 "원본 보기"는 인용의 시작 위치를 `start`로 보내고, 응답의 첨부·위치를 기존 `SourceView`가 그린다.
- **X02B-R13 상태와 접근성.** X02-R8을 새 화면·새 조치에 그대로 쓴다. 불러오는 중(`role="status"`), 빈 목록 안내, 실패(`role="alert"`), 이름 있는 버튼·입력, 가져온 글은 `<bdi>` 안의 글로만. 같은 이름의 버튼이 되풀이되지 않도록 새 버튼의 접근성 이름에는 대상 이름을 넣는다.

## 완료 기준 (테스트 가능한 형태)

합성 자료만 쓴다. 기준마다 대표 사례 1~2개다. 웹 단위 시험에는 DOM이 없으므로 "누르면"은 화면이 그 누름에 부르는 함수와 정적 마크업으로 확인하고, 실제 누름은 E2E가 본다.

- **X02B-C1** (R1~R5, 계약·실제 API) 합성 자료를 넣고 띄운 백엔드에서 ① 별칭의 일부로 찾으면 그 항목이 `alias`에 그 별칭을 싣고 오고, 이름으로 찾으면 `alias`가 `null`이다. ② 항목 120개 가운데 후보 사실이 110번째 뒤에만 있을 때 `semanticPage`의 `status: "candidate"` 첫 쪽에 그 항목이 있고, 상태 없이 읽으면 첫 쪽 50개와 `next`, 이어 읽은 쪽이 겹치지 않는다. ③ 합친 뒤 `exploreItem`의 `members`에 구성원과 `mergeId`가 있고, `exploreNames`가 두 번호의 이름을 답하며 없는 번호는 빠진다. ④ 원본이 50개를 넘으면 `sourcesPage` 첫 쪽이 50개와 `next`, 둘째 쪽이 겹침 없는 나머지와 `next: null`이다. `activityPage`도 같다. ⑤ 첨부가 있는 블록 안의 `start`로 읽은 `exploreSource`가 그 첨부와 위치를 싣고, `start` 없이 읽으면 둘 다 `null`이다. → `backend/src/curation-api.test.ts`
- **X02B-C2** (R6, 부정 시험) 카나리 값을 가진 가려진 것(정책이 `display`를 거부하는 범위의 원본에서 나온 것 하나, 가져온 뒤 원본을 삭제한 것 하나)과 보이는 것을 섞어 두면 ① 보이는 항목에 달린 가려진 별칭으로 찾으면 결과가 비고, 응답 전체와 잡아 둔 로그에 카나리가 없다. ② 후보 줄이 모두 가려진 항목은 `status: "candidate"` 목록에 없고, 가려진 항목이 사이사이 끼어도 쪽이 50개이며 순서·`next`가 가려진 것이 없는 자료와 같다. ③ 가려진 구성원은 `members`에 없고, `exploreNames`에 가려진 번호를 넣으면 없는 번호와 같은 응답이다. ④ 가려진 원본이 끼어도 `sourcesPage`의 쪽 크기·순서·`next`가 같다. ⑤ 가려진 version의 `exploreSource`는 `start`가 있어도 404다. **변이**: 별칭 사실의 검사를 빼면, 상태 줄의 검사를 빼면 각각 빨개진다. → `backend/src/curation-gate.test.ts`
- **X02B-C3** (R7, 단위) 가짜 API로 ① 다른 항목을 골라 합치면 `entityMerge`가 `{ member: 고른 번호, into: 중심 번호 }`로 불리고 다시 읽은 구성원 줄이 보인다. 거절 `type-mismatch`면 이유가 우리말로 보인다. ② 구성원의 "합치기 되돌리기"가 그 `mergeId`로 `entityUnmerge`를 부른다. ③ 줄 둘을 골라 나누면 `entitySplit`이 그 줄들과 이름으로 불리고 만들어진 항목으로 가는 버튼이 있다. ④ "다른 것 표시"가 `entityDistinct`를 `on: true`로 부른다. → `apps/web/src/entity-curation.test.tsx`
- **X02B-C4** (R8·R9, 단위) ① 유효 기간을 고치면 `semanticValidity`가 적은 날짜로 불리고, "이전 기간으로 되돌리기"가 응답의 `previous`로 다시 부른다. 400이면 안내가 `role="alert"`로 보인다. ② 이력 줄이 시간순으로, 아는 조치 코드는 우리말로 보인다. → `apps/web/src/row-detail.test.tsx` ③ 이웃 셋(걸음 1 둘, 걸음 2 하나)을 주면 SVG에 중심과 세 이웃의 이름, 선 셋의 관계 종류가 있고, 관계 종류 하나를 끄면 그 선이 없으며, 이웃이 60개를 넘으면 안내가 보인다. `role="img"`와 요약 이름이 있다. → `apps/web/src/neighbour-graph.test.tsx`
- **X02B-C5** (R10, 단위) 가짜 API로 ① 상태를 "확정"으로 바꾸면 `semanticPage`가 `status: "verified"`로 불리고, "더 보기"가 `after`로 다음 쪽을 불러 뒤에 붙인다. ② 합치기 후보 쌍이 두 이름으로 보이고 "다른 것"을 누르면 `entityDistinct`가 불리며 다시 읽은 뒤 그 쌍이 없다. → `apps/web/src/semantic-review.test.tsx`
- **X02B-C6** (R11, 단위) 가짜 API로 ① 요소가 종류별로 보이고 후보 요소를 승인하면 `ontologyDecide`가 불린다. ② 사실 종류를 더할 때 "미리 확인"이 `ontologyCheck`를 부르고 영향 수를 보이며, 적용이 `ontologyChange`를 `op: "add"`로 부른다. 거절 `duplicate`면 이유가 우리말로 보인다. → `apps/web/src/ontology.test.tsx`
- **X02B-C7** (R12, 단위) ① "더 보기"가 `before`로 다음 쪽을 불러 뒤에 붙이고 `next`가 `null`이면 버튼이 없다. → `apps/web/src/paged-list.test.tsx` ② "원본 보기"가 `exploreSource`를 그 version 번호와 인용 시작 위치로 부르고, 응답의 첨부 이름과 위치가 마크업에 있다. → `apps/web/src/ask.test.tsx`
- **X02B-C8** (R7~R9, 브라우저 E2E) seed로 띄운 화면에서 사용자가 "탐색"에서 항목을 찾아 이웃 그림을 보고, 같은 종류의 다른 항목을 합쳐 구성원 줄을 보고, 되돌려 구성원이 사라진 것을 보고, 사실 한 줄의 이력을 연다. → `apps/web/e2e/explore-curation.e2e.ts`(브라우저만)
- **X02B-C9** (R10·R11, 브라우저 E2E, 같은 파일의 둘째 시험) "유형 정의"에서 항목 종류 하나를 더해 목록에서 보고, "지식 검토"에서 상태를 바꿔 걸러진 목록을 본다.

## 잠정 결정

| 번호 | 결정 | 이유 | 바꾸려면 |
|---|---|---|---|
| X02B-D1 | 저장하지 않는다. 마이그레이션·새 테이블·새 패키지 없음 | 별칭은 `facts`에, 첨부는 version의 `meta`에 이미 있다. 마이그레이션 번호를 다른 세션과 다투지 않는다 | 별칭 색인이 필요해지면 따로 spec |
| X02B-D2 | 기존 `semantic`·`sources`·`activity`는 그대로 두고 쪽 읽기를 새 경로 넷(`exploreNames` 포함)으로 더한다. `exploreItems`·`exploreItem`·`exploreSource`는 칸만 더한다 | 함께 쓰는 경로의 모양을 바꾸지 않는다(X02-D7과 같은 이유) | 화면이 모두 옮겨 간 뒤 옛 경로를 지우는 정리 작업 |
| X02B-D3 | 별칭은 항목 자신의 별칭 사실만 본다. 구성원의 이름·별칭, ASCII 밖 대소문자는 넘긴다 | 대표 번호순 쪽 나눔을 그대로 쓴다. 한글에는 대소문자가 없다 | 저장 읽기에 구성원 조인과 정규화 열(마이그레이션)을 더한다 |
| X02B-D4 | 별칭으로 맞은 줄에 그 별칭을 실어 보인다(`alias`) | 이름에 없는 글로 찾았을 때 왜 나왔는지 알 수 있다 | 칸을 뺀다 |
| X02B-D5 | 그림은 손으로 놓는 SVG(동심원), 60개까지. 끌기·확대 없음. 누르면 중심을 바꾸는 것은 마우스 편의이고 키보드 길은 표다 | 설치된 그리기 라이브러리가 없고 새 의존을 들이지 않는다 | 같은 응답 위에 배치 라이브러리 컴포넌트로 바꾼다 |
| X02B-D6 | 합치기·나누기·구별·유효 기간·이력은 탐색 화면에, 합치기 후보는 지식 검토에 둔다 | 유효 기간과 구성원은 탐색 읽기에만 있다. 지식 검토의 항목 이름은 이미 탐색으로 간다 | 줄 상세 컴포넌트를 지식 검토에도 단다 |
| X02B-D7 | 합치기는 "고른 항목이 중심 항목에 합쳐진다" 한 방향. 후보 목록은 방향마다 버튼 하나 | 보고 있던 항목이 대표로 남아 화면이 그대로 이어진다 | 방향 고르기 입력 |
| X02B-D8 | 구별 표시는 방금 한 것만 그 자리에서 푼다. 표시 목록은 없다 | 표시를 읽는 경로가 없고 새 읽기를 만들지 않는다 | 구별 표시 읽기 경로(읽기 문 포함)를 더한다 |
| X02B-D9 | 유효 기간 되돌리기는 응답의 `previous`를 다시 보내는 것(방금 한 것 한 번) | S02-R17이 "고치기는 되돌리기 대상이 아니다"로 두고 `previous`를 준다 | — |
| X02B-D10 | 유형 정의는 내비게이션의 새 화면. 규칙의 `dataChecks`는 고치지 않는다 | 지식 검토 파일을 여러 작업이 함께 고치지 않는다. 데이터 점검은 S03의 화면 몫이다 | `App.tsx`의 `SCREENS`, 입력 틀에 칸 추가 |
| X02B-D11 | 쪽 크기 50, 커서는 번호. 원본·활동은 최신순 `before` | X02-D5와 같다. 읽는 사이 새 version이 오면 한 줄이 겹치거나 빠질 수 있다(받아들인다) | 상수 |
| X02B-D12 | E2E는 브라우저만, 한 파일에 흐름 둘 | 쉘이 더하는 단언이 없다(간략화 규칙 3) | `playwright.config.ts` |

## 검증하지 않는 범위

- 별칭 찾기의 응답 시간(색인 없이 `facts`를 훑는다), 항목이 많을 때 상태 걸러 내기의 시간.
- 그림의 겹침·가독성(이웃이 많을 때), 화면 낭독기 실제 사용, 색 대비.
- Electron·Windows 설치본에서의 새 화면.
- 이력 줄의 `basisSourceId`는 기존 경로가 주는 값 그대로 보인다. 그 번호가 가려진 원본을 가리킬 수 있는지는 이 spec에서 확인하지 않았다(기존 `semanticHistory`의 동작).

## 넘기는 것

- **후속 이슈**: 구별 표시 목록과 풀기, 구성원 이름·별칭으로 찾기, ASCII 밖 대소문자 무시, 원본 검색 결과와 작업 목록의 이어 읽기, 옛 `semantic`·`sources`·`activity` 경로 정리, 유형 규칙의 `dataChecks` 고치기, 이슈 #268의 "검토의 남은 지적" 전부.
- **H02(#33)**: Electron·Windows에서 새 화면. **H03(#34)**: 새 읽기의 보안 부정 시험을 최종 시나리오에 포함, 규모·접근성 실측.
- **배포처**: `docs/site-setup.md` 새 항목 — 배포처 범위 정책을 건 채 별칭 찾기·상태 걸러 내기·합치기 후보·원본 더 보기에 허용되지 않은 범위의 것이 나오지 않는지 확인.

## 작업 분해

PR 하나. 시험을 먼저 쓴다. T1 뒤에 T2와 T4는 서로 다른 worktree에서 나란히 할 수 있다(고치는 파일이 겹치지 않는다). T3은 T2가 만드는 글 파일(`entity-text.ts`)과 합치기 함수를 쓰므로 T2 뒤에 하고, T4와는 나란히 할 수 있다. `server.ts`·계약 `index.ts`·`storage/src/index.ts`·`read-gate.ts`는 T1만, `App.tsx`·`ask.tsx`·`evidence-view.tsx`는 T4만, `explore.tsx`는 T2만, `semantic-review.tsx`는 T3만 고친다. 다른 세션이 잡고 있는 `backend/src/local-lifecycle.api.test.ts`·`backend/src/analytical.e2e-import.test.ts`와 기존 보안 부정 시험 파일(`explore-gate.test.ts`, `api.security.test.ts`)은 고치지 않고 새 시험 파일을 쓴다.

| 작업 | 산출물(하나) | 기준 | 선행 | 고치는 파일 | 확인 명령 |
|---|---|---|---|---|---|
| X02B-T1 | 읽기 R1~R6(스키마·저장 읽기·읽기 문·경로 등록) | C1, C2 | 없음 | `packages/contracts/src/explore.ts`·`index.ts`, `storage/src/explore-reads.ts`·`listing.ts`·`semantic-view.ts`·`index.ts`, `backend/src/explore-read.ts`·`read-gate.ts`·`server.ts`, 새 `backend/src/curation-api.test.ts`·`curation-gate.test.ts` | `pnpm vitest run backend/src/curation-api.test.ts backend/src/curation-gate.test.ts backend/src/explore-api.test.ts backend/src/explore-gate.test.ts` |
| X02B-T2 | 탐색 화면의 항목 정리·줄 상세·이웃 그림(R7~R9, R13) | C3, C4 | T1 | `apps/web/src/explore.tsx`·`explore-text.ts`·`explore.test.tsx`, 새 `entity-curation.tsx`·`entity-text.ts`·`row-detail.tsx`·`neighbour-graph.tsx`와 그 시험 | `pnpm vitest run apps/web/src/entity-curation.test.tsx apps/web/src/row-detail.test.tsx apps/web/src/neighbour-graph.test.tsx apps/web/src/explore.test.tsx` |
| X02B-T3 | 지식 검토의 서버 걸러 내기·더 보기·합치기 후보(R10) | C5 | T1, T2 | `apps/web/src/semantic-review.tsx`·`semantic-text.ts`·`semantic-review.test.tsx` | `pnpm vitest run apps/web/src/semantic-review.test.tsx` |
| X02B-T4 | 유형 정의 화면, 원본·활동 더 보기, 인용의 첨부·위치(R11·R12) | C6, C7 | T1 | `apps/web/src/App.tsx`·`ask.tsx`·`ask.test.tsx`·`evidence-view.tsx`, 새 `ontology.tsx`·`ontology-text.ts`·`paged-list.tsx`와 그 시험 | `pnpm vitest run apps/web/src/ontology.test.tsx apps/web/src/paged-list.test.tsx apps/web/src/ask.test.tsx apps/web/src/evidence-view.test.tsx` |
| X02B-T5 | 브라우저 E2E와 문서(I04 등록표 한 줄, `docs/README.md`, README, `site-setup.md` 항목) | C8, C9 | T2, T3, T4 | 새 `apps/web/e2e/explore-curation.e2e.ts`(같은 종류 항목 둘이 기존 seed에 없으면 새 seed `.e2e.ts` 파일. 기존 seed는 고치지 않는다), 문서 | `pnpm exec playwright test apps/web/e2e/explore-curation.e2e.ts --project=browser`, PR 직전 전체(`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`) 한 번 |

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 초안 | 전체 | 이슈 #268 "넘긴 기능" 착수 |
