# 라벨 검토 상태

**R05-C2(독립 검토 라벨)는 아직 충족되지 않았다.** 이 폴더의 모든 라벨은 데이터를 만든 생성자(LLM)가 직접 붙인 것이고, 아직 다른 검토자가 원문만 보고 다시 만든 적이 없다. 생성 모델이 자기 결과를 채점한 값은 단독 정답으로 쓰지 않는다. 독립 검토가 끝나기 전의 점수는 "잠정 라벨 기준"이라고 표시해야 한다.

## 파일별 상태

| 파일 | 줄 수 | 상태 |
|---|---|---|
| `entities.jsonl` | 69 | generator-labelled, independent review pending |
| `resolution_pairs.jsonl` | 47 | generator-labelled, independent review pending |
| `relations.jsonl` | 25 | generator-labelled, independent review pending |
| `temporal_facts.jsonl` | 53 | generator-labelled, independent review pending |
| `insights.jsonl` | 14 | generator-labelled, independent review pending |
| `qa.jsonl` | 40 | generator-labelled, independent review pending |
| `../splits.json` (분할 배정) | 34 인스턴스 | generator-assigned, independent review pending |
| `../sources/*.jsonl` (합성 원문) | 133 | generator-written (가상 데이터이며 정답이 아님) |

`quote`가 `span`과 같은지, id가 풀리는지 같은 **기계적 정합성**은 `eval/scorer/validate.py`가 검사한다. 이것은 라벨의 **의미가 옳은지**를 보증하지 않는다.

## 독립 검토 절차

1. **검토자 두 번째 1인**을 정한다. 생성자와 다른 사람 또는 다른 모델 계열이어야 하고, 사람이 최종 책임을 진다.
2. 검토자에게 `eval/golden/sources/`와 라벨 **스키마 설명**(`eval/golden/README.md`의 라벨 형식)만 준다. 기존 `labels/`는 **보여주지 않는다**(앵커링 방지).
3. 검토자는 원문에서 직접 엔티티, 엔티티 해소 쌍, 관계(방해 쌍 포함), 시간 유효성, 기대 Insight, Q&A와 근거 span을 도출해 `labels_reviewer/`에 같은 형식으로 쓴다.
4. 두 라벨 집합을 비교한다. 키(엔티티는 타입·evidence span, 관계는 삼중항, 쌍은 mention 두 개, 사실은 값·상태, Q&A는 질문·근거 쌍)로 맞춰 일치율과 불일치 목록을 만든다.
5. **불일치는 사람이 판정**한다. 생성자도 검토자도 자기 쪽을 정답으로 밀지 않는다. 판정 결과와 이유를 `labels/REVIEW_LOG.md`에 남기고 라벨을 고친다.
6. 각 파일의 상태를 `independent review done (reviewer, date, 일치율)`로 바꾸고, 이 문서의 맨 위 선언과 spec의 R05-C2 상태를 같은 변경으로 갱신한다.
7. 검토 중 봉인(eval) 분할을 열어 보았다면 그 사실을 기록한다. 봉인은 공개 저장소의 관례이다.

## 현재 알려진 위험

- 생성자가 시나리오와 정답을 함께 만들었으므로 데이터가 정답을 "쉽게" 드러내도록 쓰였을 수 있다(편향).
- 시나리오별 인스턴스는 3~4개뿐이다. 한 인스턴스의 라벨 오류가 점수에 크게 영향을 준다.
