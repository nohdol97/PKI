# PKI — Personal Knowledge Intelligence

개인 업무 지식을 수집하고(Remember), 의미를 추출해 연결하며(Understand·Connect), 스스로 다시 정리하고(Evolve·Reflect), 놓친 것을 찾아 알려 주고(Discover·Notify), 근거와 함께 답하는(Answer·Learn) 로컬 우선 데스크톱 제품입니다.

## 현재 상태

계획 단계입니다. 제품 코드는 아직 없으며, 엔진·저장소·런타임은 Phase 0의 실행 PoC 뒤에 확정합니다.

잠정 아키텍처와 Phase 1 구현 spec(V01, V02)이 있습니다. 실행해 확인하기 전의 결정이며 배포처 검증 뒤에 확정합니다. 문서 전체는 [docs/README.md](docs/README.md)에서 찾을 수 있습니다.

- 전체 계획과 완료 기준: [#1 총괄](https://github.com/nohdol97/PKI/issues/1)
- 지금 진행 중인 단계: [#2 Phase 0 — OSS Research & PoC](https://github.com/nohdol97/PKI/issues/2)

## 개발 명령

저장소 루트에서 실행합니다. pnpm이 `package.json`의 `devEngines`에 고정한 Node.js 24로 명령을 실행합니다(없으면 내려받습니다).

- `pnpm install` — 의존성 설치
- `pnpm lint` — ESLint(모듈 경계 규칙 포함)와 Prettier 검사
- `pnpm typecheck` — TypeScript strict 타입 검사
- `pnpm test` — Vitest 단위·계약 테스트
- `pnpm e2e` — Playwright E2E. 같은 화면 테스트를 브라우저와 Electron 쉘에서 돌린다(쉘 쪽은 화면을 먼저 빌드한다). 처음 한 번 `pnpm exec playwright install --only-shell chromium`으로 브라우저를 받고, Electron 바이너리는 처음 실행할 때 내려받는다
- `pnpm --filter @pki/web dev` — 개발 백엔드(합성 자료)와 화면을 함께 띄운다. 브라우저에서 http://127.0.0.1:5173 을 연다
- `pnpm --filter @pki/web build && pnpm --filter @pki/desktop start` — Electron 쉘로 빌드한 화면과 백엔드를 띄운다(정본 DB는 사용자 데이터 폴더)
- `pnpm --filter @pki/backend site-check <종류>` — 배포처 수집기(`site-mail`, `site-messenger`, `site-wiki`) 초기화 확인. 공용 저장소에서는 `미구현, 배포처 후속`을 알리고 실패한다
- `pnpm --filter @pki/providers build:synthetic-manifest` — `fixtures/`·`eval/golden/sources/`·연결 시험 자료가 바뀐 뒤 합성 목록을 다시 만든다(어긋나면 `pnpm test`가 실패)

배포처 설정: [docs/site-setup.md](docs/site-setup.md) · 저장소 배치: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 작업 방식

- 이 저장소에는 범용 제품만 둡니다. 실제 메일·메신저·Wiki 수집기와 환경별 연동은 배포처 포크에서 구현합니다.
- 테스트와 이슈에는 합성 데이터만 사용합니다.
- 최초 커밋 이후의 모든 변경은 feature 브랜치와 Pull Request로만 들어옵니다. `main`에 직접 push하지 않습니다.
- 구현 전에 `docs/specs/`에 요구사항과 완료 기준을 먼저 고정합니다.

## 라이선스

[MIT](LICENSE)
