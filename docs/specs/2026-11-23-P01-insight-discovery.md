# 스펙: P01 — Insight 발견·변경 감지·설명 가능한 Ranking

- 날짜: 2026-11-23 / 상태: 확정(잠정 결정 D1~D19 포함)
- 관련: 이슈 #27(P01), 총괄 #1, Phase 5 #7, 선행 #23(S02)·#20, 후속 #28(P02 알림)·#29(P03 피드백)·#30(X01 검색). [V02 spec](2026-11-21-V02-vertical-slice.md)(R9·R10: 첫 규칙 "의존 업무 지연"), [S02 spec](2026-11-22-S02-entity-resolution-temporal-graph.md)(R13 묶음, R18·R19 주장 연결), [I04 spec](2026-11-21-I04-invalidation.md)(종류 `insight`), [ARCHITECTURE.md](../ARCHITECTURE.md) 4절·5.6절
- 번호: 요구사항 `P01-R<n>`, 결정 `P01-D<n>`, 작업 `P01-T<nn>`. 완료 기준 `P01-C1`~`C3`은 이슈 #27의 번호 그대로이고 그 아래를 `a`·`b`·`c`로 나눈다. 마이그레이션 번호는 **합쳐지는 때 main의 다음 번호**를 쓴다(K01이 v27을 써서 main에 먼저 들어왔고, P01은 rebase로 v28이 됐다).

| 말 | 뜻 |
|---|---|
| 유형 | Insight의 종류 이름. 저장된 `insights.rule` 값이다(`dependency_delay` 등) |
| 사실 줄 | Insight가 쓴 정본 행(사실·관계)의 값을 코드가 그대로 옮겨 적은 문장. 해석이 들어 있지 않다 |
| 추론 문장 | 그 사실들에서 끌어낸 결론 한 문장(기존 `summary`). 화면은 "추론"으로 표시한다 |
| 이유 요약 | 어떤 비교로 그 결론에 이르렀는지 사용자에게 보여 주는 짧은 글(`reasoning_summary`). 모델의 사고 과정이 아니다 |
| 지문(fingerprint) | "같은 Insight"를 정하는 키: (유형, X 묶음의 대표 항목, Y 묶음의 대표 항목) |
| 철회 | 조건이 더는 서지 않아 Insight를 `resolved`로 돌리는 것. 행은 남고 글과 근거 연결은 비운다 |

## 배경

V02가 규칙 하나("의존 업무 지연")와 Insight 행(`insights`, 키 `(rule, x, y)`, 근거·사용자 입력·주장 연결)을 만들었고, S02가 묶음과 주장 연결(`SUPERSEDES`·`CONTRADICTS`)을 더했다. 규칙이 하나뿐이라 실행 자리 네 곳(추출, 원본 변경 전파, 사용자 조치, 묶음 변경)이 그 규칙 함수를 직접 부르고, Insight에는 유형별 지원 상태도 순위도 없다. P01은 이것을 **여러 유형이 같은 틀로 도는 구조**로 일반화한다. 새 엔진이나 새 테이블은 만들지 않는다.

## 목표

1. 요청된 13개 유형마다 지원 상태가 코드와 fixture로 명시된다. 지원하지 않는 유형은 사유와 함께 "미지원"으로 보고된다.
2. Insight 하나가 사실 줄·추론 문장·이유 요약·근거·신뢰도를 갖고, 여섯 축 순위가 같은 입력에서 같은 값으로 계산되어 설명된다.
3. 날짜·상태·의존·중복은 코드가 판정하고 LLM은 해석만 한다. 같은 지문은 한 행으로 합쳐지고, 새 근거에 갱신·철회된다. 신뢰도가 낮은 Insight에는 자동 알림 제외 표시가 붙는다.

## 비목표

