# PKI — Personal Knowledge Intelligence

개인 업무 지식을 수집하고(Remember), 의미를 추출해 연결하며(Understand·Connect), 스스로 다시 정리하고(Evolve·Reflect), 놓친 것을 찾아 알려 주고(Discover·Notify), 근거와 함께 답하는(Answer·Learn) 로컬 우선 데스크톱 제품입니다.

## 현재 상태

계획 단계입니다. 제품 코드는 아직 없으며, 엔진·저장소·런타임은 Phase 0의 실행 PoC 뒤에 확정합니다.

- 전체 계획과 완료 기준: [#1 총괄](https://github.com/nohdol97/PKI/issues/1)
- 지금 진행 중인 단계: [#2 Phase 0 — OSS Research & PoC](https://github.com/nohdol97/PKI/issues/2)

## 작업 방식

- 이 저장소에는 범용 제품만 둡니다. 실제 메일·메신저·Wiki 수집기와 환경별 연동은 배포처 포크에서 구현합니다.
- 테스트와 이슈에는 합성 데이터만 사용합니다.
- 최초 커밋 이후의 모든 변경은 feature 브랜치와 Pull Request로만 들어옵니다. `main`에 직접 push하지 않습니다.
- 구현 전에 `docs/specs/`에 요구사항과 완료 기준을 먼저 고정합니다.

## 배포처 검증 키트

Phase 0의 실행 PoC(CLI 격리 R02, 엔진·임베딩·저장소 비교 R03, Windows 설치 파일 R04)는 배포처에서만 실행할 수 있어, 사외에서는 스펙·스크립트·절차서·결과 양식만 준비해 두었습니다. 무엇을 어떤 순서로 실행하고 결과를 어떻게 이슈에 남기는지는 [verification/README.md](verification/README.md)를 보세요. 이 키트는 아직 어떤 실제 대상에 대해서도 실행된 적이 없습니다.

## 라이선스

[MIT](LICENSE)
