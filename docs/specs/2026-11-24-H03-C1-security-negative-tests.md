# H03-C1 — 보안 부정 테스트 (공용 저장소에서 돌릴 수 있는 범위)

- 상태: 확정
- 이슈: #34 (H03-C1만. 총괄 #1, Phase #9)
- 날짜: 2026-11-24
- 관련: [ADR 0008](../adr/0008-security-baseline.md) "각 줄에는 거부되는 경우를 확인하는 테스트가 하나 이상 있어야 한다"

## 배경

ADR 0008은 보안 통제를 첫 코드부터 넣고, 통제가 실제로 막는지는 H03의 부정 테스트(거부되는 경우를 확인하는 시험)가 증명한다고 정했다. H03-C1은 일곱 가지 위협 축을 부정 테스트하라고 요구한다.

코드를 축별로 읽어 보니 통제와 부정 테스트가 이미 대부분 들어 있었다. 그래서 이 작업은 "새 통제를 만드는 일"이 아니라 ① 축마다 무엇이 막고 어느 시험이 그것을 지키는지 한 표로 고정하고 ② 시험이 비어 있는 자리 세 곳만 채우는 일이다. 통제가 없거나 뚫리는 자리(제품 코드를 고쳐야 하는 자리)는 읽기 조사에서 확인되지 않았다.

| 축 | 막는 장치 | 이미 있는 부정 테스트 | 판정 |
|---|---|---|---|
| ① 원문 prompt injection | 지시문은 코드 상수, 문서는 데이터 구획(`providers/src/broker.ts`, `adapters/openai-compatible.ts`, `adapters/cli-provider.ts`), 응답은 스키마 검증, 인용은 저장된 본문과 대조 | 추출: `knowledge-engine/src/extraction.test.ts`(악성 변형의 지시가 문서 구획에만), `extraction-v4.test.ts`, `providers/src/broker.inputs.test.ts` ③. 답변: 본문에 없는 인용 탈락(`backend/src/ask-gate.test.ts`) | **시험 보강** — 답변 경로에는 악성 문서를 넣은 시험이 없다 |
| ② HTML/Markdown XSS | 화면은 가져온 글을 글자로만 그린다(HTML을 넣는 코드 0건), CSP(`apps/desktop/src/app-protocol.ts`) | 화면별 렌더 시험(`apps/web/src/*.test.tsx` 7개), `apps/web/e2e/evidence.e2e.ts`, `apps/desktop/e2e/shell.security.e2e.ts`(CSP) | **시험 보강** — 알림·점검 화면은 렌더 시험이 없고, 누군가 HTML 삽입 코드를 새로 넣어도 막는 시험이 없다 |
| ③ path traversal | 화면 파일 제공은 웹 루트 안만(`app-protocol.ts`), 위치 승인은 일회용 티켓만, 폴더 밖 심볼릭 링크·바꿔치기 거부, 압축 안의 `../` 거부, 위치 보기는 폴더 안 경로만 | `apps/desktop/src/app-protocol.test.ts`, `backend/src/local-locations.api.test.ts`, `shell-main.local-locations.test.ts`, `local-files-connector.test.ts`(C4), `local-reveal.test.ts`, `packages/document-normalize/src/safety.test.ts` | 충족 — 추가 없음 |
| ④ 로컬 API CSRF·DNS rebinding | 127.0.0.1 바인딩, `Host` 정확 일치, `Origin` 허용 목록, 실행마다 새 토큰, 검사는 라우팅보다 먼저(`backend/src/server.ts`) | `backend/src/api.security.test.ts`(토큰·Host·Origin·중복 Host·절대형 URI·바인딩), `ontology-api.test.ts` | **시험 보강** — 라우트 표 밖에서 처리되는 스트림 경로(`/api/ask`)와 "CORS 허용 헤더를 내지 않는다"는 성질에 시험이 없다 |
| ⑤ Electron IPC 우회 | sandbox·contextIsolation, preload는 정해진 함수만, 보낸 화면·스키마 검사, 이동·새 창·webview·다운로드·권한 차단, 디버깅 스위치 거부 | `apps/desktop/e2e/shell.security.e2e.ts`, `preload.surface.e2e.ts`, `apps/desktop/src/bridge.test.ts`, `window.test.ts`, `preload.test.ts`, `debugging.test.ts` | 충족 — 추가 없음 |
| ⑥ 권한 교차추론 | 모든 읽기가 읽기 관문(`backend/src/read-gate.ts`)과 ScopePolicy를 지난다. 숨긴 것과 없는 것의 답이 같다 | `read-gate.test.ts`, `boot.read-gate.test.ts`, `ask-gate.test.ts`, `explore-gate.test.ts`, `wiki-gate.test.ts`, `notify-gate.test.ts`, `lint-gate.test.ts`, `thread-gate.test.ts`, `conflicts-api.test.ts`, `semantic-api.test.ts`, `feedback-api.test.ts`, `derivative-coverage.test.ts` | 충족 — 추가 없음 |
| ⑦ 로그 민감값 | 로그 한 줄은 코드 모양 값만 통과, 나머지는 `[redacted]`(`providers/src/log.ts`) | `providers/src/log.test.ts`, `backend/src/redaction.failure-paths.test.ts`, `connectors.credentials-canary.test.ts`, `apps/desktop/src/shell.channel.test.ts` | 충족 — 추가 없음 |

