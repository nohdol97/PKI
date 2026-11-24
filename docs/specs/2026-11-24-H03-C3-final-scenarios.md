# H03-C3 — 최종 시나리오 증거 표와 검사기 (공용 저장소에서 할 수 있는 범위)

- 상태: 확정
- 이슈: #34 (H03-C3 가운데 Windows 설치본 없이 할 수 있는 부분만. 총괄 #1, Phase #9)
- 날짜: 2026-11-24
- 관련: [이슈 #1 "최종 시나리오 추적"](https://github.com/nohdol97/PKI/issues/1), [원 설계 20절](../design/original-design.md), [H03-C1 spec](2026-11-24-H03-C1-security-negative-tests.md), [H03-C2 spec](2026-11-24-H03-C2-measure-runner.md), [verification 키트](../../verification/README.md), [site-setup](../site-setup.md)

## 용어

| 말 | 뜻 |
|---|---|
| 최종 시나리오(FS) | 원 설계 20절 "최종 완료 기준"의 14개 문장. 이슈 #1이 `FS01`~`FS14`로 번호를 붙였다 |
| 증거 표 | 시나리오마다 "무엇이 그것을 확인했는가"를 적은 파일. 기계가 읽는 JSON이 원본이고, 사람이 읽는 문서는 거기서 만든다 |
| 대역(mock) | 실제 Provider 대신 정해진 답을 돌려주는 시험용 Provider |
| 출시 차단 항목(release blocker) | 풀리기 전에는 그 시나리오를 "확인됨"이라고 부를 수 없는 이유 한 줄 |

## 배경

H03-C3은 "FS01~FS14를 Windows 설치본에서 모두 증거 링크로 매핑하고 실제 provider와 mock 결과를 구분한다. 기준 미달·미검증은 release blocker로 남긴다"이다. 이슈 #1은 "개별 완료가 통합 완료를 대신하지 않는다"고 적었다.

지금 저장소에는 Windows 설치 파일이 없고(#33, #37), 실제 Provider로 돌린 기록도 없다. 있는 것은 개발 장비에서 대역으로 도는 단위·계약·E2E 시험과 개발 장비 측정 결과 둘(`eval/results/`)이다. 배포처가 돌릴 절차서(`verification/`)는 "작성만 됨" 상태다.

그래서 공용 저장소에서 먼저 할 수 있는 일은 **표와 그 표가 거짓말을 못 하게 하는 검사기**다. 표는 14개 시나리오 각각에 지금 있는 증거를 잇고, 그 증거가 대역·개발 장비의 것임을 적고, 설치본·실제 Provider로 확인하지 못한 것을 출시 차단 항목으로 남긴다. 배포처가 나중에 설치본 결과를 이슈에 올리면 표에 그 링크를 더해 차단 항목을 하나씩 푼다.

14개 시나리오의 이름은 이슈 #1의 표를 글자 그대로 쓴다(새로 짓지 않는다).

| ID | 이름 (이슈 #1) | 책임 작업 |
|---|---|---|
| FS01 | 설치 파일 설치 | R04, H02 |
| FS02 | 기존 CLI 탐색 | R02, V01 |
| FS03 | 메일/메신저/Wiki형 데이터 import | I01, I02, V02 |
| FS04 | 의미 지식 추출 | V02, S01 |
| FS05 | 출처 간 관계 | V02, S02 |
| FS06 | 개인 Semantic 자동 구성 | S01~S03 |
| FS07 | Graph/Wiki 증분 갱신 | S02, K01 |
| FS08 | Reflection 새 관계 | K02 |
| FS09 | 다출처 Insight | P01 |
| FS10 | 근거 있는 능동 전달 | P02 |
| FS11 | 피드백 개선 | P03 |
| FS12 | 근거 기반 자연어 답변 | X01 |
| FS13 | 원본 삭제 파생물 갱신 | I04, H01 |
| FS14 | 재시작 작업 재개 | I03, H02 |

## 목표

- 14개 시나리오 각각이 저장소 안의 증거(시험 파일과 시험 제목, 측정 결과 파일)에 이어져 있고, 증거마다 대역·실제 Provider와 개발 장비·설치본이 구분돼 있다.
- 설치본·실제 Provider·배포처에서만 확인할 수 있는 것과 기준에 못 미친 것이 출시 차단 항목으로 남고, 명령 하나로 그 목록이 나온다.
- 표가 낡거나(가리키는 시험이 사라짐) 확인하지 않은 것을 확인했다고 적으면 `pnpm test`가 실패한다.

## 비목표

- Windows 설치본 실행, 실제 Provider 호출, 배포처 확인. 이 작업으로 "확인됨"이 되는 시나리오는 없다.
- 시나리오를 위한 새 제품 시험·E2E 작성, 제품 코드 변경. 증거가 비어 있는 자리는 차단 항목으로 적기만 한다.
- 표가 가리키는 시험을 검사기가 실행하는 일. 시험은 `pnpm test`·`pnpm e2e`가 돌리고, 검사기는 파일과 제목이 있는지만 본다.
- 통과선 판정(H03-C2의 D2와 같다), 이슈 #34의 H03-C3 체크박스 닫기.
- H03-C2 측정 실행기 파일(`backend/src/system-measure*`) 수정(다른 세션이 작업 중, #296). `eval/results/`의 결과 파일은 읽기만 한다.
- `verification/` 키트와 `docs/site-setup.md`에 항목을 더하는 일.

## 요구사항

- **H03C3-R1 (표)** 원본은 `eval/final-scenarios.json` 하나다. `schemaVersion`(1)과 시나리오 14개를 담는다. 시나리오마다 `id`, `title`(이슈 #1의 이름 그대로), `owners`(책임 작업), `status`, `evidence` 목록, `blockers` 목록이 있다.
- **H03C3-R2 (증거)** 증거 한 줄은 `kind`, 가리키는 곳, `provider`, `environment`를 담는다.

  | `kind` | 가리키는 곳 | 뜻 |
  |---|---|---|
  | `unit` | `path`(`*.test.ts`·`*.test.tsx`) + `title` | `pnpm test`가 도는 단위·계약 시험 하나 |
  | `e2e` | `path`(`*.e2e.ts`) + `title` | `pnpm e2e`가 도는 E2E 하나 |
  | `measure` | `path`(`eval/results/*.json`) | 측정 결과 파일 |
  | `site-result` | `url`(이 저장소 이슈의 댓글 주소) | 배포처가 설치본에서 돌려 이슈에 올린 결과 |

  `provider`는 `mock`·`real`·`none`(Provider를 부르지 않는 걸음), `environment`는 `dev`·`windows-installer`다. 저장소 안의 세 종류(`unit`·`e2e`·`measure`)는 `environment: dev`이고 `provider`가 `mock` 또는 `none`이어야 한다. `real`과 `windows-installer`는 `site-result`에만 쓸 수 있다.
- **H03C3-R3 (상태와 차단 항목)** `status`는 셋 중 하나다.

  | `status` | 조건 | 출시 차단 |
  |---|---|---|
  | `verified` | `environment: windows-installer`인 `site-result`가 하나 이상 있고, `needsProvider`가 참이면 그 가운데 `provider: real`이 하나 이상 있고, `blockers`가 비어 있다 | 아니다 |
  | `mock-only` | 저장소 안 증거가 하나 이상 있지만 `verified`의 조건을 채우지 못한다 | 차단 |
  | `unverified` | 증거가 없다 | 차단 |

  `verified`가 아닌 시나리오는 `blockers`가 하나 이상 있어야 한다. 차단 항목 한 줄은 `kind`(`windows-installer`·`real-provider`·`site`·`threshold`), 한국어 `note`, 선택으로 풀 절차가 적힌 문서 `procedure`(저장소 안 경로)를 담는다. `threshold`는 기록된 측정값이 EVALUATION 4.4절 통과선에 못 미친 경우다.
- **H03C3-R4 (검사)** 검사기는 표를 읽어 아래를 모두 확인하고, 어긋난 것마다 시나리오 ID와 이유를 한 줄로 낸다. 네트워크를 쓰지 않고 시험을 실행하지 않는다.
  1. `FS01`~`FS14`가 정확히 한 번씩 있고 `title`이 이슈 #1의 이름과 같다(이름 14개는 검사기 안의 고정 목록이다).
  2. 값이 R1~R3의 어휘 안에 있다.
  3. `path`와 `procedure`가 가리키는 파일이 있다. `unit`·`e2e`는 파일 이름이 종류에 맞고 `title`이 그 파일 글자 안에 그대로 있다.
  4. R2의 "누가 `real`·`windows-installer`를 쓸 수 있는가"와 R3의 상태 조건이 지켜진다. `site-result`의 `url`은 `https://github.com/nohdol97/PKI/issues/<번호>#issuecomment-<번호>` 모양이다.
- **H03C3-R5 (실행)** `pnpm check:scenarios`가 검사기를 돈다. 표가 어긋나면 어긋난 줄을 내고 종료 값 1, 표가 맞으면 상태별 시나리오 수와 차단 항목 목록을 내고 종료 값 0이다. `--release`를 주면 차단 항목이 하나라도 남아 있을 때 종료 값 2다. `--write`는 R6의 문서를 다시 쓴다.
- **H03C3-R6 (사람이 읽는 문서)** `docs/FINAL_SCENARIOS.md`는 표에서 만든다. 시나리오마다 이름, 상태, 대역·개발 장비 증거(파일과 시험 제목), 설치본·실제 Provider 증거(없으면 "없음"), 차단 항목을 보여 준다. 머리말에 "대역 통과는 실제 동작의 증거가 아니다"와 만든 명령을 적는다. 손으로 고치지 않는다.
- **H03C3-R7 (첫 표)** 첫 표는 14개 모두를 채운다. 증거는 파일을 열어 확인한 시험만 적는다. 이 저장소에는 설치본 결과가 없으므로 `verified`는 0개다.
- **H03C3-R8 (후속, 이슈 #317)** 검사기를 다음처럼 조인다.
  1. `needsProvider`는 이름처럼 검사기의 고정 목록이 들고 있고 표에는 없다. 표에 `needsProvider` 키가 있으면 모르는 키로 어긋난다. Provider를 부르는 시나리오는 표가 무엇을 적든 실제 Provider의 설치본 `site-result` 없이 `verified`가 될 수 없다.
  2. `unit` 증거의 `path`가 vitest가 돌리지 않는 폴더(`vitest.config.ts`의 `exclude`를 그대로 옮긴 고정 목록: `node_modules`는 깊이와 무관, `eval`·`verification`은 저장소 루트 바로 아래만, 대소문자 무시 — [HVT spec](2026-11-24-HVT-h03-verification-tools.md) R7) 아래이면 어긋난다. `measure`의 `eval/results/` 경로는 영향이 없다.
  3. `path`나 `procedure`가 폴더라서 읽다가 예외가 나면 그 시나리오 ID를 든 어긋난 줄을 내고 종료 값 1이다(예외로 끝나지 않는다).
  4. `path`·`procedure`는 윈도 드라이브 절대 경로(`C:\x`, `C:/x`, `C:x`)와 역슬래시를 거부한다.
  5. `provider: none`은 "그 시험 자체가 Provider도 대역도 부르지 않는다"는 뜻이다. 시험이 읽는 미리 채운 자료는 이전에 대역이 만들었을 수 있다. 만든 문서 머리말에 이 한 줄을 적는다.

## 인터페이스 / 설계 개요

| 파일 | 무엇 |
|---|---|
| `eval/final-scenarios.json` | 증거 표 원본(R1) |
| `tooling/scenarios/final-scenarios.ts` | 검사와 문서 만들기. 표와 "파일 읽기" 함수를 받아 어긋난 줄 목록을 돌려주는 함수, 표를 받아 Markdown을 돌려주는 함수 |
| `tooling/scenarios/check.ts` | 명령 진입점. 인자와 출력 함수를 받아 종료 값을 돌려주는 함수 하나를 부른다 |
| `tooling/scenarios/final-scenarios.test.ts` | 시험(`pnpm test`에 들어간다) |
| `docs/FINAL_SCENARIOS.md` | 만든 문서(R6) |
| `package.json` | `"check:scenarios": "node tooling/scenarios/check.ts"` 한 줄 |

검사 함수가 파일 시스템 대신 "파일 읽기" 함수를 받으므로, 어긋난 표의 시험은 임시 폴더 없이 메모리의 표와 가짜 읽기 함수로 쓴다.

## 완료 기준 (테스트 가능한 형태)

- **H03C3-C1** (R1·R2·R4·R7) 저장소의 `eval/final-scenarios.json`을 실제 파일 시스템으로 검사하면 어긋난 줄이 0개이고, 시나리오가 14개이고, `verified`가 0개이고, 모든 시나리오에 차단 항목이 하나 이상 있다.
- **H03C3-C2** (R4의 1·3) 맞는 표에서 ① 시나리오 하나를 빼거나 같은 ID를 두 번 넣으면 ② 증거의 `title`을 그 파일에 없는 글자로 바꾸면, 검사가 그 시나리오 ID를 이름으로 든 줄을 낸다.
- **H03C3-C3** (R2·R3, R4의 4) 맞는 표에서 ① 저장소 안 시험 증거에 `provider: real`이나 `environment: windows-installer`를 적으면 ② `site-result` 없이 `status`를 `verified`로 바꾸면 ③ `verified`가 아닌 시나리오의 `blockers`를 비우면, 검사가 각각 그 시나리오 ID를 든 줄을 낸다. 설치본·실제 Provider `site-result`를 갖추고 차단 항목이 없는 `needsProvider` 시나리오는 `verified`로 통과한다.
- **H03C3-C4** (R5) 차단 항목이 남은 맞는 표로 명령 함수를 부르면 종료 값 0이고 출력에 차단 항목 수가 있다. 같은 표에 `--release`를 주면 2, 어긋난 표는 인자와 무관하게 1이다.
- **H03C3-C5** (R6) 저장소의 `docs/FINAL_SCENARIOS.md`가 저장소의 표로 지금 만든 글자와 같다(표만 고치고 문서를 다시 만들지 않으면 실패한다). 만든 글자에 14개 ID가 모두 있다.
- **H03C3-C6** (R5) PR 직전 전체 실행(`pnpm lint`, `pnpm typecheck`, `pnpm test`)이 통과하고, README에 `pnpm check:scenarios` 한 줄이 있다. PR 본문에 명령·관찰한 출력(상태별 수, 차단 항목 수)·미검증 범위를 적는다.

- **H03C3-C7** (R8의 1) 표에 `needsProvider: false`를 적고 대역 설치본 `site-result`로 FS04를 `verified`로 바꾸면, 검사가 FS04를 든 줄을 `needsProvider`(모르는 키)와 `verified needs`(상태 조건) 두 가지로 낸다. 검사기의 상태 조건에서 고정 목록 확인을 빼면 이 시험이 빨개진다.
- **H03C3-C8** (R8의 2·3·4) `eval/`·`verification/`·`node_modules/` 아래 `unit` 경로, 폴더를 가리키는 `path`·`procedure`(읽기가 예외를 던지는 경우), 드라이브 절대·역슬래시 경로는 각각 그 시나리오 ID를 든 줄을 내고(폴더는 종료 값 1), `eval/results/` 아래 `measure`는 어긋나지 않는다. R8의 5는 C5가 머리말 글자까지 같은지 본다.

변이 확인은 C7의 고정 목록 확인(Provider를 부르는 시나리오가 실제 Provider 결과 없이 `verified`가 되는 것을 막는 한 줄)에만 한다. 나머지 검사(C2~C5·C8)는 출시 여부를 알리는 보고 도구의 검사이고 보안·자료 보호의 허용·차단을 가르지 않으므로 변이 확인을 하지 않는다. C2·C3의 "어긋난 표가 걸린다"가 그 몫을 한다.

## 잠정 결정

| 결정 | 이유 | 바꾸려면 |
|---|---|---|
| **D1** 원본은 JSON 하나, 사람용 문서는 거기서 만들고 시험이 둘이 같은지 본다 | 표를 두 곳에 손으로 적으면 한쪽이 낡는다 | 문서를 손으로 쓰는 쪽으로 바꾸고 C5를 지운다 |
| **D2** 표는 `eval/`, 검사기는 `tooling/scenarios/`에 둔다 | `eval/`은 평가 자료·결과의 자리이고 Vitest가 그 안의 시험을 돌리지 않으므로 자료만 둔다. `tooling/`은 타입 검사를 받고 `pnpm test`에 들어가며 제품 빌드에 들어가지 않는다(`tooling/workspace/typecheck.ts`가 같은 꼴) | 파일을 옮기고 `package.json`·README의 경로를 고친다 |
| **D3** 차단 항목이 남아도 기본 실행은 종료 값 0이고, `--release`만 2로 끝난다 | "표가 맞는가"는 PR마다 지켜야 하고 "출시해도 되는가"는 출시 때 묻는다. 둘을 합치면 설치본이 없는 공용 저장소의 `pnpm test`가 언제나 실패한다 | 출시 절차가 생기면 그 절차가 `--release`를 부른다 |
| **D4** 상태는 셋(`verified`·`mock-only`·`unverified`)이고, 왜 막혔는지는 차단 항목의 `kind` 넷으로 적는다 | 한 시나리오가 설치본·실제 Provider·통과선에 동시에 막힐 수 있어 상태 하나로는 다 적지 못한다 | 어휘를 늘리고 `schemaVersion`을 올린다 |
| **D5** 설치본·실제 Provider 증거는 이슈 댓글 주소(`site-result`)로만 적는다 | 배포처 결과는 이슈에 올리는 것이 정해진 길이다(`verification/README.md`). 저장소 안 시험은 개발 장비와 대역으로만 돈다. 검사기는 주소의 모양만 보고 열어 보지 않는다 | 결과 파일을 저장소에 넣는 길이 생기면 종류를 하나 더한다 |
| **D6** 시험 제목은 "그 글자가 파일 안에 그대로 있는가"로 본다 | 시험 파일을 해석하거나 실행하지 않고도 제목이 바뀌거나 시험이 지워진 것을 잡는다. 제목에 변수가 섞인 시험은 변수 아닌 부분을 적는다 | 시험 실행 결과(JSON reporter)와 대조하는 요구사항 추가 |
| **D7** `needsProvider`는 그 시나리오의 걸음 자체가 Provider를 부를 때만 참으로 둔다(FS02·FS04~FS09·FS12). 값은 검사기의 고정 목록에 있고 표에서 바꿀 수 없다(R8의 1, #317) | 가져오기·알림·피드백·삭제·재시작·설치는 Provider 없이 끝나는 걸음이라 실제 Provider를 요구하면 풀 수 없는 차단이 된다 | 검사기의 고정 목록(`FINAL_SCENARIOS`)의 값을 바꾼다 |
| **D8** FS14에는 `threshold` 차단 항목을 적는다 | 기록된 유일한 측정(`eval/results/h03-c2-dev.json`)의 "다시 뜬 뒤 첫 작업까지"가 약 120초로 통과선 60초를 넘는다. 개발 장비 값이라 판정은 아니지만, 그 뒤의 수정(#294)을 다시 재지 않았으므로 푼 것으로 적지 않는다 | 다시 잰 결과가 통과선 안이면 그 줄을 지운다 |
| **D9** 이슈 #34의 선행 작업(#33, #37 등)은 이 범위에 적용하지 않는다 | 표와 검사기는 이미 main에 있는 시험만 가리킨다 | 선행 작업이 끝나면 `site-result`를 더하는 후속 작업 |

## 미검증 범위

- **14개 시나리오 전부의 Windows 설치본 실행.** 이 작업은 표를 만들 뿐이고 어떤 시나리오도 설치본에서 돌리지 않았다. H03-C3의 본문("Windows 설치본에서 모두")은 충족되지 않으며 체크박스를 닫지 않는다.
- **실제 Provider.** 표의 모든 증거는 대역이거나 Provider를 부르지 않는다.
- **배포처 수집기.** FS03의 실제 메일·메신저·Wiki 수집기는 공용 저장소에서 `미구현`을 답하는 자리뿐이다. 합성 JSONL·로컬 파일 가져오기만 증거로 적는다.
- **표가 가리키는 시험이 그 시나리오를 충분히 덮는가.** 검사기는 파일과 제목이 있는지만 본다. 시험이 시나리오의 뜻을 얼마나 덮는지는 사람이 고른 것이고 독립 검토가 본다.
- **`site-result` 주소의 내용.** 주소의 모양만 보며, 그 댓글이 정말 설치본 결과인지는 표를 고치는 PR의 검토가 본다.

## 변경 이력

| 날짜 | 변경 내용 | 사유 |
|---|---|---|
| 2026-11-24 | 작성·확정 | #34 H03-C3 공용 범위 |
| 2026-11-24 | R8·C7·C8 추가, D7 수정(`needsProvider`를 검사기 고정 목록으로, 폴더 경로·드라이브 경로 거부, `provider: none` 뜻) | 이슈 #317 독립 검토 지적 F1·F3·F4·F5·F6 |
| 2026-11-24 | 변이 확인 문장을 C7에만 하는 것으로 고침(C7과 모순), R8의 2 폴더 범위를 vitest `exclude`와 같게(루트 기준·대소문자 무시) | 이슈 #317 FU2·FU3·FU4, [HVT spec](2026-11-24-HVT-h03-verification-tools.md) |
