# 아키텍처 결정 기록 (ADR)

제품 구조에 관한 결정을 하나씩 적은 문서다. 결정마다 맥락, 결정, 기각한 대안과 이유, 결과를 담는다. 낯선 말은 [ARCHITECTURE 0절](../ARCHITECTURE.md#0-처음-나오는-말)에 풀이가 있다.

**상태의 뜻**

- **잠정 — 배포처 검증 대기**: 실행 근거 없이 정했다. [ARCHITECTURE 9절 가정 표](../ARCHITECTURE.md#9-가정-표)의 가정에 걸려 있으며 R07(이슈 #37)에서 확정하거나 고친다.
- **사용자 확인 대기**: 사용자가 정할 일인데 아직 묻지 못했다. 개발이 멈추지 않도록 잠정으로 고른 쪽을 따라 진행한다. 네 건이 [ARCHITECTURE 맨 위 표](../ARCHITECTURE.md#사용자-확인이-필요한-결정)에 모여 있다.
- **확정**: 실행 근거가 필요 없는 결정(사용자 결정, 정책의 모양).
- **미결**: 아직 정하지 않았다. 결정 기준만 적혀 있다.

| 번호 | 결정 | 상태 | 걸린 가정 |
|---|---|---|---|
| [0001](0001-modular-monolith-and-stack.md) | 모듈형 모놀리식과 TypeScript 스택 | 잠정 | A13, A18 |
| [0002](0002-authority-in-product-records.md) | 정본은 제품의 기록, 엔진·벡터·Wiki는 투영 | 잠정, **사용자 확인 대기** | A09 |
| [0003](0003-phase1-without-engine.md) | Phase 1은 제3자 지식 엔진 없이, 어댑터와 null 구현으로 | 잠정 | A10 |
| [0004](0004-embedded-storage.md) | 저장소 — better-sqlite3 정본, 벡터는 어댑터 뒤(sqlite-vec 후보), 그래프 DB 없음 | 잠정 | A07, A08, A17 |
| [0005](0005-llm-providers.md) | LLM Provider — CLI 2종과 API 키 필수 경로, 배포 빌드는 검증된 CLI만 실행 | 잠정, **사용자 확인 대기**(가져오기 뒤의 추출을 백그라운드로 보는 부분) | A01~A06, A22 |
| [0006](0006-embedding.md) | Embedding — 별도 계약, bge-m3를 Node에서, 설치 뒤 준비 | 잠정, **사용자 확인 대기**(모델을 설치 파일에 넣지 않는 부분) | A11, A12 |
| [0007](0007-packaging.md) | 패키징 — Electron + electron-builder(NSIS) + electron-updater | 잠정 | A13, A14, A15 |
| [0008](0008-security-baseline.md) | 첫 slice부터 적용하는 보안 기준선 | 확정 | — |
| [0009](0009-license.md) | 제품 라이선스 MIT와 번들 금지 범위 | 확정 | — |
| [0010](0010-encryption-at-rest.md) | 저장 데이터 암호화의 범위와 키 보관 | 잠정 진행, **사용자 확인 대기**(번복 시 V01-T03 재작업) | A16, A19 |
| [0011](0011-sidecar-language.md) | 사이드카 언어 — Python, Go 단일 바이너리, 또는 없음 | **미결** | R03·R04 결과 |
| [0012](0012-upstream-and-fork-ownership.md) | 공용 저장소와 배포처 포크의 소유 경계 | 확정 | — |
| [0013](0013-failure-recovery.md) | 저장소 사이의 실패 복구 — 정본 먼저, fence와 tombstone, 투영은 재구축 | 잠정 | A20 |
| [0014](0014-egress-policy-and-consent.md) | 외부 전송 정책과 동의 | 확정 | — |

A21(실제 Provider의 인용문 정확도)은 ADR이 아니라 V02 spec의 추출 요구사항에 걸려 있다.

새 ADR은 다음 번호로 추가한다. 뒤집힌 ADR은 지우지 않고 맨 위에 무엇으로 대체되었는지 적는다.
