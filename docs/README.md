# 문서 색인

이 디렉터리의 문서를 한곳에 모은 목록이다. 제품 코드는 아직 없고, 여기 있는 것은 설계·조사·결정·구현 기준이다. 처음 읽는다면 위에서 아래 순서를 권한다.

**읽기 전에**: 이 문서들은 아무것도 설치하거나 실행하지 않고 썼다. "잠정"이라고 적힌 결정은 배포처에서 실행해 확인하기 전의 것이며, 그 확인은 R07(이슈 #37)에서 한다. spec의 "확정"은 구현할 기준이 고정되었다는 뜻이지 그 기준이 충족되었다는 뜻이 아니다. 낯선 말은 [ARCHITECTURE 0절](ARCHITECTURE.md#0-처음-나오는-말)에 풀이가 있다.

## 구조

| 문서 | 무엇인가 | 상태 |
|---|---|---|
| [design/original-design.md](design/original-design.md) | 사용자가 쓴 원 설계. 요구사항의 출처이며 고치지 않고 보관한다 | 원문 |
| [OSS_EVALUATION.md](OSS_EVALUATION.md) | 재사용할 오픈소스 엔진과 스택의 비교, 채택·보류·기각 판정 | 소스 읽기 결과, 실행 전 |
| [research/2026-11-21-cli-provider-terms-and-isolation.md](research/2026-11-21-cli-provider-terms-and-isolation.md) | Claude Code·Codex CLI를 제품이 호출해도 되는지(약관)와 격리할 수 있는지의 문서 조사 | 문서 조사, 실행 전 |
| [research/2026-11-21-R00-initial-base.md](research/2026-11-21-R00-initial-base.md) | 빈 저장소에 최초 commit을 올린 절차와 증거 | 보관 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 구성요소, 프로세스, 정본과 투영, 어댑터 규격, 실패 복구, 보안, **가정 표** | 잠정 |
| [adr/](adr/README.md) | 결정 기록 14건(잠정 9, 확정 4, 미결 1) | 색인 참조 |
| [REUSE_AND_BUILD.md](REUSE_AND_BUILD.md) | 기능별 재사용·직접 개발·미룸 목록 | 잠정 |
| [ownership.md](ownership.md) | 공용 저장소와 배포처 포크가 각각 무엇을 갖는가 | 확정(ADR 0012) |
| [site-setup.md](site-setup.md) | 배포처가 채울 설정의 형태와 체크리스트 | 잠정(설정 키 이름은 V01에서 확정) |
| [specs/2026-11-21-R01-oss-evaluation.md](specs/2026-11-21-R01-oss-evaluation.md) | OSS 평가 작업(R01)의 요구사항과 완료 기준 | 확정 |
| [specs/2026-11-21-R06-provisional-architecture.md](specs/2026-11-21-R06-provisional-architecture.md) | 잠정 아키텍처 작업(R06)의 완료 기준과, 기준마다 그것을 충족하는 문서 | 초안 |
| [specs/2026-11-21-V01-vertical-skeleton.md](specs/2026-11-21-V01-vertical-skeleton.md) | Phase 1 뼈대(V01)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-V02-vertical-slice.md](specs/2026-11-21-V02-vertical-slice.md) | Phase 1 수직 흐름(V02)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I01-connector-sdk.md](specs/2026-11-21-I01-connector-sdk.md) | Connector SDK 규격 v2, 원본·근거 계약, JSONL·API 가져오기(I01)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I03-persistent-queue.md](specs/2026-11-21-I03-persistent-queue.md) | 영속 작업 대기열·스케줄러·재시도와 절전 복구(I03)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |

## 동작 방식

문서가 서로 기대는 순서다.

1. **원 설계**가 무엇을 만들지 정한다.
2. **조사 문서**(OSS 평가, CLI Provider 조사)가 무엇을 재사용할 수 있고 무엇이 아직 확인되지 않았는지 적는다.
3. **ADR**이 조사 근거로 결정을 하나씩 내리고, 실행 근거가 없는 결정은 잠정으로 둔다.
4. **ARCHITECTURE**가 그 결정들을 한 구조로 묶고, 잠정 결정이 기대는 가정을 표로 모은다.
5. **구현 spec**(V01, V02)이 그 구조에서 만들 것과 통과 기준을 정한다.
6. **배포처**가 site-setup의 체크리스트를 따라 실행 검증을 하고, R07에서 가정 표와 대조해 ADR을 확정하거나 고친다.

## 앞으로 쓸 spec

구현 spec은 그 작업을 시작할 때 쓴다(이슈 #15 R06-C1). 지금은 Phase 1의 둘만 있다.

| 작업 | 이슈 | spec을 쓰는 때 |
|---|---|---|
| R02, R03, R04(배포처 실행 검증의 사외 준비) | #11, #12, #13 | 각 작업 착수 시. 실행 절차서와 결과 기록 양식을 함께 낸다 |
| R05(골든 데이터와 평가 기준) | #14 | 착수 시. V02보다 먼저 닫혀야 한다 |
| I01~I04(Phase 2 수집) | #18~#21 | Phase 1이 끝난 뒤 각 작업 착수 시 |
| S01~S03(Phase 3 Semantic) | #22~#24 | R07의 엔진 결정 뒤 |
| K01~K02(Phase 4), P01~P03(Phase 5), X01~X02(Phase 6), H01~H03(Phase 7) | #25~#34 | 각 작업 착수 시 |

## 참고

- 전체 계획과 작업 사이의 선후: [이슈 #1 총괄](https://github.com/nohdol97/PKI/issues/1)
- 저장소 소개: [../README.md](../README.md)
