# ADR 0001: 모듈형 모놀리식과 TypeScript 스택

- 날짜: 2026-11-21 / 상태: **잠정 — 배포처 검증 대기**
- 관련: 원 설계 2~3절·15~16절, [ARCHITECTURE 2~3절](../ARCHITECTURE.md), 가정 A13, A18

## 맥락

원 설계는 "Modular Monolith를 기본으로 한다", "동일한 웹 UI를 브라우저와 Electron에서 사용", "Frontend와 Backend를 Electron에 직접 종속시키지 않는다"를 요구하고, 백엔드는 "Node.js + TypeScript 기반 Local API Server를 우선 검토"하라고 한다(15절). 기존 코드는 없다(저장소가 비어 있었다). 조사에서 화면·쉘·저장소·embedding 런타임의 잠정 기본값은 모두 Node에서 도는 것으로 잡혔다([OSS_EVALUATION 4.8절](../OSS_EVALUATION.md)). 엔진 후보는 Python이나 Go이고, TypeScript/Node에서 시간 지식 그래프와 임베디드 저장소를 함께 갖춘 성숙한 프로젝트는 찾지 못했다(같은 문서 3.3절 참고).

## 결정

- **모듈형 모놀리식**: 백엔드는 프로세스 하나이고 내부를 모듈로 나눈다. 모듈은 `packages/contracts`의 규격으로만 서로 부른다.
- **백엔드**: Node.js + TypeScript 로컬 API 서버. 작업 실행기도 같은 프로세스 안에 둔다.
- **화면**: React + TypeScript + Vite. 같은 빌드를 브라우저와 Electron에서 그대로 쓴다.
- **Electron**: 실행·종료, 백엔드 프로세스 관리, 트레이·알림, OS 자격 증명 저장소 중개만 맡는다. 지식 처리 로직을 넣지 않는다.
- **저장소 배치**: 원 설계 3절의 최상위 구조(`apps/`, `backend/`, `knowledge-engine/`, `providers/`, `storage/`)를 workspace 패키지로 따른다.

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| Electron main 프로세스 안에 백엔드 로직을 넣기 | 브라우저 개발 환경에서 같은 API를 쓸 수 없게 된다(원 설계 3절 위반) |
| 백엔드를 Python으로 | 화면·쉘과 언어가 갈리고 런타임 번들이 필수가 된다. Python은 엔진 재사용이 이길 때의 사이드카로만 허용된다(원 설계 2절). 그 판단은 [ADR 0011](0011-sidecar-language.md) |
| Tauri | 사이드카 문제는 그대로이고 Rust와 WebView2 처리가 추가된다(OSS_EVALUATION 4.7절 8번, 문서 구조에서의 추정) |
| 작업 실행기를 처음부터 별도 프로세스로 | 떼어야 한다는 측정 근거가 없다. 필요해지면 모듈 경계를 따라 뗀다 |

## 결과

- 모듈 사이 직접 import를 lint로 막아야 경계가 유지된다(V01).
- 무거운 계산(embedding)이 API 응답을 늦추는지는 측정해 봐야 안다. 늦추면 그 모듈만 별도 스레드나 프로세스로 옮긴다.
- 엔진을 꽂게 되면 Node가 아닌 런타임이 사이드카로 들어온다. 그때도 백엔드는 어댑터로만 엔진과 말한다.
- 프로덕션에서 Electron에 든 Node로 백엔드를 별도 프로세스로 띄우는 방식과 Windows에서의 수명 주기는 미검증이다(A18).
