# Personal Knowledge Intelligence 구축 프로젝트

## 1. 프로젝트 목표

메일, 메신저, Wiki, 로컬 파일 등 개인의 다양한 업무 정보를 지속적으로 수집하고, 의미 있는 지식을 추출하며, 정보 사이의 관계를 자동으로 형성하고 발전시키는 개인 업무 지식 플랫폼을 구축한다.

단순한 RAG, 문서 검색, 메일 요약 서비스가 아니다.

사용자가 질문하지 않아도 시스템이 다음 작업을 지속적으로 수행하는 것이 핵심이다.

- Remember: 다양한 업무 정보 수집 및 기억
- Understand: 업무 개념, 용어, 사실, 의사결정 추출
- Connect: 서로 다른 정보 사이의 의미와 관계 발견
- Evolve: 개인별 Semantic Knowledge 발전
- Reflect: 기존 지식의 주기적 재분석 및 재구성
- Discover: 새로운 인사이트, 위험, 기회 발견
- Notify: 중요한 정보를 능동적으로 전달
- Answer: 축적된 지식 기반 자연어 질의응답
- Learn: 사용자 피드백 기반 지식 및 개인화 개선

최종 사용자는 설치 파일 하나만 설치하면 사용할 수 있어야 한다.

## 2. 핵심 개발 원칙

### Open Source First

모든 기능을 처음부터 직접 개발하지 않는다.

기존 오픈소스의 코드, 아키텍처, 확장 인터페이스, 라이선스, 유지보수 상태를 조사하고 재사용 가능한 기능을 최대한 활용한다.

우선 조사 대상:

**Knowledge 및 Memory Engine**

- https://github.com/topoteretes/cognee
- https://github.com/getzep/graphiti
- https://github.com/HKUDS/LightRAG
- https://github.com/openmemind/memind

**LLM Wiki 및 Knowledge Consolidation**

- https://github.com/ddsyasas/llm-wiki
- https://github.com/Astro-Han/karpathy-llm-wiki

**Desktop 및 Web**

- https://github.com/electron/electron
- https://github.com/electron-userland/electron-builder
- https://github.com/vitejs/vite
- https://github.com/shadcn-ui/ui

**Embedded Storage 및 검색**

- https://github.com/lancedb/lancedb
- https://github.com/LadybugDB/ladybug
- https://github.com/asg017/sqlite-vec
- https://github.com/WiseLibs/better-sqlite3

**문서 처리 및 Embedding**

- https://github.com/docling-project/docling
- https://github.com/qdrant/fastembed
- https://github.com/huggingface/transformers.js

위 프로젝트들은 조사 후보이며 모두 도입할 필요는 없다.

더 적합한 기존 오픈소스 애플리케이션을 발견하면 해당 프로젝트를 기반으로 확장하거나 라이선스가 허용하는 범위에서 Fork하는 방안도 적극 검토한다.

특히 Knowledge Engine, Graph, Vector, LLM Wiki, Memory Management를 독자적으로 다시 구현하지 않는 것을 원칙으로 한다.

직접 개발은 다음 영역에 집중한다.

- 개인 Semantic 구축 정책
- 정보 간 관계 재분석
- Insight Discovery
- Proactive Feedback
- 사용자 피드백 기반 개인화
- LLM Provider 통합
- Connector 인터페이스
- 제품 UX

### Web First, Desktop Ready

웹 애플리케이션을 기본으로 개발한다.

동일한 웹 UI를 브라우저와 Electron에서 사용할 수 있어야 한다.

- React + TypeScript + Vite 기반
- 브라우저에서 개발 및 테스트 가능
- Electron 기반 데스크톱 패키징
- Electron Builder 기반 설치 파일 생성
- Windows 11 우선 지원
- 추후 macOS, Linux 확장 고려

Frontend와 Backend를 Electron에 직접 종속시키지 않는다.

Electron은 다음 기능을 담당한다.

- 애플리케이션 실행
- Local Backend Lifecycle
- 시스템 트레이
- OS Notification
- 자동 시작
- 파일 선택 및 안전한 OS 연동
- 자동 업데이트
- 설치 및 제거

### Local-first

개인의 업무 데이터와 지식은 기본적으로 사용자 PC에 저장한다.

- 별도 DB 서버 설치 불필요
- Docker 설치 불필요
- Python, Node.js 별도 설치 불필요
- 필요한 런타임은 설치 파일에 포함
- Embedded Storage 사용
- 인터넷 연결 없이도 기존 지식 탐색 가능
- PC 종료 및 절전 이후 작업 재개
- 로컬 데이터 백업 및 복구

