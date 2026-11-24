# PKI — Personal Knowledge Intelligence

개인 업무 지식을 수집하고(Remember), 의미를 추출해 연결하며(Understand·Connect), 스스로 다시 정리하고(Evolve·Reflect), 놓친 것을 찾아 알려 주고(Discover·Notify), 근거와 함께 답하는(Answer·Learn) 로컬 우선 데스크톱 제품입니다.

## 현재 상태

Phase 1의 골격(V01: 화면, 로컬 API, Electron 쉘, 정본 저장, Provider, Embedding)이 들어와 있고, 그 위의 수직 흐름(V02)을 구현하는 중입니다. 엔진·저장소·런타임의 선택은 아직 잠정이며 배포처의 실행 검증 뒤에 확정합니다.

잠정 아키텍처와 Phase 1 구현 spec(V01, V02)이 있습니다. 실행해 확인하기 전의 결정이며 배포처 검증 뒤에 확정합니다. 문서 전체는 [docs/README.md](docs/README.md)에서 찾을 수 있습니다.

점검(K02)은 정본이 바뀐 곳을 주기로 다시 살펴 합칠 만한 이름·빠진 관계·낡은 항목·기한이 지난 업무를 후보로 알리고, 받아들이거나 닫는 것은 사용자가 정합니다. 후보에 LLM의 의견을 붙이는 기능은 기본으로 꺼져 있으며(설정 `reflection.refine`, [docs/site-setup.md](docs/site-setup.md)) 켜도 의견만 남기고 지식은 바꾸지 않습니다.