## 목표

- 일곱 축 각각에 "거부되는 경우"를 확인하는 저장소 안 시험이 하나 이상 있고, 그 대응이 이 문서의 표로 남는다.
- 시험이 비어 있던 세 자리(①·②·④)를 대표 사례 1~2개씩으로 채운다.

## 비목표

- H03-C2(측정), H03-C3(Windows 설치본의 FS01~FS14).
- 제품 코드 변경. 새 시험이 실제 결함을 드러내면 그때 이 문서에 요구사항을 추가한다(잠정 결정 참고).
- 이미 충족으로 판정한 네 축에 시험을 더하는 일, 경계값·조합을 빠짐없이 나열하는 일.
- 실제 provider, 배포처 수집기, 설치본에서의 확인.
- 백업·복원 코드, 승격 관문, `backend/src/local-lifecycle.api.test.ts`, `backend/src/analytical.e2e-import.test.ts` 수정(다른 세션이 작업 중).

## 요구사항

- **R1** 질문 답변 경로에서, 검색에 걸린 문서의 본문에 "이전 지시를 무시하라"는 문장이 있어도 provider에 보내는 지시문은 코드 상수 그대로이고 그 문장은 문서 구획에만 있다. provider가 그 문장을 따른 것처럼 답해도(본문에 없는 인용, 받은 적 없는 문서 번호) 그 문장은 화면으로 가지 않는다.
- **R2** 웹 화면 소스(`apps/web/src`, 시험 파일 제외)에는 문자열을 HTML로 해석해 넣는 코드(`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcDoc`)가 없다.
- **R3** 로컬 API의 스트림 경로 `/api/ask`도 토큰이 없거나, `Origin`이 허용 목록 밖이거나, `Host`가 자기 주소가 아니면 다른 경로와 같은 코드로 거부한다.
- **R4** 로컬 API는 어떤 응답에도 `access-control-allow-origin`을 싣지 않는다. 허용 목록 밖 `Origin`의 사전 요청(`OPTIONS`)은 거부한다.
- **R5** 나머지 네 축(③·⑤·⑥·⑦)은 위 표의 기존 시험을 증거로 삼고 시험을 더하지 않는다.

## 완료 기준

- **C1** (R1) `backend/src/ask-gate.test.ts`: 지시 문장이 든 문서가 검색에 걸렸을 때, provider가 받은 `instructions`가 답변 작업의 코드 상수와 같고 그 문장을 담지 않으며, 그 문장은 `untrustedDocuments`의 본문에만 있다. provider 대역이 본문에 없는 인용과 받지 않은 문서 번호로 문장을 돌려주면 그 문장은 `sentence` 이벤트에 없다.
- **C2** (R2) `apps/web/src/no-html-sink.test.ts`: `apps/web/src`의 시험 아닌 `.ts`·`.tsx`를 모두 읽었을 때 R2의 여섯 이름이 한 번도 나오지 않는다. 같은 검사에 그 이름이 든 예시 문자열을 주면 잡아낸다(검사 자체가 잡는다는 대조).
- **C3** (R3, R4) `backend/src/api.security.test.ts`: `/api/ask`에 대한 `POST`가 토큰 없음이면 401 `unauthorized`, 허용 밖 `Origin`이면 403 `forbidden-origin`, 다른 `Host`면 403 `forbidden-host`다. 허용 밖 `Origin`의 `OPTIONS`는 403이고, 그 응답과 정상 요청의 200 응답 모두에 `access-control-allow-origin` 헤더가 없다.
- **C4** (R5, 목표) PR 직전 전체 실행(`pnpm lint`, `pnpm typecheck`, `pnpm test`)이 통과하고, 배경 표가 가리키는 기존 시험 파일이 모두 그 실행에 들어 있다. PR 본문에 축별 시험 파일과 관찰 결과를 적는다.
- **C5** (R1, R3) 허용·차단을 가르는 두 장치는 변이로 한 번씩 확인한다: `server.ts`에서 `/api/ask` 분기를 검사 앞으로 옮기면 C3이 실패하고, 답변 경로의 인용 대조를 끄면 C1이 실패한다. 변이는 되돌리고(백업 사본으로 복원) 결과만 PR 본문에 적는다.