LLM 추론을 위해 외부 Provider를 사용할 수 있지만, 원본 데이터 전체를 외부에 저장하거나 동기화하지 않는 것을 기본 정책으로 한다.

### Simplicity First

Modular Monolith를 기본으로 한다.

불필요한 Microservice, 분산 처리, Multi-Agent 구조, 외부 인프라를 도입하지 않는다.

Python 기반 오픈소스를 재사용하는 것이 Node.js에서 동일 기능을 직접 개발하는 것보다 효율적이라면 Python Sidecar를 허용한다.

단, 최종 설치 파일에 필요한 런타임과 의존성이 포함되어야 한다.

## 3. 아키텍처

다음 구조를 초기 설계로 사용하되 오픈소스 검증 결과에 따라 단순화하거나 변경할 수 있다.

```text
Personal Knowledge Intelligence
├── apps/
│   ├── web/
│   │   └── React + TypeScript + Vite
│   └── desktop/
│       └── Electron
│
├── backend/
│   ├── API Server
│   ├── Connector Manager
│   ├── Persistent Job Queue
│   ├── Background Worker
│   └── Scheduler
│
├── knowledge-engine/
│   ├── Ingestion
│   ├── Semantic Discovery
│   ├── Knowledge Extraction
│   ├── Entity Resolution
│   ├── Knowledge Graph
│   ├── Knowledge Wiki
│   ├── Hybrid Retrieval
│   ├── Reflection
│   ├── Insight Discovery
│   └── Feedback Learning
│
├── providers/
│   ├── Claude Code
│   ├── Codex
│   └── Embedding
│
└── storage/
    ├── Source Repository
    ├── Semantic Registry
    ├── Graph / Vector Index
    ├── Knowledge Wiki
    └── Job / Feedback State
```

Backend는 Electron의 Renderer Process와 분리한다.

브라우저 개발 환경에서도 동일한 Backend API를 사용할 수 있어야 한다.

Knowledge Engine의 내부 저장소가 변경되더라도 Frontend와 상위 서비스는 영향을 최소화하도록 한다.

## 4. LLM Provider 자동 연동

사용자 PC에서 이미 설치하고 로그인하여 사용 중인 Claude Code 또는 Codex CLI를 자동 탐색하고 활용한다.

별도의 API Key 입력을 기본 요구사항으로 하지 않는다.

### Provider Interface

```typescript
interface LLMProvider {
  detect(): Promise<ProviderInfo>
  checkAuthentication(): Promise<AuthStatus>
  checkHealth(): Promise<HealthStatus>
  generate(request: LLMRequest): Promise<LLMResponse>
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>
  cancel(requestId: string): Promise<void>
  getCapabilities(): ProviderCapabilities
}
```

Provider 구현:

- ClaudeCodeProvider
- CodexProvider
- OptionalOpenAICompatibleProvider
- OptionalLocalModelProvider

### 자동 탐색 및 인증

최초 실행 시 다음을 확인한다.

- CLI 설치 여부
- 실행 파일 위치
- CLI 버전
- 기존 인증 상태
- 비대화형 실행 가능 여부
- Structured Output 지원 여부
- 실행 권한 및 보안 기능

Claude Code와 Codex가 모두 존재하면 사용자가 기본 Provider를 선택할 수 있도록 한다.

CLI가 설치되지 않았거나 인증되지 않은 환경에서도 애플리케이션은 실행되어야 한다.

이 경우 설치 및 로그인 안내를 제공하고 기존 지식 검색 등 LLM이 필요하지 않은 기능은 계속 사용할 수 있어야 한다.

### CLI 실행

공식 비대화형 CLI 인터페이스를 사용한다.

예시:

```bash
claude -p --output-format json

codex exec --json --sandbox read-only -
```

실제 명령과 지원 옵션은 설치된 버전의 공식 문서 및 도움말을 검증하여 적용한다.

필수 구현:

- 기존 사용자 인증 활용
- 비공식 인증 우회 금지
- 안전한 subprocess 실행
- JSON Schema 기반 응답 검증
- Timeout
- Cancellation
- Retry 및 Backoff
- Rate Limit 처리
- 동시 실행 제한
- 실행 횟수 및 작업 예산 관리
- Provider 오류 복구
- 호출 이력 및 상태 표시

CLI는 격리된 작업 디렉터리에서 실행한다.

메일이나 Wiki에 포함된 명령을 실행하지 못하도록 Tool, Shell, 파일 접근, MCP 등의 사용 권한을 제한한다.

적절한 권한 제한을 보장할 수 없는 Provider의 백그라운드 자동 실행은 차단한다.

### Embedding

Embedding은 생성형 LLM과 별도로 구성한다.