- 전체 계획과 완료 기준: [#1 총괄](https://github.com/nohdol97/PKI/issues/1)
- 지금 진행 중인 단계: [#2 Phase 0 — OSS Research & PoC](https://github.com/nohdol97/PKI/issues/2)
- 로컬 폴더·파일 가져오기(설정 화면의 폴더 추가, 파일 추가, JSONL 파일 추가): [I02-B spec](docs/specs/2026-11-22-I02-local-file-import.md)

## 개발 명령

저장소 루트에서 실행합니다. pnpm이 `package.json`의 `devEngines`에 고정한 Node.js 24로 명령을 실행합니다(없으면 내려받습니다).

- `pnpm install` — 의존성 설치
- `pnpm lint` — ESLint(모듈 경계 규칙 포함)와 Prettier 검사
- `pnpm typecheck` — TypeScript strict 타입 검사
- `pnpm test` — Vitest 단위·계약 테스트
- `pnpm e2e` — Playwright E2E. 화면 테스트는 브라우저에서 돌리고, 주요 흐름(화면 seed 0, 가져오기→근거 열기 흐름, 신뢰할 수 없는 내용, 설정 저장, 쉘 보안·수명 주기)만 Electron 쉘에서도 돌린다(쉘 쪽은 화면을 먼저 빌드한다). 프로덕션 산출물도 먼저 빌드해 검사하고 Electron으로 띄워 본다(`--project=artifact`만 돌릴 수 있다). 처음 한 번 `pnpm exec playwright install --only-shell chromium`으로 브라우저를 받고, Electron 바이너리는 처음 실행할 때 내려받는다
- `pnpm exec playwright test apps/web/e2e/notifications.e2e.ts --project=browser` — 알림 화면(피드·요약·타임라인, 다른 탭에서 원본을 지우면 열린 화면이 스스로 바뀜)의 브라우저 E2E 하나. 쉘의 OS 알림과 트레이는 단위 시험(`apps/desktop/src/notifier.test.ts`, 가짜 Electron 객체)으로만 확인하며 실제 토스트를 띄우지 않는다. Windows 설치본의 토스트는 확인하지 않았다([site-setup S37](docs/site-setup.md))
- `pnpm --filter @pki/web dev` — 개발 백엔드(합성 자료)와 화면을 함께 띄운다. 브라우저에서 http://127.0.0.1:5173 을 연다
- `pnpm --filter @pki/backend dev` — 개발 백엔드만 띄운다(합성 자료, 데이터 폴더 `PKI-dev`). 주소와 세션 토큰을 표준 출력에 한 줄로 쓴다
- `pnpm --filter @pki/web build && pnpm --filter @pki/desktop start` — Electron 쉘로 빌드한 화면과 백엔드를 띄운다(정본 DB는 사용자 데이터 폴더)
- `pnpm --filter @pki/desktop build` — 프로덕션 빌드. 백엔드·화면·쉘을 배포 빌드로 묶어 Electron 앱 폴더 `apps/desktop/dist/app/`을 만든다(설치 파일은 만들지 않는다). 합성 목록이 낡았으면 실패한다. 네이티브 모듈은 빌드한 PC의 것만 들어가므로 Windows용은 Windows에서 빌드한다.
- `python3 verification/v02-site-flow/run.py preflight --config <config.json>` — V02 배포처 검증 실행기(Windows 설치본과 실제 Provider 전용, 그 밖에서는 `배포처 후속`을 알리고 실패한다). 절차: [RUNBOOK](verification/v02-site-flow/RUNBOOK.md)
- `pnpm --filter @pki/backend site-check <종류>` — 배포처 수집기(`site-mail`, `site-messenger`, `site-wiki`) 초기화 확인. 공용 저장소에서는 `미구현, 배포처 후속`을 알리고 실패한다
- `pnpm --filter @pki/site-example site-check <종류>` — 배포처 포크의 조립 패키지(`site/composition`)가 갖는 `site-check`와 같은 모양의 예시. 예시 등록의 수집기 종류(`connector-example`)를 확인한다
- `PKI_REAL_EMBEDDING_MODELS_DIR=<절대 경로> pnpm vitest run providers/src/adapters/embedding.roundtrip.test.ts` — 실제 bge-m3 모델로 embedding 왕복과 계약 테스트를 돈다(기본 `pnpm test`는 건너뛰고 네트워크를 쓰지 않는다). 처음 한 번 고정된 파일 약 586 MB를 내려받고, `PKI_REAL_EMBEDDING_PACK=<절대 경로>`를 주면 그 로컬 팩에서 가져온다
- `pnpm --filter @pki/providers build:synthetic-manifest` — `fixtures/`·`eval/golden/sources/`·연결 시험 자료가 바뀐 뒤 합성 목록을 다시 만든다(어긋나면 `pnpm test`와 프로덕션 빌드가 실패한다)
- `pnpm --filter @pki/providers check:synthetic-manifest` — 합성 목록이 최신인지 확인만 한다
- `pnpm --filter @pki/document-normalize build:fixtures` — 문서 정규화의 합성 시험 문서(`fixtures/documents/`)를 다시 만든다(같은 코드면 같은 바이트)
- `PKI_SLOW_E2E=1 pnpm exec playwright test apps/desktop/artifact/artifact.normalizer.e2e.ts --project=artifact` — 격리 정규화의 G23 측정(유발 XLSX가 Electron V8에서 쓰는 힙을 기록, 약 2.5분). 단언이 "두 행"과 종료 상태 형식뿐인 측정이라 기본 `pnpm e2e`에서는 건너뛴다
- `pnpm exec vitest run --config vitest.normalizer-slow.config.ts` — 격리 정규화의 느린 시험(재현 입력 둘의 상한 시험과, 유발 입력을 30번 되풀이하는 시험. 한 번에 몇 분이 걸리고 메모리를 1 GB 넘게 쓰므로 `pnpm test`는 돌리지 않는다). 정규화는 백엔드와 다른 호스트 프로세스에서 돌고, 묶인 앱에서는 주 프로세스가 그 호스트를 띄운다
- `pnpm exec node backend/src/system-measure.main.test-support.ts --out eval/results --name h03-c2-dev [--sources 200] [--queries 220] [--idle-seconds 30] [--soak-seconds 0] [--skip-kill] [--force]` — H03-C2 시스템 측정(유휴 CPU·RSS, 문서 처리·검색 시간, LLM 호출 수, 저장 증가, 강제 종료 뒤 복구)을 실제 백엔드(별도 프로세스)와 Provider 대역으로 재고 `eval/results/<이름>.json`에 쓴다. 제품의 작업 임대 2분을 그대로 두므로 기본 실행은 몇 분 걸리고(`--skip-kill`로 생략), `pnpm test`에는 작은 값으로 한 번 도는 시험만 들어간다. 개발 장비의 값은 판정이 아니라 참고값이다(통과선은 값 옆에 적기만 한다). 설치 파일 크기·Windows 설치본·실제 Provider·수 시간 연속 가동은 재지 않는다([spec](docs/specs/2026-11-24-H03-C2-measure-runner.md))
- `pnpm check:scenarios` — (`--release`, `--write` 선택) 최종 시나리오 FS01~FS14의 증거 표(`eval/final-scenarios.json`)를 검사한다: 가리키는 시험 파일과 제목이 있는지, 대역·개발 장비 증거가 설치본·실제 Provider 결과로 적혀 있지 않은지 본다(시험을 실행하지 않는다). 어긋나면 1, 맞으면 상태별 수와 출시 차단 항목을 내고 0이며 `--release`는 차단 항목이 남으면 2, `--write`는 `docs/FINAL_SCENARIOS.md`를 다시 만든다. 설치본·실제 Provider에서 확인된 시나리오는 아직 없다([spec](docs/specs/2026-11-24-H03-C3-final-scenarios.md))

화면의 "질문"에서 말로 물으면 키워드와 메타데이터 필터로 원본을 찾아(그 밖의 전략은 만들어 두었지만 측정 전까지 꺼 둡니다) 보여 주고(`POST /api/ask`, 한 줄에 사건 하나인 NDJSON), Provider가 정해져 있으면 문장마다 원본 인용이 붙은 답을 줍니다. 질문과 답은 저장하지 않으며 벡터 검색은 아직 쓰지 않습니다([X01 spec](docs/specs/2026-11-23-X01-retrieval-qa.md)).

화면의 "탐색"에서 항목 하나를 이름으로 찾아 이웃 관계, 시간순 사실, 근거 원본을 보고 그 항목의 위키 페이지로 넘어가며, "지식 검토"에서 후보를 승인·기각·값 고치기하고 충돌을 검토합니다. 두 화면은 읽기 문을 지난 것만 보여 주고 아무것도 저장하지 않습니다([X02 spec](docs/specs/2026-11-23-X02-explore-ux.md)). "탐색"에서는 이웃을 그림으로도 보고, 별칭으로 찾고, 항목을 합치고 되돌리고 나누고, 사실·관계의 유효 기간과 조치 이력을 다루며, "지식 검토"는 상태를 서버에서 걸러 "더 보기"로 잇고, "유형 정의" 화면에서 항목·사실·관계 종류를 보고 고칩니다([X02B spec](docs/specs/2026-11-24-X02B-explore-curation.md)).

배포처 설정: [docs/site-setup.md](docs/site-setup.md) · 저장소 배치: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 작업 방식

- 이 저장소에는 범용 제품만 둡니다. 실제 메일·메신저·Wiki 수집기와 환경별 연동은 배포처 포크에서 구현합니다.
- 수집기(Connector)를 새로 만드는 방법: [docs/connector-sdk.md](docs/connector-sdk.md)
- 테스트와 이슈에는 합성 데이터만 사용합니다.
- 최초 커밋 이후의 모든 변경은 feature 브랜치와 Pull Request로만 들어옵니다. `main`에 직접 push하지 않습니다.
- 구현 전에 `docs/specs/`에 요구사항과 완료 기준을 먼저 고정합니다.

## 라이선스

[MIT](LICENSE)

번들 글꼴: [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9 (SIL OFL 1.1) — 원본 그대로 `apps/web/public/fonts/`에 두며 전문은 [OFL.txt](apps/web/public/fonts/OFL.txt), 출처와 해시는 [NOTICE.txt](apps/web/public/fonts/NOTICE.txt)에 있습니다.
