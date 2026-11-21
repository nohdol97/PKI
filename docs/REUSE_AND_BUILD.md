# 재사용 기능과 직접 개발 기능 목록

- 날짜: 2026-11-21 / 상태: 잠정
- 관련: 원 설계 2절 "Open Source First"·19절 Phase 0 산출물, [OSS_EVALUATION.md](OSS_EVALUATION.md), [ARCHITECTURE.md](ARCHITECTURE.md), [adr/](adr/README.md)

원 설계가 Phase 0 산출물로 요구한 목록이다. 기능마다 **재사용**(어떤 오픈소스를 쓰는가), **직접 개발**(왜, 어디까지), **미룸**(어느 작업에서 정하는가) 중 하나로 적었다.

읽기 전에 알아 둘 것:

- "판정" 칸의 채택·보류·기각은 [OSS_EVALUATION](OSS_EVALUATION.md)의 판정 그대로이며 괄호 안이 그 절 번호다. 그 문서는 **아무것도 설치하거나 실행하지 않고** 쓴 것이라 "채택(확정)"된 엔진은 없고, 스택의 "기본값"도 전부 잠정이다.
- Windows에서의 동작은 전부 미검증이다.
- "보류"는 탈락하지 않았고 배포처 실행 확인(R03)으로 넘겼다는 뜻이다.

## 1. 재사용

| 기능 | 재사용 대상 | 판정(OSS_EVALUATION) | 쓰는 방식 |
|---|---|---|---|
| 데스크톱 쉘 | Electron | 잠정 기본값(4.1절, 4.8절) | [ADR 0007](adr/0007-packaging.md) |
| 설치 파일 | electron-builder(NSIS) | 잠정 기본값(4.1절, 4.7절 6번) | ADR 0007. Windows 검증은 R04 |
| 자동 업데이트 | electron-updater | 잠정 기본값(4.1절) | ADR 0007. 서명 정체성이 정해질 때까지 켜지 않는다 |
| 화면 | React, Vite, shadcn/ui | 잠정 기본값(4.2절, 4.8절) | shadcn/ui는 컴포넌트 코드를 저장소로 복사하는 방식 |
| 화면 자동 테스트 | Playwright | 잠정 기본값(4.2절). Electron 지원은 실험적 | V01, V02의 E2E |
| 정본 저장 | better-sqlite3 | 잠정 기본값(4.3절, 4.8절) | [ADR 0004](adr/0004-embedded-storage.md) |
| 벡터 색인 | sqlite-vec | 잠정 기본값이나 위험 "높음"(4.3절). 차선 LanceDB(4.8절) | ADR 0004. `VectorIndex` 어댑터 뒤의 **후보**다. Phase 1에는 넣지 않고(규격과 test double만), 배포처 확인 뒤 R07에서 채택을 정한다 |
| Embedding 런타임 | Transformers.js(onnxruntime-node) | 잠정 기본값(4.5절, 4.8절). 위험 "중간" | [ADR 0006](adr/0006-embedding.md). `EmbeddingProvider` 어댑터 뒤 |
| Embedding 모델 | BAAI/bge-m3(int8 ONNX) | 잠정 기본값. 차선 multilingual-e5-base(4.8절) | ADR 0006. 설치 파일에 넣지 않고 설치 뒤에 준비(로컬 팩 또는 승인한 내려받기) |
| LLM 호출 | 사용자가 설치한 Claude Code CLI, Codex CLI. OpenAI 호환 HTTP 엔드포인트 | 평가 대상 아님(제품이 번들하지 않는다). 사용 조건과 격리는 [CLI Provider 조사](research/2026-11-21-cli-provider-terms-and-isolation.md) | [ADR 0005](adr/0005-llm-providers.md). 설치본은 격리가 검증된 CLI 조합만 실행한다 |
| 지식 엔진(추출 보강, 개체 해소, 관련 문맥 검색) | LightRAG, cognee, sage-wiki 중 실행을 통과한 것 | **보류**(5.1절) | `KnowledgeEngine` 어댑터 뒤. Phase 1에는 꽂지 않는다([ADR 0003](adr/0003-phase1-without-engine.md)) |
| 시간 그래프 저장 | cortexdb | **보류**(5.1절). 제품의 SQLite 스키마와 R03-C4에서 비교 | 채택되면 어댑터 뒤 |
| 그래프 저장소 | LadybugDB | 필요할 때 어댑터 뒤에서만(4.7절 3번, 4.8절) | Phase 1에는 없다 |
| LLM Wiki | sage-wiki(엔진과 함께 얻는 경우), llm-wiki-compiler | 둘 다 **보류**(5.1절). 뒤쪽은 K01에서 재평가 | Phase 4(K01)에서 결정 |
| 문서 파싱 | pdfjs-dist(PDF), mammoth(DOCX), SheetJS CDN 또는 read-excel-file(XLSX), 복잡한 PDF에는 선택적 Docling | 잠정 기본값(4.4절, 4.8절) | Phase 2(I02)에서 결정 |
| Python 런타임 번들 | python-build-standalone | 사이드카가 필요할 때만(4.6절, 4.8절) | [ADR 0011](adr/0011-sidecar-language.md)이 미결 |