기본값은 로컬 CPU에서 실행 가능한 다국어 Embedding 모델이다.

한국어, 영어, 한영 혼용 업무 정보를 대상으로 검색 품질을 검증한다.

FastEmbed, Transformers.js 등의 기존 오픈소스를 우선 활용한다.

Embedding 모델 교체와 버전 변경에 따른 재인덱싱도 지원한다.

## 5. Information Ingestion

실제 사내 시스템의 데이터 수집 로직은 별도로 구현할 수 있도록 Connector SDK와 공통 인터페이스를 제공한다.

```typescript
interface Connector {
  initialize(): Promise<void>
  sync(): Promise<SyncResult>
  getChanges(cursor: string): Promise<ChangeSet>
  getDocument(id: string): Promise<SourceRecord>
  healthCheck(): Promise<HealthStatus>
}
```

공통 SourceRecord:

```yaml
id:
source_type:
external_id:
title:
content:
author:
participants:
thread_id:
source_url:
created_at:
updated_at:
content_hash:
version:
access_scope:
metadata:
```

지원할 정보 유형:

- 이메일
- 메신저 메시지 및 스레드
- Wiki 페이지
- 댓글 및 회의록
- PDF
- Markdown
- TXT
- HTML
- DOCX
- XLSX
- CSV
- JSON

초기 구현에서는 다음 방법으로 데이터를 수집한다.

- 로컬 폴더 감시
- 파일 및 폴더 Import
- JSONL Import
- Local Ingestion API
- 테스트 Connector

실제 사내 시스템 Connector 구현을 초기 개발의 전제조건으로 삼지 않는다.

필수 처리 기능:

- Incremental Sync
- Change Detection
- Idempotency
- Content Hash 기반 중복 제거
- 문서 버전 관리
- 메시지 및 대화 스레드 복원
- 수정 및 삭제 감지
- 원본 근거 유지
- 접근 권한 유지
- 실패 작업 재처리

## 6. Self-evolving Local Semantic Layer

개인별 Semantic Knowledge를 제품의 핵심 자산으로 정의한다.

Semantic Layer는 단순한 Vector Index나 정적인 업무 용어 사전이 아니다.

새로운 정보가 들어올 때마다 업무 개념과 정의, 관계를 발견하고 기존 지식에 반영하며, 지속적으로 발전해야 한다.

### 6.1 Vocabulary

- 업무 용어
- 동의어
- 약어
- 사내 고유 명칭
- 한영 표기 차이
- 문맥에 따른 의미 차이
- 사용자별 용어 사용 패턴

예를 들어 동일한 명칭이 서로 다른 업무 문맥에서 등장하면 무조건 같은 개념으로 통합하지 않는다.

### 6.2 Concept

- 개념 이름
- 업무상 정의
- 관련 용어
- 상위 및 하위 개념
- 연관 업무
- 관련 Entity
- 정의에 대한 근거
- 변경 이력

### 6.3 Ontology

- Entity Type
- Relationship Type
- Attribute
- 관계 방향
- 관계 제약조건
- 도메인별 의미 구조

초기에는 최소한의 공통 Ontology를 제공하고, 사용자 데이터에서 새로운 업무 개념과 관계 유형을 발견하여 확장한다.

LLM에 의한 Ontology 변경은 후보 생성, 중복 검사, 유효성 검증 과정을 거쳐야 한다.

### 6.4 Domain Knowledge

- 업무 규칙
- 업무 프로세스
- 조직 및 역할
- 프로젝트
- 시스템 및 서비스
- 의사결정 기준
- 업무 관행
- 제약조건
- 예외사항

### 6.5 Analytical Semantic

업무 문서나 정형 데이터에서 분석에 활용할 수 있는 의미 정의가 발견되면 다음 항목을 관리한다.

- Dataset
- Entity
- Grain
- Fact
- Dimension
- Measure
- Metric
- Aggregation Rule
- Join Relationship
- Time Dimension
- Business Rule
- Dataset Mapping

예를 들어 메일에서 특정 KPI의 계산 기준이 발견되면 해당 기준을 Business Metric 후보로 등록하고 관련 문서 및 데이터셋과 연결한다.

실제 데이터 스키마와 검증 근거가 없다면 Metric, Grain, Join 관계를 확정하지 않는다.

별도의 데이터 분석 플랫폼이나 SQL 생성 엔진을 초기 필수 기능으로 구축하지 않는다.

Analytical Semantic은 Knowledge Semantic의 확장 영역으로 관리한다.

### 6.6 Semantic Discovery Pipeline