## 잠정 결정

| 결정 | 이유 | 바꾸려면 |
|---|---|---|
| 네 축은 기존 시험을 증거로 삼고 새 시험을 쓰지 않는다 | 같은 동작을 다시 확인하는 시험은 시험 간략화 규칙이 금한다 | 해당 축에 요구사항과 기준을 이 문서에 추가 |
| ①은 답변 경로만 보강한다. 위키 요약·성찰·Insight 해석 작업에는 악성 문서 시험을 더하지 않는다 | 네 작업 모두 같은 Broker와 같은 어댑터를 지나고, 답변이 사용자에게 가장 직접 닿는다 | 후속 이슈로 작업 종류별 대표 시험 추가 |
| ②는 화면별 렌더 시험이 아니라 소스 전체 검사 하나로 한다 | 알림·점검 화면은 서버를 부르는 통짜 컴포넌트라 렌더 시험을 쓰려면 제품 코드를 쪼개야 한다. 소스 검사는 모든 화면과 앞으로 생길 화면을 함께 지킨다 | 컴포넌트를 나누는 별도 작업 뒤 렌더 시험 추가 |
| `/api/changes`의 변경 번호 세 개는 숨긴 자료가 바뀌어도 올라간다. 누출로 보지 않고 고치지 않는다 | 번호는 화면 새로고침용이고 내용·건수·식별자를 담지 않으며, 로컬 사용자는 한 명이다 | 배포처 정책이 "활동 사실 자체"도 가려야 한다면 번호를 읽기 관문 기준으로 세는 요구사항 추가 |
| 새 시험이 실패해 실제 결함이 드러나면 이 문서에 요구사항을 추가한 뒤 같은 PR에서 고친다. 고칠 범위가 다른 세션의 파일과 겹치면 멈추고 보고한다 | 실패하는 시험이 먼저라는 순서를 지키면서 PR을 쪼개지 않기 위해 | 결함 수정을 별도 이슈·PR로 분리 |
| 이슈 #34의 선행 작업(#33, #28, #29, #30, #37)과 `blocked` 표시는 C1 범위에는 적용하지 않는다 | C1의 대상은 이미 main에 있는 코드다. 선행 작업의 현재 상태는 이 문서에서 확인하지 않았다 | 선행 작업이 새 표면(API·화면)을 더하면 이 표에 줄을 추가 |

## 미검증 범위

- **Windows·설치본**: Electron 쪽 시험(⑤)은 소스 실행과 개발 장비에서 돈다. Windows 설치본에서 sandbox·CSP·경로 처리(역슬래시, 드라이브 문자, UNC)가 같게 동작하는지는 H03-C3 몫이다.
- **실제 provider**: ①은 provider 대역으로 "지시문과 문서가 나뉘어 나간다"와 "따른 결과가 버려진다"를 확인한다. 실제 모델이 주입 문장에 어떻게 반응하는지, CLI provider의 도구 격리가 실제 CLI에서 지켜지는지는 확인하지 않는다.
- **브라우저 개발 모드**: Vite 개발 서버는 CSP를 내지 않는다. CSP 확인은 `app://` 경로에만 해당한다.
- **셸의 시작 실패 줄**: `apps/desktop/src/main.ts`가 표준 오류에 적는 네 줄은 오류 문구를 그대로 싣는다. 읽어 본 범위에서 그 문구는 고정 문장이나 경로이고 비밀 값·토큰의 출처는 찾지 못했지만, Electron 진입점이라 단위 시험으로 확인하지 못한다.
- 배포처 수집기·정책(`site`)에서의 교차추론.

## 변경 이력

| 날짜 | 변경 내용 | 사유 |
|---|---|---|
| 2026-11-24 | 초안 작성 | #34 H03-C1 |