### 1.1 설계만 참고하는 것(코드를 가져오지 않는다)

| 대상 | 참고하는 것 | 판정 |
|---|---|---|
| graphiti | 사실에 "현실에서 참이었던 기간"과 "기록된 시각"을 따로 두는 모델 | 엔진으로는 기각. 설계 참고만(5.1절) |
| Hyper-Extract | 원본을 지울 때 그 원본만 기여한 항목은 지우고 공유 항목은 다시 병합하는 설계 | 기각. 참고 용도(5.1절) |
| tigerless-labs/agent-memory | `claude -p`, `codex exec`의 격리 플래그 조합 | 기각. R02의 입력(5.1절) |
| Astro-Han/karpathy-llm-wiki | 근거 문자열을 원문과 대조하는 확인 스크립트 아이디어 | 기각. 참고 용도(5.1절) |

### 1.2 번들할 수 없는 것

jina-embeddings v3/v4/v5, PyMuPDF, FalkorDBLite. EmbeddingGemma는 조건부이며 기본값으로 쓰지 않는다(4.7절 1~2번, 5.2절). 기준은 [ADR 0009](adr/0009-license.md).

## 2. 직접 개발

원 설계 2절이 직접 개발에 집중하라고 한 여덟 영역과, 조사 결과 직접 갖기로 한 것들이다. "범위 제한"은 그 이상을 만들지 않는다는 선이다.