```text
New Information
  → Vocabulary Discovery
  → Concept Extraction
  → Entity Extraction
  → Search Existing Knowledge
  → Entity Resolution
  → Relationship Extraction
  → Semantic Candidate Generation
  → Validation
  → Semantic Registry Update
```

Embedding 유사도만으로 동일 개념이나 동일 인물을 결정하지 않는다.

이름, 조직, 프로젝트, 문맥, 시간, 식별자, 근거를 종합하여 판단한다.

### 6.7 Semantic Lifecycle

```yaml
id:
type:
name:
definition:
aliases:
attributes:
confidence:
status:
evidence_refs:
created_at:
updated_at:
valid_from:
valid_until:
version:
```

지원 상태:

- candidate
- verified
- disputed
- superseded
- rejected

다음을 반드시 구분한다.

- 원본에서 명시적으로 확인된 사실
- 사용자가 직접 승인한 정의
- 여러 근거를 종합한 추론
- 아직 검증되지 않은 가설

사용자가 교정하거나 승인한 Semantic을 LLM이 근거 없이 덮어쓰지 못하도록 한다.

모든 변경에 근거 및 변경 이력을 유지한다.

## 7. Knowledge Graph

기존 Knowledge Graph 및 Memory Engine을 최대한 재사용한다.

Cognee, Graphiti, LightRAG 등의 관계 추출 및 그래프 관리 기능을 비교한 후 선택한다.

초기 Knowledge Type:

- Person
- Organization
- Project
- System
- Concept
- Document
- Fact
- Decision
- Task
- Commitment
- Event
- Issue
- Dependency
- BusinessRule
- OpenQuestion
- Insight

대표 관계:

- BELONGS_TO
- RESPONSIBLE_FOR
- DEPENDS_ON
- RELATED_TO
- MENTIONS
- DECIDED
- CAUSED_BY
- SUPERSEDES
- CONTRADICTS
- SUPPORTS
- DERIVED_FROM

필수 기능:

- 신규 Entity 생성
- 기존 Entity 연결
- Entity Resolution
- 중복 Entity 통합
- 관계 추출 및 증분 갱신
- Multi-hop 관계 탐색
- 사실의 시간 및 유효 기간 관리
- 관계별 근거 추적
- 기존 사실의 변경 및 대체
- 상충되는 정보 관리
- 원본 삭제 시 파생 지식 갱신

처음부터 복잡한 Graph Database를 직접 개발하지 않는다.

Embedded Graph Storage 또는 기존 Knowledge Engine의 로컬 저장소를 우선 사용한다.

## 8. LLM Wiki

LLM Wiki 패턴 및 기존 오픈소스 구현체를 활용하여 지식이 지속적으로 축적되는 문서 체계를 구축한다.

새로운 정보가 들어올 때 기존 지식 문서를 찾아 갱신하고, 필요한 경우 신규 페이지를 생성한다.

논리적 문서 구조:

```text
wiki/
├── concepts/
├── projects/
├── people/
├── organizations/
├── systems/
├── topics/
├── decisions/
├── tasks/
├── issues/
├── business-rules/
├── metrics/
├── syntheses/
├── index.md
└── log.md
```

위 구조는 예시이며 기존 오픈소스의 구조가 적합하다면 그대로 사용한다.

필수 기능:

- 신규 정보 Ingest
- 관련 페이지 검색
- 기존 문서 증분 갱신
- 신규 페이지 생성
- Cross-reference
- Backlink
- 근거 링크
- 상충되는 정보 표시
- 페이지 변경 이력
- Knowledge Lint
- 주제별 종합 지식 생성

Knowledge Graph와 Wiki를 독립적인 권위 원본으로 관리하지 않는다.

공통 Knowledge ID 및 Evidence ID를 활용하고, Wiki와 검색 인덱스는 승인된 지식 상태에서 재생성할 수 있도록 한다.

## 9. Continuous Knowledge Processing

신규 데이터 처리와 정기 지식 재분석을 구분한다.

### Event-driven Processing

```text
New Data
  → Normalize
  → Deduplicate
  → Extract Knowledge
  → Retrieve Related Context
  → Resolve Entities
  → Update Semantic
  → Update Graph
  → Update Wiki
  → Detect Changes
  → Discover Insights
```

데이터가 추가될 때마다 기존 정보와의 관계를 탐색한다.

관련된 기존 사실, 업무 개념, 프로젝트, 사람, 결정사항 등을 함께 분석한다.

단순히 신규 정보를 요약하고 저장하는 것으로 작업을 완료하지 않는다.

### Reflection

일정 주기로 기존 지식을 다시 분석한다.

