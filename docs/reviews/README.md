# 단계 완료 Gate 검토 색인

각 Phase 에픽(#2~#9)의 본문은 "완료 Gate: 모든 하위 C기준의 증거와 미검증 항목을 검토한다"를 요구한다. 이 디렉터리는 그 검토 결과다. 기준: 2026-11-24, `origin/main` `80a7962b`(PR #319·#322·#323·#324·#325 머지까지 반영). 문서는 증거 경로가 이 저장소에 있는지와 인용한 PR이 머지됐는지까지만 확인했고, 시험을 다시 돌리지 않았다.

## 판정 말

| 판정 | 뜻 |
|---|---|
| `증거 있음` | 머지된 PR과, 인용한 경로에 실제로 있는 시험 또는 산출물이 있다. mock 결과·소스 읽기·이슈 댓글만으로는 쓰지 않았다 |
| `미검증 — Windows 필요` | Windows 11 설치본이나 Windows 실행이 있어야 확인된다 |
| `미검증 — 배포처 필요` | 실제 Provider·실제 출처 시스템·배포처 환경이 있어야 확인된다 |
| `미검증 — 보류(사유)` | 사용자 결정이나 외부 결정 때문에 지금 확인하지 않기로 한 것 |
| `증거 없음` | 저장소에서 근거를 찾지 못했다 |

## 문서

| Phase | 에픽 | 문서 |
|---|---|---|
| 0 OSS Research & PoC | #2 | [phase0](2026-11-24-phase0-gate-review.md) |
| 1 Vertical Slice | #3 | [phase1](2026-11-24-phase1-gate-review.md) |
| 2 Information Ingestion | #4 | [phase2](2026-11-24-phase2-gate-review.md) |
| 3 Semantic Knowledge | #5 | [phase3](2026-11-24-phase3-gate-review.md) |
| 4 Knowledge Consolidation | #6 | [phase4](2026-11-24-phase4-gate-review.md) |
| 5 Proactive Intelligence | #7 | [phase5](2026-11-24-phase5-gate-review.md) |
| 6 Knowledge Experience | #8 | [phase6](2026-11-24-phase6-gate-review.md) |
| 7 Production Readiness | #9 | [phase7](2026-11-24-phase7-gate-review.md) |

## 한눈에 보기

어느 Phase도 Gate 통과로 선언하지 않는다. 공용 범위의 구현은 Phase 1~6에서 대체로 머지됐지만, 모든 Phase에 Windows·배포처 실행이 필요한 기준이 남아 있다. 에픽 본문대로 Phase 0의 R07(#37)이 닫혀야 Phase 0과 1을 통과로 표시할 수 있다. `증거 없음` 판정인 기준은 지금 하나도 없다. 접근성 점검(X02-C3b)은 자동 점검(axe·키보드 흐름)만 `증거 있음`(PR #325)이고 화면 낭독기·Windows 배율·고대비·설치본은 `미검증 — Windows 필요`로 나눴다. Phase 7의 최종 시나리오(H03-C3)는 매핑 표와 검사기가 머지됐으나(PR #318·#322) 14개 모두 대역 증거뿐이라 Windows 필요로 판정했다. 기준일 이후 머지된 PR #319·#323(화면 늦은 응답)·#324(장부 재적용 뒤 폴더 멈춤 표시)는 아래 문서의 해당 행에 반영했다.

## 이슈 표류

문서가 "이슈 표류"라 부르는 것은 이슈의 라벨·본문 체크박스가 실제 상태와 어긋난 것이다. 라벨 어긋남은 2026-11-24에 #321에서 바로잡았다. #23·#24·#28·#31(닫힘)은 `blocked`를 떼어 `task`만 남겼고, #21·#29·#33(열림)은 `blocked`를 `site-verify`로, #19·#22·#25·#32(열림)는 `in-progress`를 `site-verify`로 바꿨다. 각 문서의 라벨 표기는 이 정리 뒤의 값이다. 아래는 아직 남은 어긋남이며 `gh`로 측정한 값이다(다시 측정할 것).

| 이슈 | 측정한 상태 | 어긋남 |
|---|---|---|
| #32 | open, 본문 H01-C1~C3 체크박스 모두 `[x]` | 이슈는 열려 있고 진행 로그는 암호화 드라이버·Windows·실제 모델을 미검증으로 남김 |