| 기능 | 왜 직접 만드는가 | 범위 제한 |
|---|---|---|
| 개인 Semantic 구축 정책 | 원 설계가 지정한 제품의 핵심 자산(6절) | 정책과 기록. 온톨로지 변경은 후보 → 중복 검사 → 검증을 거친다 |
| 정보 간 관계 재분석(Reflection) | 원 설계 지정(9절) | 바뀐 항목과 미해결 충돌 중심의 제한된 재계산. 통합·요약 알고리즘은 엔진에 맡긴다 |
| Insight Discovery | 원 설계 지정. 제품의 차별화 영역(10절) | 날짜 비교, 상태 변경, 의존 충돌, 중복 검사는 결정론 코드. 의미 해석만 LLM |
| Proactive Feedback(알림, Digest) | 원 설계 지정(11절) | Phase 5 |
| 사용자 피드백 기반 개인화 | 원 설계 지정(12절) | 피드백 기록, 순위 가중치, 선호. 미세 조정이나 강화 학습은 하지 않는다 |
| LLM Provider 통합 | 원 설계 지정(4절) | Provider 3종, Broker, 전송 정책, CLI 실행 조건([ADR 0005](adr/0005-llm-providers.md), [0014](adr/0014-egress-policy-and-consent.md)) |
| Connector 인터페이스 | 원 설계 지정(5절) | 규격, 계약 테스트, JSONL·파일 import, 테스트 Connector. 실제 수집기는 배포처 포크 |
| 제품 UX | 원 설계 지정(14절) | 화면 8개. Phase 1은 Home, Sources, Activity, Settings의 최소 화면 |
| **정본 기록 스키마**(원본 version, 근거 span, 지식 항목과 관계, 유효·관측 시각, 상태, 사용자 교정, tombstone) | 시간 유효성, span 수준 근거, 삭제 시 파생물 제거를 모두 갖추었다고 실행으로 확인된 엔진이 없다. 사용자 교정 보존은 평가되지 않았다(6절 1번) | **기록 보관까지만.** 검색 파이프라인, 유사도 기반 개체 해소, 일반 그래프 탐색, 벡터 색인, Wiki 합성은 만들지 않는다([ARCHITECTURE 3.2절](ARCHITECTURE.md), [ADR 0002](adr/0002-authority-in-product-records.md)). 사용자 확인 대기이며 R07에서 뒤집힐 수 있다 |
| **Phase 1의 추출 조율** | 엔진 선정을 기다리면 Phase 1이 멈춘다([ADR 0003](adr/0003-phase1-without-engine.md)) | 원본당 구조화 호출 1회, chunk 분할 없음, 정확 일치로만 후보 조회. 이 선을 넘는 기능은 엔진을 꽂아서 얻는다 |
| 작업 큐와 실행기 | 정본과 같은 SQLite 트랜잭션 안에서 작업을 등록해야 version fence가 성립한다. 기성 작업 큐 구성요소는 조사에서 평가하지 않았다 | 한 프로세스, SQLite 테이블, 임대와 재시작 복구까지. 분산 처리는 하지 않는다. Phase 2(I03)에서 기성 구성요소를 다시 검토한다 |
| 실패 복구(fence, 내용 없는 tombstone, 변경 순번 비교와 재구축) | 저장소 사이의 일관성은 제품의 정본 규칙에 달려 있다([ADR 0013](adr/0013-failure-recovery.md)) | 정본 한 곳과 투영의 관계까지. outbox는 Phase 1에 넣지 않는다 |
| Local API 보안, Electron 보안 설정 | 원 설계 16절이 지정. 구성요소가 아니라 설정과 검사다([ADR 0008](adr/0008-security-baseline.md)) | 기준선 표의 항목 |
| 어댑터 규격과 계약 테스트 | 뒤집힐 수 있는 선택을 격리하는 장치(V01-C7, V02-C5) | Provider, Embedding, KnowledgeEngine, VectorIndex, Connector 다섯 개와 SQL 드라이버 포트 |
| 품질 평가 도구와 합성 골든 데이터 | 원 설계 18절 | R05(#14) |

## 3. 미룸

| 기능 | 정하는 작업 | 지금 정하지 않는 이유 |
|---|---|---|
| 지식 엔진 선정과 사이드카 언어 | R03, R04 실행 뒤 R07 | 실행 근거가 없다 |
| 벡터 색인의 실제 구현 | R03 실행 뒤 R07 | sqlite-vec의 Windows 로드와 서명 차단 여부를 확인하지 못했다. Phase 1 기준 중 벡터 검색을 요구하는 것이 없다([ADR 0004](adr/0004-embedded-storage.md)) |
| 정본 SQLite의 파일 단위 암호화 | H01(#32) 전에 드라이버 조사 | 암호화 SQLite 구성요소를 평가하지 않았다([ADR 0010](adr/0010-encryption-at-rest.md)) |
| outbox | 벡터에 실제 지식을 색인하는 작업 | Phase 1의 투영은 재구축 비용이 없어 통지와 변경 순번 비교로 충분하다([ADR 0013](adr/0013-failure-recovery.md)) |
| 파일 형식별 파싱, 폴더 감시 | I02(#19) | Phase 1은 JSONL만 다룬다 |
| 개체 해소, 시간 그래프, 충돌 처리 | S02(#23) | 엔진 선정에 달려 있다 |
| LLM Wiki, Backlink, 재생성 | K01(#25) | Wiki 계층 후보가 보류다 |
| Reflection, Knowledge Lint | K02(#26) | Phase 4 |
| 알림, Digest, Timeline | P02(#28) | Phase 5 |
| Hybrid Retrieval, 질의응답 | X01(#30) | Phase 6. Phase 1은 벡터 색인에 지식을 넣지 않는다 |
| Knowledge Graph 시각화 | X02(#31) | Phase 6. 시각화 구성요소는 조사하지 않았다 |
| 백업·복구, 마이그레이션, 모델 재색인 | H01(#32) | Phase 7 |
| 서명, 업데이트 배포 | H02(#33), 배포처 설정 S12 | 서명 정체성 미정 |
| 로컬 모델 Provider | 요구가 생길 때 | 원 설계에서 선택 항목이다. 계약만 두고 "미구현"을 알린다 |