- 이전에 발견하지 못한 관계 탐색
- 동의어 및 업무 용어 통합
- Entity Resolution 재검토
- Semantic 정의 보정
- 중복 정보 통합
- 상충되는 사실 발견
- 오래된 지식 및 잘못된 관계 확인
- 주제별 지식 재구성
- 미해결 업무 확인
- 새로운 Insight 생성

LLM의 Reflection, Dreaming, Memory Consolidation 패턴을 조사하고 활용한다.

단순히 전체 데이터를 매번 LLM에 전달하지 않는다.

다음을 활용하여 분석 범위를 제한한다.

- Changed Entity
- Dirty Concept
- Affected Subgraph
- Recently Updated Wiki
- Unresolved Conflict
- Low Confidence Relationship

### 실행 주기

초기 기본값:

- 신규 정보: 증분 처리
- 10분: 신규 데이터 확인
- 1시간: 중요 변화 및 Insight 탐색
- 매일: Knowledge Consolidation
- 매주: Semantic Refinement

실행 주기는 설정 가능해야 한다.

백그라운드 작업을 Persistent Job Queue에 저장하고 앱 재시작 이후 안전하게 재개한다.

동일 작업의 중복 실행을 방지한다.

## 10. Insight Discovery

이 기능은 제품의 핵심 차별화 영역이다.

서로 다른 정보 사이의 관계를 종합하여 개별 원본만으로는 알기 어려운 새로운 의미를 발견한다.

예를 들어:

- 메일: A 프로젝트 완료 목표는 12월 5일
- Wiki: A 프로젝트는 B 시스템의 API에 의존
- 메신저: B 시스템의 API 개발은 12월 10일로 연기

기대 결과:

A 프로젝트의 목표 일정에 영향을 줄 수 있는 의존 업무의 지연 가능성을 사용자에게 알려준다.

이 결과는 확정된 사실이 아니라 여러 근거에 기반한 추론임을 명확하게 표시한다.

### Insight Type

- 중요 업무 변경
- 일정 충돌
- 의존 업무 지연
- 의사결정 변경
- 상충되는 정보
- 미처리 업무 요청
- 미해결 업무 이슈
- 유사한 문제의 해결 사례
- 관련 업무 및 기술 문서 발견
- 새로운 업무 기회
- 업무 정의 및 정책 변화
- 새롭게 발견된 중요한 정보 관계
- 사용자가 놓쳤을 가능성이 있는 정보

### Insight Schema

```yaml
id:
type:
title:
summary:
reasoning_summary:
affected_entities:
evidence_refs:
confidence:
importance:
novelty:
actionability:
suggested_actions:
status:
created_at:
updated_at:
```

### Insight Ranking

다음 기준으로 중요도를 평가한다.

- 사용자 업무 관련성
- 영향도
- 시간 민감도
- 정보의 신규성
- 신뢰도
- 실행 가능한 조치 여부
- 과거 사용자 피드백

LLM에 모든 판단을 위임하지 않는다.

날짜 비교, 상태 변경, 의존성 충돌, 중복 검사 등 결정론적으로 처리 가능한 기능은 코드로 구현한다.

중복 Insight는 통합하고 새 근거가 들어오면 기존 Insight를 갱신한다.

불필요한 반복 알림을 방지한다.

## 11. Proactive Feedback

사용자가 질문하지 않아도 중요한 정보를 제공한다.

제공 방식:

- Desktop Notification
- System Tray 알림
- Insight Feed
- Daily Digest
- Weekly Knowledge Report
- 중요 업무 변화 Timeline

모든 정보에 알림을 발생시키지 않는다.

중요도가 높은 정보만 즉시 알리고 나머지는 Digest에 포함한다.

알림에는 다음 정보가 포함되어야 한다.

- 무엇이 발견되었는가
- 왜 중요한가
- 어떤 정보들을 연결했는가
- 관련 원본은 무엇인가
- 확정 사실인가, 추론인가
- 사용자가 취할 수 있는 행동은 무엇인가

외부 메시지 전송, 이메일 발송, 업무 시스템 변경 등의 행동은 사용자 명시적 승인 없이 수행하지 않는다.

## 12. Feedback Learning

사용자로부터 다음 피드백을 받을 수 있어야 한다.

- 유용함
- 관련 없음
- 잘못된 정보
- 잘못된 관계
- 이미 알고 있음
- 중요함
- 확인 완료
- 다시 알리지 않기

피드백은 다음 처리에 반영한다.

- Insight Ranking
- 개인별 업무 관련성
- 관심 주제
- Entity Resolution
- Semantic 정의
- Knowledge Graph 관계
- 검색 결과 Ranking

정확성 교정과 개인 선호를 구분한다.

사용자가 관련 없다고 평가했다고 해서 사실 자체를 삭제하지 않는다.