- **알림 발송과 억제.** 제외 표시까지만 한다. 실제 억제는 P02(#28).
- **개인화(사용자 관심·피드백으로 순위 조정), "놓친 정보".** P03(#29)의 기록이 있어야 한다.
- **유사도·검색에 기대는 유형("유사 해결", "관련 문서").** X01(#30) 뒤. 여기서는 미지원으로 보고한다.
- **새 그래프·순위 엔진, 그래프 순위 알고리즘.** 순위는 저장된 값 몇 개의 가중합이다.
- **모델 내부 사고 과정의 저장.** 어떤 경로로도 저장하지 않는다.
- **실제 Provider·배포처 데이터로의 확인.** 합성 fixture와 test double만 쓴다.

## 요구사항

### 유형과 지원 상태

- **P01-R1 유형 표.** 13개 유형은 코드 상수 하나(`INSIGHT_TYPES`, `@pki/contracts`)에 있다. 줄마다 유형 이름, 한글 이름, 판정 주체(`code`·`llm`), 상태(`supported`·`unsupported`), 미지원 사유, 영향·행동성 기본값을 갖는다. 미지원 유형의 Insight는 만들어지지 않는다. 아래 표가 목표이고, 상수의 상태는 **구현된 만큼만** `supported`다.

| 유형 | 이름 | 판정 | 조건(코드) | 지원 |
|---|---|---|---|---|
| 의존 업무 지연 | `dependency_delay` | 코드 | X가 Y에 의존, Y의 완료일 > X의 목표일 | 지원(V02, T01이 새 틀로 옮김) |
| 일정 충돌 | `schedule_conflict` | 코드 | 한 묶음의 완료일 > 자기 목표일 | 지원(T02) |
| 충돌 | `conflict` | 코드 | 한 묶음의 유효한 두 사실 사이 `CONTRADICTS` 연결(한 끝이 대체된 사실이면 세지 않음: [Phase 5 후속 spec](2026-11-24-P5-followups.md) R1) | 지원(T02) |
| 중요 변경 | `important_change` | 코드(변경 감지) | 날짜 종류 사실의 `SUPERSEDES` 연결(대신한 쪽이 유효) | 지원(T02, 날짜 종류만) |
| 의사결정 변경 | `decision_change` | 코드(변경 감지) | Decision 묶음의 `conclusion` 사실 사이 `SUPERSEDES` 연결(대신한 쪽이 유효) | 지원(T05) |
| 정책 변화 | `policy_change` | 코드(변경 감지) | BusinessRule 묶음의 `conclusion` 사실 사이 같은 연결 | 지원(T05) |
| 미처리 요청 | `pending_request` | 코드 | Request 묶음의 유효한 `status`가 하나 이상이고 모두 열린 값(`open`·`in_progress`) | 지원(T05) |
| 미해결 이슈 | `open_issue` | 코드 | Issue 묶음의 유효한 `status`가 하나 이상이고 모두 열린 값 | 지원(T05) |
| 새 관계 | `new_relation` | 코드 | 이미 있던 두 항목 사이에 뒤늦게 관측된, 아직 `candidate`인 유효한 관계 | 지원(T05) |
| 기회 | `opportunity` | LLM 해석 | 해석 작업이 낸 후보를 코드가 근거·중복·상태를 정해 저장 | 지원(T04). 설정 `insight.interpret`이 켜져 있을 때만 생긴다 |
| 유사 해결 | `similar_resolution` | 검색 | — | 미지원: 유사도 검색 없음(X01) |
| 관련 문서 | `related_document` | 검색 | — | 미지원: 검색 없음(X01) |
| 놓친 정보 | `missed_information` | 코드 | — | 미지원: 열람·피드백 기록 없음(P03) |

### Insight의 모양

- **P01-R2 내용.** 활성 Insight는 유형, 추론 문장(`summary`), 사실 줄(`fact_lines`, 한 개 이상), 이유 요약(`reasoning_summary`, 500자 이하), 신뢰도(`confidence`, 0~100), 시급의 기준 날짜(`urgency_date`, 없을 수 있음), 마지막으로 내용이 바뀐 시각(`changed_at`)을 갖는다. 사실 줄은 인용한 행의 값만으로 코드가 쓰고, 추론은 `summary`에만 둔다. 인식 유형은 지금처럼 `inferred` 하나다.
- **P01-R3 근거.** 활성 Insight는 근거(`insight_evidence`)나 사용자 입력(`insight_user_inputs`)을 하나 이상 갖고, 판정에 쓴 주장 연결은 `insight_link_inputs`에 둔다. 계보·범위·삭제 전파는 기존 종류 `insight`가 그대로 맡는다. 철회된 행은 글(추론·사실 줄·이유 요약)과 신뢰도·날짜·근거 연결을 갖지 않는다.
- **P01-R4 순위.** 여섯 축은 각각 0~100의 정수이고, 점수는 고정 가중합이다. `rankInsight(신호, 지금)`은 순수 함수이며 축 값과 점수를 함께 돌려준다(설명 가능). 시급·신규는 "지금"에 달려 있어 **저장하지 않고 읽을 때 계산**한다.

| 축 | 값 | 가중 |
|---|---|---|
| 관련성 | 사용자 입력 행을 썼으면 100, 아니면 50(개인화는 P03) | 0.15 |
| 영향 | 유형 표의 기본값 | 0.25 |
| 시급 | 기준 날짜까지 7일 이하(지난 날짜 포함) 100, 30일 이하 70, 90일 이하 40, 그 밖 20, 날짜 없음 30 | 0.25 |
| 신규 | `changed_at`에서 1일 이하 100, 7일 이하 70, 30일 이하 40, 그 밖·없음 10 | 0.10 |
| 신뢰 | 저장된 `confidence`(없으면 50) | 0.15 |
| 행동성 | 유형 표의 기본값 | 0.10 |

- **P01-R5 사고 과정을 저장하지 않는다.** Insight에 저장되는 글은 코드가 쓰는 `summary`·`fact_lines`·`reasoning_summary`, 해석이 채우는 `llm_*` 열(`llm_reasoning_summary`와 두 점수), `opportunity` 행의 `summary`(모델이 제안한 문장)뿐이다. LLM 해석의 출력 스키마(T04)는 네 키(`reasoningSummary`·`impact`·`actionability`·`opportunity`)만 받고 모든 단계에서 엄격하다: 그 밖의 키가 있거나 이유 요약이 500자를 넘으면 Broker가 응답 전체를 거부한다(`invalid-output`). `reasoning_summary`는 500자를 넘으면 저장하지 않는다. Provider 호출 이력은 지금처럼 본문을 갖지 않는다.

### 판정과 수명

- **P01-R6 규칙 틀.** 유형 하나는 규칙 하나(`InsightRule`: 판정할 키 찾기, 키 하나 판정)다. `recomputeInsights`가 등록된 규칙을 모두 돌리고, 기존 실행 자리 네 곳은 이 함수를 부른다. 규칙은 DB만 읽고 Provider를 부르지 않는다. 읽기는 기존의 깊이 1 질의다.
- **P01-R7 LLM은 해석만 한다(T04).** LLM은 코드가 만든 활성 Insight의 이유 요약·영향·행동성을 채우거나, LLM 판정 유형의 후보를 낸다. 상태(활성·철회), 근거, 날짜 비교, 중복 판정은 바꾸지 못한다. Provider가 없거나 전송이 거부되면 코드가 쓴 내용 그대로 남는다. 해석은 코드가 쓴 열을 덮지 않고 **자기 열 셋**(`llm_reasoning_summary`·`llm_impact`·`llm_actionability`)에 저장하며, 코드가 그 행을 쓸 때마다(만들기·갱신·철회) 비워진다. 설정 `insight.interpret`은 기본 끔이고 정확히 `on`일 때만 켜진다. Provider로 나가는 것은 그 Insight의 계보 원본 version ID, 두 항목의 ID, 그리고 등급을 매기는 후보로서의 그 Insight(`insight:<id>`: 유형·추론 문장·사실 줄)뿐이다.
- **P01-R8 지문으로 통합.** 지문은 (유형, X 대표, Y 대표)이고 기존 유일 키가 지킨다. 항목 하나에 대한 유형은 X = Y다. 같은 항목의 어긋남 여러 쌍, 변경 여러 건은 Insight 한 건의 사실 줄 여러 개가 된다. 묶음이 합쳐지면 대표의 키 한 행으로 모인다(S02-R13과 같다).
- **P01-R9 갱신과 철회.** 다시 판정한 결과가 저장된 것과 다르면 그 행을 고치고(`updated`), 조건이 깨지면 철회하고(`resolved`), 다시 서면 같은 행을 되살린다(`revived`). 같으면 쓰지 않는다. `changed_at`은 만들어지거나 되살아나거나 추론 문장·사실 줄이 바뀔 때만 바뀐다.
- **P01-R10 신뢰도와 알림 제외 표시.** 신뢰도는 판정에 쓴 행들의 값 중 **가장 낮은 것**이다: 사용자 입력·`verified` 100, `disputed` 30, `candidate`는 행의 `confidence`×100(없으면 50). 신뢰도가 50 미만이면 `autoNotifyExcluded`가 참이다(함수 하나가 판정, P02가 읽는다).
- **P01-R11 새 종류(T05).** 유형 목록(`KNOWLEDGE_SCHEMA`)을 3판으로 올린다.
  - 항목 유형 `Request`(요청). `target_date`·`statement`와, 모든 항목 유형을 받는 `identifier.key`·`RELATED_TO`가 `Request`로 넓어진다.
  - 사실 종류 `status`: 값 유형 `work-status`(닫힌 네 값 `open`·`in_progress`·`done`·`cancelled`, 대소문자는 소문자로 저장), 값 하나, 대상 Task·Commitment·Issue·Request.
  - 사실 종류 `conclusion`(결정·규칙의 현재 내용): `text`, 값 하나, 대상 Decision·BusinessRule. 값은 인용문 안에 그대로 있는 글이고 500자 이하다(아니면 그 항목만 버린다).
  - 추출 스키마는 6판이 된다: `items.type`에 `Request`, `facts.kind`에 `status`·`conclusion`(둘 다 `validFrom`·`validUntil`을 가질 수 있다). 한 번의 추출이 쓰는 행은 모두 같은 `observed_at`을 갖는다(R12의 `new_relation`이 같은 문서에서 항목과 함께 들어온 관계를 거르는 데 쓴다).
  - 두 종류는 값이 하나라서 S02의 기존 판정이 `SUPERSEDES`·`CONTRADICTS` 연결을 만든다. 연결을 만드는 새 코드는 없다. 마이그레이션 v30이 seed 행을 쓰고 규칙을 넓힌다(v25의 방식).
- **P01-R12 남은 코드 유형(T05).** 조건은 유형 표와 같고, 다섯 규칙 모두 현재 시각을 읽지 않는다.
  - `decision_change`·`policy_change`: `important_change`의 판정을 종류(`conclusion`)와 항목 유형만 바꿔 쓴다(공통 함수 하나). 시급 날짜는 대신한 사실의 `valid_at`이다(없으면 없음).
  - `pending_request`·`open_issue`: 유효한 `status` 중 닫힌 값(`done`·`cancelled`)이 하나라도 있으면 서지 않는다(두 값의 어긋남은 `conflict`가 맡는다). `pending_request`의 시급 날짜는 가장 이른 유효한 `target_date`(사실 줄과 근거로 인용)이고 `open_issue`는 없다.
  - `new_relation`: 키는 (주어 묶음 대표, 목적어 묶음 대표). 관계 유형은 `DEPENDS_ON`·`RESPONSIBLE_FOR`·`BELONGS_TO`·`DECIDED`·`CAUSED_BY`. 관계의 `observed_at`이 양 끝 항목 행의 `observed_at`보다 늦고 상태가 `candidate`일 때 선다. 사용자가 그 관계를 승인하거나 거부하면 철회된다. 한 쌍의 관계 여러 개는 사실 줄 여러 개다.

### API와 화면 (T03)

- **P01-R13 Insight 응답.** `GET /api/insights`와 `POST /api/insights/evidence`의 Insight는 기존 필드에 더해 유형(`type`), 사실 줄(`factLines`), 이유 요약(`reasoningSummary`: 해석이 있으면 해석의 글, 없으면 코드의 글, D12)과 그 글을 쓴 쪽(`reasoningBy`: `code`·`llm`), 신뢰도(`confidence`), 순위(`ranking`: 여섯 축과 점수), 알림 제외 표시(`autoNotifyExcluded`)를 갖는다. 순위는 응답을 만들 때 `rankInsight`로 계산하고(R4) 해석의 두 숫자가 있으면 그것을 쓴다.
- **P01-R14 목록 순서.** 목록은 활성 Insight만, 점수가 높은 순서로 준다. 철회된 Insight는 목록에도 근거 조회에도 없다.
- **P01-R15 읽기 문.** Insight는 **자기 계보와 양 끝 항목(X·Y)이 모두 보일 때만** 응답에 들어간다. 그래프 추적(`graphTrace`)의 Insight 시작도 같다([Phase 5 후속 spec](2026-11-24-P5-followups.md) R2). 하나라도 숨겨졌으면 행 전체가 빠진다: 추론·사실 줄·이유 요약·개수 어느 것도 나가지 않고, 근거 조회는 없는 Insight와 같은 `not-found`다. 사실 줄과 추론 문장이 항목 이름을 담기 때문이다(D26과 같은 이유).
- **P01-R16 유형 보고와 Home.** `GET /api/insights/types`는 13개 유형 모두의 이름·한글 이름·판정 주체·지원 상태·미지원 사유를 준다. Home은 Insight마다 유형 이름, 추론, 사실 줄, 이유 요약, 순위(점수와 여섯 축), 알림 제외 표시를 보이고, 유형별 지원 상태를 접힌 목록으로 보인다. 가져온 자료에서 온 글은 지금처럼 텍스트 노드와 `<bdi>`로만 나간다.
- **P01-R17 해석 스위치.** `/api/settings/semantic`의 읽기·쓰기에 `insightInterpret`을 더한다(기본 꺼짐, 요청에서 빠지면 그대로). 쓰기는 `setInsightInterpret`을 부르고 작업 실행기를 깨운다. 설정 화면에 체크박스 하나를 둔다.

## 인터페이스 / 설계 개요

Insight 한 행의 수명은 V02의 것 그대로이고, 모든 유형이 같은 길을 지난다.

```mermaid
stateDiagram-v2
  [*] --> active: 조건 성립(created)
  active --> active: 근거·내용 달라짐(updated)
  active --> resolved: 조건 깨짐·범위 거부(철회)
  resolved --> active: 조건 다시 성립(revived)
  active --> [*]: X 또는 Y 항목 삭제
  resolved --> [*]: X 또는 Y 항목 삭제
```

- **스키마.** `insights`에 열 다섯을 더한다(`ADD COLUMN`, 모두 NULL 허용, 기존 행은 고치지 않는다): `fact_lines`(JSON 배열), `reasoning_summary`(길이 500 이하 CHECK), `confidence`(0~100 CHECK), `urgency_date`, `changed_at`. 기존 행은 다음 판정 때 채워진다. T04가 해석 열 셋을 더 더한다(`llm_reasoning_summary` 500자 이하, `llm_impact`·`llm_actionability` 0~100, 마이그레이션 번호는 합쳐지는 때 main의 다음 번호이고 이 구현은 v29).
- **함수.** `recomputeInsights(db, itemIds, { scope?, at?, rules? })`(`knowledge-engine/src/insight-rules.ts`)가 묶음으로 넓히고, 규칙마다 키를 모으고(관계·연결에서 찾은 것 + 저장된 키), 판정하고, 범위 정책(`combinable`)과 신뢰도를 계산하고, 달라진 것만 쓴다. `rankInsight`(`insight-ranking.ts`)는 저장된 신호와 시각만 받는다.
- **실행 자리.** 추출의 `rule` 항목, 종류 `insight`의 `invalidate`, 서버의 `judgeAgain`, 묶음 변경 수신자. 넷 다 주장 연결을 다시 판정한 **뒤에** 돈다(지금의 순서 그대로).

### 대안과 기각 사유

- **유형마다 테이블, 또는 `insights`를 다시 만들어 키를 넓히기**: 기각. 기존 유일 키로 지문을 표현할 수 있고, 테이블을 다시 만들면 딸린 테이블 셋과 K01의 읽기를 건드린다.
- **순위 점수를 저장**: 기각. 시급·신규가 날마다 달라져 저장하면 날마다 다시 써야 한다.
- **알림 제외를 열로 저장**: 기각. 신뢰도에서 한 함수로 정해지므로 두 값이 어긋날 자리를 만들지 않는다(D5).

## 완료 기준 (테스트 가능한 형태)

모든 기준은 저장소 안의 자동 테스트로 판정한다.

- [ ] **P01-C1** — 중요 변경/일정 충돌/의존 업무 지연/의사결정 변경/충돌/미처리 요청/미해결 이슈/유사 해결/관련 문서/기회/정책 변화/새 관계/놓친 정보의 fixture와 지원 상태를 갖춘다.
  - **C1a** (R1, R6): 지원 유형의 fixture를 넣고 판정하면 기대한 Insight 한 건(유형, 사실 줄, 근거 인용문)이 생기고, 조건을 깨는 변형에서는 생기지 않는다.
  - **C1b** (R1): fixture와 유형 표가 같은 13개 유형을 갖고, 미지원 유형은 사유가 있으며 그 유형의 Insight가 만들어지지 않는다.
  - **C1a 추가** (T05, R11, R12): 새 지원 유형 다섯의 fixture를 넣고 판정하면 기대한 Insight 한 건이 생기고 조건을 깨는 변형에서는 생기지 않으며, `fixtures/p01-status.jsonl`을 가져오기(추출 double v6)로 넣으면 `pending_request`·`open_issue`가 한 건씩 생긴다.
  - **C1a 추가** (T04, R1): `opportunity`는 해석 응답이 후보를 내면 부모 Insight의 근거를 그대로 가진 한 건이 생기고, 부모의 사실 줄·근거·사용자 입력·연결이 바뀌면 철회된다(요약·시급 날짜만 바뀌면 유지, D18).
- [ ] **P01-C2** — Insight schema·evidence·reasoning_summary·사실/추론 구분·관련성/영향/시급/신규/신뢰/행동성 ranking을 검증한다. 모델 내부 사고과정을 저장하지 않는다.
  - **C2a** (R2, R3): 규칙이 만든 활성 Insight는 사실 줄·추론 문장·이유 요약·신뢰도와 근거(또는 사용자 입력) 하나 이상을 갖고, 철회하면 글·신뢰도·날짜·근거 연결이 모두 비워진다.
  - **C2b** (R4): `rankInsight`는 여섯 축과 점수를 돌려주고, 같은 입력과 시각에서 같은 값이며, 기준 날짜가 가까운 쪽이 시급이 높고 신뢰도가 낮은 쪽이 점수가 낮다.
  - **C2c** (R5): 500자를 넘는 이유 요약은 저장이 거부되고, (T04) 정해진 키 밖의 키가 있거나 이유 요약이 500자를 넘는 해석 응답은 `invalid-output`이고 아무것도 저장되지 않는다.
- [ ] **P01-C3** — 날짜·상태·dependency·dedup은 코드 판정, 해석은 LLM을 사용한다. fingerprint로 통합하고 새 근거에 갱신·철회하며 low-confidence Insight에는 자동 알림 제외 표시를 남기고 실제 발송 억제는 P02(#28)에서 검증한다.
  - **C3a** (R6, R7): 코드 유형은 Provider 없이 판정되고, (T04) 해석이 저장되면 해석 열 셋만 달라지고 상태·추론 문장·사실 줄·코드 이유 요약·근거·`changed_at`은 그대로이며 다시 판정하면 `unchanged`다. Provider가 없거나 전송이 거부되면 작업은 `held`이고 행은 그대로다.
  - **C3b** (R8): 한 항목에 어긋남이 두 쌍이면 Insight는 한 건이고 사실 줄이 둘이다. 다시 판정하면 같은 행이고 결과는 `unchanged`다.
  - **C3c** (R9): 근거가 되는 행이 바뀌면 같은 행이 `updated`, 조건이 깨지면 `resolved`, 다시 서면 같은 id로 `revived`다.
  - **C3d** (R10): 신뢰도 0.3인 후보 사실을 쓴 Insight는 신뢰도 30이고 `autoNotifyExcluded`가 참이며, 그 사실이 승인되면 거짓이 된다.
- [x] **T03의 기준** (C1·C2·C3의 API·화면 층)
  - **C1c** (R16): `GET /api/insights/types`는 유형 표와 같은 13줄을 주고, 미지원 유형에는 사유가 있다.
  - **C2d** (R13, R14): 활성 Insight 둘을 두면 목록은 점수가 높은 것부터이고, 각 행은 유형·사실 줄·이유 요약·순위·알림 제외 표시를 갖는다. 해석이 저장된 행의 이유 요약은 해석의 글이고 `reasoningBy`는 `llm`이다. 철회된 행은 목록에 없다.
  - **C2e** (R15): 근거의 원본이 숨겨졌거나 끝 항목이 숨겨진 Insight는 목록에 없고 근거 조회는 `undefined`(`not-found`)다. 같은 자리의 보이는 Insight는 그대로 나온다.
  - **C3e** (R17): `insightInterpret`은 처음에 꺼져 있고, 켜면 설정 `insight.interpret`이 `on`이 되며, 요청에서 빠지면 값이 그대로다.
  - **C2f** (R13, R16, R17): 브라우저에서 Home의 Insight가 유형 이름·사실 줄·이유 요약·순위와 함께 보이고, 유형 목록이 미지원 사유를 보이며, 설정에서 해석을 켜면 다시 들어와도 켜져 있다.

### 기준별 증명 테스트

| 기준 | 테스트(파일) | 작업 |
|---|---|---|
| C1a | `knowledge-engine/src/insight-code-rules.test.ts`: fixture의 지원 유형마다 기대 Insight 한 건, 변형에서는 0건 | T02 |
| C1b | `packages/contracts/src/insight-types.test.ts`: 13개 유형과 상태·사유 / 위 fixture 테스트: 유형 표와 fixture의 유형 집합이 같고 미지원 유형 Insight 0건 | T01·T02 |
| C2a | `knowledge-engine/src/insight-rules.test.ts`: 활성 행의 필드 / `storage/src/insights.test.ts`: 철회가 새 열을 비움 | T01 |
| C2b | `knowledge-engine/src/insight-ranking.test.ts`: 축·점수, 날짜와 신뢰도 대표 사례 | T01 |
| C2c | `storage/src/insights.test.ts`: 501자 이유 요약 거부 / (T04) `providers/src/broker.insight-interpret.test.ts`: 다른 키·501자 응답은 `invalid-output` | T01·T04 |
| C3a | C1a의 테스트가 Provider 없이 돈다 / (T04) `knowledge-engine/src/insight-interpret.test.ts`(해석 열 셋만 바뀜·`unchanged`·`opportunity`)와 `backend/src/insight-interpret-flow.test.ts`(동의 없으면 `held`) | T02·T04 |
| C1a(T05) | `knowledge-engine/src/insight-code-rules.test.ts`: 다섯 유형의 시나리오와 변형 / `knowledge-engine/src/insight-import.test.ts`: `fixtures/p01-status.jsonl`에서 한 건씩 / `knowledge-engine/src/extraction-v6.test.ts`: `status` 소문자, `conclusion` 인용문·500자 검사, 한 번의 추출은 한 `observed_at` | T05 |
| C1b(T05) | `storage/src/knowledge-schema.migration.test.ts`: 3판 seed가 유형 목록과 같고 사용자가 바꾼 규칙은 그대로 / `packages/contracts/src/insight-types.test.ts`: 지원 유형 목록 | T05 |
| C1a(`opportunity`) | (T04) `knowledge-engine/src/insight-interpret.test.ts`: 부모 근거를 가진 한 건, 부모의 사실 줄이 바뀌면 철회 | T04 |
| C3b | `knowledge-engine/src/insight-code-rules.test.ts`: 어긋남 두 쌍 → 한 건, 재판정 `unchanged` | T02 |
| C3c | `knowledge-engine/src/insight-rules.test.ts`: `updated`·`resolved`·`revived`와 같은 id | T01 |
| C3d | `knowledge-engine/src/insight-rules.test.ts`: 신뢰도 30과 제외 표시, 승인 뒤 해제 | T01 |
| C1c·C2d | `backend/src/insight-api.test.ts`(새 파일): 유형 13줄 / 두 Insight의 순서와 필드, 해석이 있는 행, 철회된 행 | T03 |
| C2d(화면) | `apps/web/src/evidence-view.test.tsx`: 한 행이 유형 이름·사실 줄·이유 요약·순위·알림 제외 글자를 보이고 사실 줄은 `<bdi>` 안에 있다 | T03 |
| C2e | `backend/src/read-gate.test.ts`: 끝 항목이 숨은 원본의 사실을 가진 Insight는 목록·근거 조회에서 빠진다(원본이 숨은 경우는 기존 시험이 증명). 변이 확인 대상 | T03 |
| C3e | `backend/src/semantic-settings-api.test.ts`: 기본 꺼짐, 켜기, 빠지면 그대로 | T03 |
| C2f | `apps/web/e2e/evidence.e2e.ts`의 시험 하나(브라우저만, seed `plain`) | T03 |

화면 흐름의 E2E 하나는 T03에 둔다(브라우저만).

## 작업 분해

**첫 묶음(PR 하나)은 T01 + T02다.** T03~T05는 다른 세션이 쥔 파일이 풀린 뒤에 잇는다.

| 작업 | 내용 | 기준 | 선행 | 주요 파일 |
|---|---|---|---|---|
| P01-T01 | 마이그레이션(열 다섯), 저장(`saveInsight`·`readInsight`), 유형 표, 규칙 틀 `recomputeInsights`(지문·갱신·철회·범위·신뢰도), `rankInsight`, "의존 업무 지연"을 틀로 옮김, 실행 자리 넷 교체 | C1b, C2a·b·c(저장), C3c·d | 없음 | `storage/src/{migrations,insights}.ts`, `packages/contracts/src/insight-types.ts`, `knowledge-engine/src/{insight-rules,insight-ranking,dependency-delay,extraction,canonical-kinds}.ts`, `backend/src/{server,composition}.ts` |
| P01-T02 | 코드 규칙 셋(`schedule_conflict`·`conflict`·`important_change`)과 fixture `fixtures/p01-insights.json`(13개 유형) | C1a·b, C3a(코드)·b | T01 | `knowledge-engine/src/insight-code-rules.ts`, `fixtures/` |
| P01-T03 | API와 화면: Insight 응답에 유형·사실 줄·이유 요약·순위·알림 제외, 순위순 목록, `GET /api/insights/types`, Home 표시, 설정 `insight.interpret` 스위치(API·설정 화면, #232), 브라우저 E2E 하나 | C1c, C2d·e·f, C3e | T02, K01 머지 | `packages/contracts/src/index.ts`, `backend/src/{read-gate,server,insight-view}.ts`, `storage/src/evidence-view.ts`, `apps/web/src/{evidence-view,evidence-text,App}.tsx`, `apps/web/e2e/evidence.e2e.ts`, `docs/site-setup.md` |
| P01-T04 | LLM 해석: Broker 작업 `insight-interpret`, 엄격한 출력 스키마, 해석 열 셋(v29)과 설정 `insight.interpret`, `opportunity` 유형, Provider 없을 때 보존 | C2c(해석), C3a(LLM), C1a(`opportunity`) | T01, S03-T07 머지 | `packages/contracts/src/{provider,insight-types}.ts`, `providers/src/tasks.ts`, `storage/src/{migrations,insights,insight-interpretation,job-kinds}.ts`, `knowledge-engine/src/{insight-interpret,insight-code-rules,insight-ranking,linking}.ts`, `backend/src/{composition,boot}.ts`, `apps/web/src/job-text.ts`, `docs/site-setup.md` |
| P01-T05 | 남은 코드 유형: 상태·요청 종류 추가(유형 목록 판 올림), `decision_change`·`policy_change`·`pending_request`·`open_issue`·`new_relation`, 가져오기를 지나는 JSONL fixture | C1a(나머지) | T02, S03-T07 머지 | `packages/contracts/src/knowledge-schema.ts`, `storage/src/migrations.ts`, `knowledge-engine/src/insight-code-rules.ts`, `packages/testkit/src/fixture-extraction.ts` |

## 잠정 결정과 가정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **P01-D1 유형 이름은 기존 `insights.rule` 열에 둔다.** 새 열을 만들지 않는다.
- **P01-D2 지문은 (유형, X 대표, Y 대표)다.** 한 항목의 어긋남·변경은 한 건으로 모은다. 자리(종류·꼬리표)마다 한 건으로 나누려면 유일 키를 넓히는 마이그레이션이 필요하다.
- **P01-D3 "일정 충돌"은 한 항목의 완료일이 자기 목표일보다 늦은 것으로 정의한다.** 사람의 일정 겹침은 Event의 시각 종류가 생긴 뒤의 일이다.
- **P01-D4 "중요 변경"은 날짜 종류(`target_date`·`completion_date`)의 대체만 본다.** 어떤 변경이 중요한지의 해석은 T04의 LLM 몫이다. 종류 목록은 규칙 파일의 상수 하나다.
- **P01-D5 알림 제외 표시는 저장하지 않고 신뢰도에서 계산한다.** 기준값 50은 상수 하나다(`LOW_CONFIDENCE_BELOW`). P02가 저장된 표시를 원하면 열을 더한다.
- **P01-D6 순위의 가중치와 구간 값은 상수다.** 실제 사용 기록이 없어 근거 있는 값이 아니다. P03에서 다시 정한다.
- **P01-D7 관련성은 "사용자 입력 행을 썼는가"만 본다.** 사용자 관심 모델이 없기 때문이다(P03).
- **P01-D8 첫 묶음의 fixture는 규칙 층의 시나리오 파일(JSON)이다.** 가져오기를 지나는 JSONL은 T05에서 더한다(추출 double과 합성 목록을 S03-T07이 고치는 중). "의존 업무 지연"의 가져오기 경로는 V02 fixture가 이미 증명한다.
- **P01-D9 기존 활성 행은 마이그레이션에서 채우지 않는다.** 다음 판정 때 채워지고 그때 `changed_at`이 한 번 새로 적힌다.
- **P01-D10 `recomputeDependencyDelay`는 규칙 하나만 도는 입구로 남긴다.** 기존 테스트 열세 파일이 V02·S02의 동작을 이 이름으로 증명하고 있다.
- **P01-D11 ADR은 따로 쓰지 않는다.** 새 테이블·새 종류가 없고 결정은 이 절에 있다. ARCHITECTURE의 Insight 줄만 고친다.
- **P01-D12 해석은 열 셋에 따로 둔다.** `llm_reasoning_summary`(500자 이하)·`llm_impact`·`llm_actionability`(0~100), 모두 NULL 허용. 코드가 쓴 `reasoning_summary`를 덮으면 규칙 실행기가 다음 판정에서 `updated`로 되돌려 C3b가 깨지기 때문이다. 읽는 쪽(T03)은 `llm_reasoning_summary ?? reasoning_summary`를 쓰고, `rankInsight`는 두 숫자를 선택 신호로 받아 유형 기본값 대신 쓴다. 제자리에 저장하려면 실행기가 이유 요약 비교를 그만두고 틀을 따로 보관해야 한다.
- **P01-D13 코드가 행을 쓸 때마다 해석을 비운다.** `saveInsight`가 만들기·갱신·되살리기·철회에서 세 열을 NULL로 만든다(R3, K01-D14: 바뀌거나 사라진 원본에서 나온 글이 남지 않게). 실행기는 `unchanged`에 쓰지 않으므로 다시 판정해도 해석은 남는다. 원본이 삭제·정리되거나 범위가 바뀔 때는 `insight` 종류의 `invalidate`가 모은 Insight의 세 열을 비우고 같은 키의 활성 `opportunity`를 철회한다(Insight 자신의 내용이 그대로여도 해석은 지워진 원본에서 나온 글일 수 있기 때문이다. K01의 위키 요약과 같은 방식). 갱신 뒤에도 남기려면 기준 해시 열을 두고 읽을 때 거른다. 비운 해석은, 비우기 전에 해석이 있었고 설정이 켜져 있으면 한 번 다시 요청한다(PD3-R1, [PD3 spec](2026-11-24-PD3-pending-decisions.md)).
- **P01-D14 작업 대상은 `<Insight id>#<기준>`이다.** 기준은 `[유형, 추론 문장, 사실 줄, 이유 요약, 신뢰도, 시급 날짜, 근거 id, 사용자 입력, 연결 id]`의 SHA-256이고, 행이 활성이고 기준이 그대로일 때만 쓴다(K01-D13 방식, 새 열 없음). Insight마다 열린 작업은 하나이고 이미 시도한 기준(같은 대상의 작업이 어떤 상태로든 있는 것)은 다시 만들지 않는다. 그렇지 않으면 해석 없이 닫힌 작업이 작업 종료 때의 재요청으로 끝없이 Provider를 부른다(처음 계획은 기준에 신뢰도·시급 날짜·이유 요약을 넣지 않았으나, 그것만 바뀐 쓰기가 해석을 비우고도 다시 시도되지 않는 틈이 생겨 넣었다). 시도 횟수 열을 두면 바꿀 수 있다.
- **P01-D15 설정 `insight.interpret`은 기본 끔이고 정확히 `on`일 때만 켠다**(루트 13-5 dark launch, `wiki.summary`와 같은 방식). 시작 때, 작업이 닫힐 때, 켜질 때 큐에 넣고 한 번에 50건까지다. **저장소 스위치(`setInsightInterpret`)만 들어가고 API·화면은 없다**: 설정 경로(`backend/src/server.ts`·`packages/contracts/src/index.ts`)는 다른 세션이 쥐고 있다. 후속(이슈 또는 T03)에서 그 경로에 `insightInterpret` 필드를 더한다. → T03이 더했다(R17, D33).
- **P01-D16 Provider로 나가는 것.** `sourceVersionIds`는 Insight 계보의 version 행(8개 이하, 합계 `MAX_EXTRACT_CODE_POINTS` 이하), `candidateItemIds`는 X·Y와 `insight:<id>`다. `knowledgeCandidates`가 `insight:<id>`에 이름(`[유형] 추론 | 사실 줄`)과 등록부의 `insight` 계보를 답하고, 사용자 입력 행을 쓴 Insight는 출처 없는 이름으로 가장 엄격한 등급을 받는다(닫힌 쪽으로 실패). 계보가 없거나 한도를 넘거나 정책이 묶음을 거부하면 호출 없이 끝난다. Broker는 그대로이고 읽기·등급은 Broker만 한다. Insight 글을 보내지 않으려면 세 번째 후보를 빼야 하고 그 대신 모델이 유형을 모른다.
- **P01-D17 응답 스키마 v1은 모든 단계에서 엄격하다.** `{ reasoningSummary: 1~500자, impact: 0~100 정수, actionability: 0~100 정수, opportunity: { statement: 1~200자 } | null }`. 다른 키나 긴 글은 Broker의 `invalid-output`이고 처리기는 다시 묻지 않는다(`retryable: false`). 부분 수용을 하려면 길이 검사를 처리기로 옮겨야 한다.
- **P01-D18 `opportunity`는 해석 응답이 제안하고 나머지는 코드가 정한다.** 키는 부모의 `(opportunity, X, Y)`다. 처리기가 문장을 `summary`로(추론), 부모의 사실 줄·근거·사용자 입력·연결·시급 날짜를 그대로 복사해 쓰고, 신뢰도는 `min(부모, 40)`이라 늘 자동 알림 제외다. 활성 행이 이미 있으면 제안은 버린다. 규칙(`opportunityRule`)은 같은 키에 사실 줄·근거·입력·연결이 같은 활성 Insight가 있는 동안만 유지하고(부모의 요약·시급 날짜만 바뀐 경우는 같은 것으로 보고 유지한다) 아니면 철회하며, 철회된 행은 규칙이 되살리지 않는다(글이 없다). 모델의 인용문과 새 근거 행은 만들지 않는다(근거는 사실·관계에 매인다). `opportunity` 행은 다시 해석하지 않는다. 상한은 상수 하나다.
- **P01-D19 유형 표는 `opportunity`를 지원으로 올린다.** 설정이 켜져야만 생기지만 R1이 "구현된 만큼"을 지원으로 정하기 때문이다. 보고서에 "지원(꺼짐)"이 필요하면 세 번째 상태를 더한다.
- **P01-D20 요청은 새 항목 유형 `Request`다.** 약속(Commitment)·할 일(Task)과 뜻이 달라 섞지 않는다. Commitment로 판정하려면 `pending_request` 규칙의 항목 유형 상수 하나를 바꾼다.
- **P01-D21 상태 값은 닫힌 네 개이고 열린 값은 `open`·`in_progress`다.** 값 유형의 값 목록(`WORK_STATUSES`)과 규칙 파일의 `OPEN_STATUSES`다. 값을 더하려면 두 상수를 고친다.
- **P01-D22 결정·규칙의 "현재 내용"은 새 종류 `conclusion`(값 하나)이다.** `statement`는 여러 값인 채로 둔다(여러 값 종류는 대체 연결이 없다). 변경으로 볼 종류를 바꾸려면 두 변경 규칙의 종류 상수를 고친다.
- **P01-D23 상태 유형의 조건에 기한 경과를 넣지 않는다.** 규칙이 현재 시각을 읽으면 날이 바뀔 때 다시 판정할 작업이 필요해진다. 기한은 시급 날짜로 순위에 반영된다.
- **P01-D24 "새 관계"는 이미 있던 두 항목 사이의 아직 확인되지 않은 관계다.** 기간으로 철회하지 않는다(D23과 같은 이유). 한 문서가 항목과 관계를 함께 처음 들여올 때는 서지 않아야 하므로, 한 번의 추출이 쓰는 행은 모두 같은 `observed_at`을 갖는다. 관계 유형 목록은 규칙 파일의 `NEW_RELATION_TYPES`다. `new_relation`은 문서를 나눠 가져오는 기존 시험 흐름에서 새 Insight를 만들 수 있다(범위 정책 시험 한 곳의 기대값이 바뀜).
- **P01-D25 T05는 마이그레이션 하나(v30)를 쓴다.** 유형 목록 3판의 seed와 넓힘뿐이고 열은 더하지 않는다. 번호는 합칠 때 비어 있는 다음 번호다.
- **P01-D26 D16의 보정: `insight:<id>` 후보의 글은 항목 이름도 담으므로 등급을 Insight 계보와 X·Y 묶음 계보의 합집합으로 매긴다.** X·Y 항목 계보가 없는 Insight(사용자가 만든 항목)는 출처 없는 이름으로 가장 엄격한 등급이다. 처리기는 범위 정책(`combinable`)도 같은 합집합에 묻고, 커밋 때 범위 정책을 다시 묻는 항목 계보도 같은 합집합이다(#238). 보내는 원본 version은 그대로 Insight 계보뿐이다. 독립 리뷰가 D16의 계보만으로는 다른 원본에만 나오는 항목 이름이 약한 등급으로 나갈 수 있다고 지적했다(Broker 요청에는 X·Y 후보도 실리지만 정책 질의는 Insight 계보에만 했다).
- **P01-D27 (T03) 새 경로를 만들지 않고 기존 Insight 응답에 필드를 더한다.** 목록과 근거 조회가 같은 모양을 쓴다. 한글 유형 이름은 응답에 싣지 않고 화면이 `INSIGHT_TYPES`에서 찾는다. 아직 다시 판정되지 않은 옛 행(D9)은 `factLines`가 빈 배열이고 이유 요약·신뢰도가 `null`이다.
- **P01-D28 순서는 점수 내림차순, 같으면 `changed_at`이 늦은 것(없으면 뒤), 그래도 같으면 id 오름차순이다.** 목록에 상한은 두지 않는다(지금도 없다). 순서와 순위 계산은 `backend/src/insight-view.ts` 한 곳에 있고 시각은 서버 시계다.
- **P01-D29 철회된 Insight는 어떤 응답에도 없다**(V02-R14 그대로). 철회 이력을 보이려면 상태 필드와 별도 목록이 필요하다(P02·P03에서 필요해지면).
- **P01-D30 읽기 문에 끝 항목 검사를 더한다.** 지금까지는 Insight 계보만 봤는데, 추론 문장과 사실 줄의 항목 이름은 다른 원본에서 왔을 수 있다. 검사는 대표 항목 자신의 `item` 계보다(Semantic 목록이 그 이름을 보일 때와 같은 판정). 효과: 끝 항목에 숨은 원본에서 온 사실이 하나라도 있으면 그 항목의 Insight도 숨는다(닫힌 쪽으로 실패). 빼려면 `read-gate.ts`의 검사 한 줄을 지운다. Wiki의 Insight 페이지(`wiki-read.ts`)도 같은 검사(`ReadGate.insightEndsShown`)를 거쳐, 끝 항목이 숨은 Insight는 페이지·색인·역링크에서 없는 페이지와 같은 답이다(이슈 #257 F4).
- **P01-D31 이유 요약은 하나만 주고 누가 썼는지 표시한다.** 해석이 있으면 해석의 글과 `reasoningBy: llm`이고 화면은 "해석(LLM)"이라고 붙인다. 코드의 글도 함께 보이려면 필드를 하나 더한다.
- **P01-D32 알림 제외는 불리언 하나로 주고 화면은 "자동 알림 제외(신뢰도 낮음)" 글자로 보인다.** 값은 기존 함수 `isAutoNotifyExcluded`가 정한다(D5). 신뢰도가 없는 옛 행은 거짓이다.
- **P01-D33 설정 필드는 `insightInterpret`이고 `wiki.summary`와 같은 경로(`/api/settings/semantic`)에 둔다.** `wiki.summary`는 API에만 있고 화면이 없다. T03은 Insight 해석의 체크박스만 더하고 위키 요약의 화면은 건드리지 않는다. 스위치를 두는 것은 켜는 것이 아니다: 기본은 꺼짐이고 켜는 것은 사용자의 조작이다(D15).
- **P01-D34 유형 경로는 13개 전부를 주고 순위 기본값(영향·행동성)은 싣지 않는다.** 원본 자료가 아닌 코드 상수라 읽기 문을 지나지 않는다(토큰 검사는 다른 경로와 같다). `opportunity`는 설정이 꺼져 있어도 "지원"이다(D19).
- **P01-D35 T03은 마이그레이션을 쓰지 않는다.** 모든 값이 이미 있는 열(v28·v29)과 읽을 때의 계산에서 나온다. `backend/src/server.ts`와 `packages/contracts/src/index.ts`의 변경은 줄·필드를 더하는 것뿐이다(다른 세션 `feat/k02-reflection`과 겹치는 파일).
- **P01-D36 E2E는 새 파일을 만들지 않고 `evidence.e2e.ts`에 시험 하나를 더한다.** 그 파일의 `startStack`과 seed `plain`을 그대로 쓰기 위해서다. Electron에서는 건너뛴다.
- **P01-D37 `new_relation`은 양 끝 항목 행 자신의 `observed_at`과 비교한다(잠정, #238 F4).** 병합 묶음의 `observed_at`은 보지 않는다. R12의 문구가 "양 끝 항목 행"이고 한 번의 추출이 같은 `observed_at`을 쓰는 것(D24)이 이 비교를 전제로 하며, 기존 fixture·시험에서 틀린 결과를 내는 경우를 찾지 못해 유지한다. 바꾸려면 `newRelationRule`의 비교 대상(`from`·`to`)을 묶음 대표의 값으로 바꾸고 시험 기대값을 다시 정한다.

## 미해결 질문 / 검증하지 않은 범위

- 새 규칙 셋이 추출·전파 경로에서 함께 돌면서 기존 테스트의 Insight 수·전파 기록 수가 달라질 수 있다. 구현에서 확인하고, 달라진 기대값은 PR에 이유와 함께 적는다.
- K01의 `syntheses` 페이지는 Insight의 양 끝을 backlink로 쓴다. X = Y인 Insight에서 자기 자신을 가리키는 줄이 생기는지는 K01이 합쳐진 뒤 확인한다.
- 실제 LLM의 해석 품질, 실제 Provider의 스키마 준수, 배포처 범위 정책 아래의 동작은 검증하지 않는다.
- 설정 `insight.interpret`을 켜는 스위치는 T03이 더한다(R17). 실제 Provider의 해석 품질과 호출 비용은 재지 않았으므로 켜기 전에 잰다.
- (T03) D30의 끝 항목 검사가 기존 흐름에서 Insight를 얼마나 더 숨기는지는 재지 않았다. 구현에서 기존 시험(`read-gate`·`evidence-api`·`boot.read-gate`·E2E)의 기대값이 바뀌면 PR에 이유와 함께 적는다.
- (T03) 해석이 켜진 상태의 화면(해석 글, "해석(LLM)" 표시)은 단위 시험만 증명한다. E2E는 스위치가 저장되는 것까지만 본다.
- (T03) D30으로 `backend/src/correction-effective.test.ts`의 두 기대값이 바뀌었다: 사용자가 쓴 행이 끝 항목의 계보를 그대로 가지는 두 경우는 끝 항목이 숨겨지면 Insight도 숨겨지므로(R15), 하나는 계보가 따로 있는 승인된 사실로 부분 숨김(S01-R15)을 지키도록 다시 심었고 하나는 Insight가 없다는 단언으로 바꿨다.
- (T03) Electron 셸에서의 새 화면은 확인하지 않는다(브라우저만).
- 순위 값이 사용자에게 쓸모 있는 순서를 만드는지는 검증하지 않는다(P03).

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-23 | 최초 작성(초안) | 이 문서 | 이슈 #27의 구현 spec |
| 2026-11-23 | 상태를 초안에서 확정으로 바꿈(잠정 결정 D1~D11 그대로 수용) | 이 문서 | 오케스트레이터가 계획을 수용하고 구현 착수 |
| 2026-11-23 | T04 설계 반영: 해석 열 셋, 설정 insight.interpret, opportunity 지원, D12~D19 | R1·R5·R7·C1a·C2c·C3a·작업 분해 | P01-T04 구현 |
| 2026-11-23 | D13·D14 보강: 원본 삭제·정리·범위 변경 때 해석 열과 opportunity를 지우고, 이미 시도한 기준은 상태와 무관하게 다시 큐에 넣지 않음 | D13·D14 | P01-T04 독립 리뷰 지적 반영(재시도 폭주, 삭제된 원본에서 나온 글의 잔존) |
| 2026-11-23 | T05 설계 추가: R11·R12(새 종류와 남은 코드 유형 다섯), 유형 표의 다섯 유형을 지원으로, C1a·C1b 추가 행, D20~D25, D16 보정(D26: Insight 후보를 항목 계보까지 합쳐 등급) | 요구사항·완료 기준·잠정 결정 | P01-T05 구현과 독립 리뷰 M1 반영 |
| 2026-11-23 | D26 보강: 커밋 때 범위 정책 재확인도 호출 전과 같은 합집합(Insight 계보 + X·Y 묶음 계보)에 묻는다. X≠Y 시험 추가 | D26 | 이슈 #238 F1·F2 |
| 2026-11-23 | T03 설계 추가: R13~R17(Insight 응답·순서·읽기 문·유형 보고·해석 스위치), 기준 C1c·C2d·e·f·C3e와 증명 시험, D27~D36, 작업 표의 T03 줄 | 요구사항·완료 기준·작업 분해·잠정 결정 | P01-T03 구현 착수, 이슈 #232 첫 항목 |
| 2026-11-23 | R5 문구에 `llm_*` 열·opportunity 요약 반영, C1a·D18의 opportunity 철회 조건을 코드와 같게(사실 줄·근거·입력·연결), D30의 Wiki Insight 페이지 검사 반영, D37 추가 | R5·C1a·D18·D30·D37 | 이슈 #232 U2·S2, #257 F4, #238 F4 |
| 2026-11-24 | `conflict` 유형 표에 대체된 끝 건너뛰기, R15에 `graphTrace`의 끝 항목 검사를 가리키는 문장을 더함. 요구사항·기준은 그대로 | 유형 표, R15 | 이슈 #221 F1, #257 N-3을 [Phase 5 후속 spec](2026-11-24-P5-followups.md)가 처리 |
| 2026-11-24 | D13에 한 문장: 비운 해석은 비우기 전에 해석이 있었고 설정이 켜져 있으면 한 번 다시 요청함. 요구사항·기준은 그대로 | D13 | 이슈 #232 D1-U7을 [PD3 spec](2026-11-24-PD3-pending-decisions.md)이 처리 |