초기에는 Fine-tuning이나 강화학습을 구현하지 않는다.

Feedback Log, Ranking Weight, Personal Preference, Prompt Context를 통한 개인화를 우선 적용한다.

## 13. Hybrid Retrieval 및 Knowledge Q&A

사용자가 자연어로 질문하면 축적된 개인 지식을 활용해 답변한다.

검색 방식:

- Keyword Search
- Vector Search
- Metadata Filtering
- Semantic Concept Search
- Graph Traversal
- Temporal Search
- Wiki Retrieval
- Reranking

질문 유형에 따라 필요한 검색 방식만 선택한다.

예시:

- 최근 받은 특정 메일 검색: Keyword Search
- 비슷한 문제 해결 사례: Vector Search
- 특정 프로젝트의 업무 의존성: Graph Search
- 지난달부터 변경된 의사결정: Temporal Search
- 특정 업무의 전체적인 맥락: Wiki Retrieval
- 업무 용어에 대한 질문: Semantic Registry

답변 시 원본 출처와 근거를 제공한다.

검색 시스템에 저장된 요약을 무조건 사실로 간주하지 않는다.

정보가 부족하거나 충돌한다면 이를 명시한다.

## 14. Web UI 및 Desktop UX

일반 업무 사용자가 개발 지식 없이 사용할 수 있는 현대적인 생산성 애플리케이션을 구축한다.

React, TypeScript, Vite와 검증된 UI Component Library를 활용한다.

### Home

기본 시작 화면.

- 오늘의 중요 Insight
- 주요 업무 변화
- 미해결 업무
- 일정 및 의존성 위험
- 새롭게 연결된 정보
- Daily Digest

### Knowledge

개인별 LLM Wiki.

- 업무 주제
- 프로젝트
- 사람 및 조직
- 시스템 및 기술
- 업무 규칙
- 의사결정
- 관련 문서
- 변경 이력
- Backlink

Obsidian과 같은 연결형 지식 탐색 경험을 참고한다.

### Explore

- Knowledge Graph 시각화
- Entity 선택 및 관계 확장
- 관계 유형별 필터
- Timeline
- 근거 문서 탐색
- 새롭게 형성된 관계
- 의심되는 관계 및 충돌

전체 Graph를 무조건 표시하지 않는다.

사용자가 관심 있는 특정 업무나 Entity를 중심으로 관련 Subgraph를 탐색하도록 한다.

### Semantic

자동으로 축적되는 업무 의미 체계를 관리한다.

- Vocabulary
- Concept
- Ontology
- Business Rule
- Entity Type
- Relationship Type
- Dataset 및 Metric
- 검토 대기 중인 후보
- 상충되는 정의
- 변경 이력

사용자가 직접 수정하거나 승인할 수 있도록 한다.

### Ask

- 자연어 질의응답
- 스트리밍 답변
- 원본 출처
- 관련 지식 링크
- 근거 확인
- 시간 및 변경 이력 기반 질의

### Sources

- Connector 관리
- 수집 대상 설정
- 동기화 상태
- 신규 및 변경 정보
- 처리 실패
- 원본 탐색
- 데이터 삭제

### Activity

- 현재 백그라운드 작업
- Knowledge Extraction 상태
- Semantic 변경사항
- Reflection 실행 이력
- LLM Provider 상태
- 처리 시간 및 오류

### Settings

- Claude Code / Codex 선택
- 작업 실행 주기
- LLM 호출 예산
- 자동 실행
- 시스템 알림
- 관심 업무
- 보안 및 외부 전송 설정
- 저장 공간
- 백업 및 복구

UI 개발 시 하드코딩된 Mock 화면을 최종 구현으로 간주하지 않는다.

실제 Backend 데이터와 연결하고 주요 사용자 시나리오에 대해 Playwright 등으로 End-to-End 테스트를 수행한다.

## 15. Local Backend 및 Storage

Backend는 Node.js + TypeScript 기반 Local API Server를 우선 검토한다.

기존 Python 기반 Knowledge Engine을 재사용해야 한다면 Sidecar 형태로 통합한다.

저장소 후보:

- SQLite: 원본 메타데이터, Semantic, Job, Feedback
- LanceDB 또는 sqlite-vec: Vector Index
- Embedded Graph Storage: Entity 및 Relationship
- Markdown: Knowledge Wiki
- Local File Storage: 원본 및 첨부파일

기존 Knowledge Engine이 동일 기능을 제공한다면 중복 저장소를 추가하지 않는다.

저장소별 Single Source of Truth를 명확히 정의한다.

모든 Storage에 대해 다음을 고려한다.

- Transaction
- Schema Migration
- Index Rebuild
- Backup / Restore
- Concurrent Access
- Crash Recovery
- Data Deletion
- Storage Version

## 16. Electron 패키징

웹 애플리케이션을 Electron으로 패키징한다.

개발 환경에서는 일반 웹 개발 서버로 실행 가능해야 한다.

배포 환경에서는 Electron이 필요한 Backend와 Worker를 자동 실행하고 종료하도록 한다.

### 실행 모드

```text
Development
  Browser
    → Local Web Dev Server
    → Local Backend

Production
  Electron
    → Packaged Web UI
    → Local Backend
    → Background Knowledge Worker
```

### Desktop 기능

- Windows 설치 파일
- 시스템 트레이
- 백그라운드 실행
- 시작 프로그램 등록
- OS Notification
- Single Instance Lock
- Graceful Shutdown
- Crash Recovery
- Automatic Update
- 사용자 데이터 디렉터리 관리
- 버전별 마이그레이션

설치 파일 생성은 개발 초기부터 검증한다.

개발 환경에서만 실행되는 상태로 마지막까지 진행하지 않는다.

### Electron Security

- contextIsolation 활성화
- nodeIntegration 비활성화
- Renderer Sandbox 활성화
- 제한된 Preload API
- IPC 입력 검증
- Content Security Policy
- 외부 URL Navigation 제한
- Renderer의 임의 Shell 실행 금지
- 임의 파일 시스템 접근 금지
- Local Backend의 외부 네트워크 노출 금지
- Local API 인증
- Origin 및 요청 검증

메일 및 Wiki의 HTML과 Markdown은 신뢰하지 않는 데이터로 처리한다.

## 17. 보안 및 데이터 관리

개인 메일, 메신저, 업무 문서가 포함되므로 다음 기능을 초기부터 고려한다.

- 사용자 명시적 데이터 수집 범위 설정
- OS 사용자별 데이터 격리
- 로컬 데이터 암호화
- OS Credential Store 활용
- 접근 권한 및 원본 출처 추적
- 원본 삭제와 파생 지식 삭제 동기화
- 로그 내 민감 정보 제거
- Prompt Injection 방어
- 외부 Provider 전송 범위 제어

Claude Code와 Codex가 로컬에서 실행되더라도 실제 추론 요청은 외부 서버로 전송될 수 있다.

외부 LLM으로 전송되는 데이터를 사용자에게 명확히 안내한다.

승인되지 않은 업무 데이터는 외부 Provider로 전송하지 않는다.

데이터 원본의 권한을 벗어난 지식 연결이나 Insight 생성이 발생하지 않도록 한다.

## 18. 테스트 및 평가

단순 기능 구현 여부뿐 아니라 실제 Knowledge 품질을 측정한다.

### Knowledge Evaluation

- Entity Extraction Accuracy
- Entity Resolution Accuracy
- Relationship Precision / Recall
- Semantic Definition Accuracy
- Temporal Fact Accuracy
- Source Attribution
- Contradiction Detection
- Knowledge Consolidation Quality
- Knowledge Lint Accuracy

### Insight Evaluation

- Relevance
- Novelty
- Faithfulness
- Actionability
- Importance Ranking
- False Positive Rate
- Duplicate Notification Rate

### Retrieval Evaluation

- Recall@K
- Precision@K
- MRR
- Answer Groundedness
- Citation Accuracy

다음 구성을 비교하여 Semantic 및 Graph의 실제 효과를 검증한다.

1. Keyword Search
2. Keyword + Vector
3. Keyword + Vector + Graph
4. Keyword + Vector + Graph + Semantic
5. Knowledge Wiki를 포함한 종합 검색

복잡한 기능이 실제 품질 개선으로 이어지지 않는다면 제거하거나 단순화한다.

### System Evaluation

- 설치 파일 크기
- 유휴 CPU 및 메모리
- 신규 문서 처리 시간
- 검색 응답 시간
- LLM 호출 횟수
- 저장 공간 증가율
- 백그라운드 작업 안정성
- 중단 이후 복구
- 장시간 실행 안정성

한국어 및 한영 혼용 업무 환경을 반영한 합성 Golden Dataset을 구축한다.

## 19. 개발 단계

### Phase 0. Open Source Research & PoC

- 기존 오픈소스 애플리케이션 및 엔진 비교
- 기능별 재사용 가능성 조사
- 라이선스 및 배포 제약 검토
- Knowledge Engine 실제 실행
- Claude Code / Codex CLI 연동 검증
- Embedded Storage 검증
- 한국어 Embedding 검증
- Electron 최소 설치 파일 생성

산출물:

- OSS_EVALUATION.md
- ARCHITECTURE.md
- ADR
- 실제 실행 가능한 PoC
- 재사용 기능 및 직접 개발 기능 목록

문서 조사만으로 핵심 기술을 선정하지 않는다.

실제 CLI 연동, 증분 지식 처리, 로컬 저장, Electron 패키징까지 검증한다.

### Phase 1. Vertical Slice

가능한 빠르게 하나의 실제 End-to-End 흐름을 구현한다.

- Web UI 실행
- CLI Provider 연동
- 이메일 형태의 테스트 데이터 Import
- Knowledge Extraction
- 기존 정보와 관계 연결
- Knowledge 저장
- Insight 생성
- UI 표시
- Electron 패키징

전체 기반 시스템을 먼저 구축하느라 핵심 제품 검증이 지연되지 않도록 한다.

### Phase 2. Information Ingestion

- Connector SDK
- 다양한 파일 형식
- 증분 처리
- 변경 및 삭제 감지
- 원본 근거 관리
- Persistent Job Queue

### Phase 3. Semantic Knowledge

- Vocabulary
- Concept
- Ontology
- Domain Knowledge
- Analytical Semantic
- Entity Resolution
- Knowledge Graph
- Temporal Knowledge

### Phase 4. Knowledge Consolidation

- LLM Wiki
- Incremental Wiki Update
- Cross-reference
- Periodic Reflection
- Knowledge Lint
- Semantic Refinement

### Phase 5. Proactive Intelligence

- Change Detection
- Insight Discovery
- Importance Ranking
- Notification
- Daily Digest
- Feedback Learning

### Phase 6. Knowledge Experience

- Knowledge Q&A
- Semantic Explorer
- Knowledge Graph UI
- Timeline
- Evidence Viewer
- 사용자 교정 기능

### Phase 7. Production Readiness

- Windows 설치 파일
- 자동 업데이트
- 백업 및 복구
- 보안 강화
- 데이터 마이그레이션
- 성능 최적화
- 장시간 실행 검증
- End-to-End 품질 평가

## 20. 최종 완료 기준

다음 시나리오가 실제 동작해야 한다.

1. 사용자가 설치 파일을 통해 프로그램을 설치한다.
2. 기존 Claude Code 또는 Codex를 자동 탐색한다.
3. 사용자가 메일, 메신저, Wiki 형태의 데이터를 가져온다.
4. 시스템이 의미 있는 업무 지식을 추출한다.
5. 서로 다른 원본의 정보 사이에 관계를 형성한다.
6. 개인별 Semantic Knowledge를 자동으로 구성한다.
7. 신규 정보가 기존 Knowledge Graph와 Wiki에 반영된다.
8. 정기 Reflection으로 새로운 관계를 발견한다.
9. 여러 출처를 종합한 새로운 Insight를 생성한다.
10. 사용자에게 근거와 함께 중요한 정보를 전달한다.
11. 사용자 피드백에 따라 지식과 중요도를 개선한다.
12. 사용자의 자연어 질문에 근거 기반으로 답변한다.
13. 원본 삭제 시 파생 지식과 검색 인덱스를 갱신한다.
14. PC 재시작 이후 중단된 작업을 안전하게 재개한다.

## 21. 작업 수행 지시

현재 저장소 상태를 먼저 조사한다.

기존 코드가 있다면 재사용 가능한 부분을 최대한 유지한다.

처음부터 전체 기능을 독자적으로 개발하지 않는다. 우선 기존 오픈소스 애플리케이션 또는 Knowledge Engine의 실제 코드를 검토하고, 재사용 가능한 범위를 확인한다.

특히 Open Source Research와 PoC 결과를 바탕으로 핵심 아키텍처를 확정한다.

각 Phase에서 다음을 반복한다.

- 구현
- 실제 실행
- 테스트
- 오류 수정
- End-to-End 검증
- 성능 및 품질 평가
- 문서 갱신

복잡도를 증가시키는 기술을 새로 도입할 때는 필요성과 대안을 ADR에 기록한다.

기존 오픈소스가 제공하는 기능을 불필요하게 재구현하지 않는다.

더 적합하거나 단순한 기술을 발견하면 근거를 기록하고 기존 설계를 수정할 수 있다.

Mock, 하드코딩, 문서 작성만으로 실제 기능이 완료되었다고 판단하지 않는다.

최종 목표는 단순히 많은 기능을 가진 애플리케이션이 아니라, 사용자가 별도의 관리 없이 사용하면서 개인 지식이 지속적으로 축적되고 발전하며, 유의미한 업무 인사이트를 능동적으로 제공받는 실행 가능한 제품이다.
