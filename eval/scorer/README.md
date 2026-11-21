# eval/scorer

골든 데이터셋을 검증(`validate.py`)하고 제품의 예측을 채점(`score.py`)하는 표준 라이브러리 전용 Python 3 도구이다. 제품이나 엔진은 실행하지 않으며, 아직 어떤 제품 출력도 채점한 적이 없다.

## 구조

```text
eval/scorer/
  validate.py   데이터셋 정합성 검사 (스키마, quote=span, id 해소, 분할, 해시, 비밀·경로 점검)
  score.py      predictions JSONL 채점 (Recall@K, Precision@K, MRR, 관계 P/R, 엔티티 해소 F1, citation accuracy)
  common.py     JSON/JSONL 읽기 도우미
  tests/        unittest (구현보다 먼저 작성됨)
```

## 사용법

```bash
python3 eval/scorer/validate.py eval/golden
python3 eval/scorer/score.py eval/golden predictions.jsonl --split eval --k 5
python3 -m unittest discover -s eval/scorer/tests -v
```

`score.py` 옵션: `--split dev|eval`, `--scenario <이름>`(여러 번 가능), `--k`(기본 5). 결과는 JSON으로 출력된다.

## predictions 형식

한 줄에 JSON 하나. `kind`로 구분한다.

| kind | 필드 | 의미 |
|---|---|---|
| `retrieval` | `query_id`(`labels/qa.jsonl`의 `label_id`), `ranked`(레코드 id 목록, 순위순. 객체 `{"record_id": ...}`도 허용) | 질문별 검색 순위 |
| `citation` | `query_id`, `citations`(`[{"record_id", "version"}]`) | 질문별 답변이 단 인용. 답할 수 없는 질문은 빈 목록이 정답 |
| `relation` | `subject`, `relation`, `object` (정답 엔티티 id 사용). 라벨에 닿지 않는 예측은 `"judged": false`(선택 `scenario_instance`)로 표시 | 제품이 낸 관계 한 건 |
| `resolution` | `pair_id`(`resolution_pairs.jsonl`의 `label_id`), `same`(true/false) | 두 mention이 같은 엔티티인가 |

예시:

```json
{"kind":"retrieval","query_id":"S01-I3:qa-1","ranked":["msg-0031","wiki-0019","mail-0027"]}
{"kind":"citation","query_id":"S01-I3:qa-1","citations":[{"record_id":"msg-0031","version":1}]}
{"kind":"relation","subject":"S01-I3:proj","relation":"DEPENDS_ON","object":"S01-I3:sys"}
{"kind":"resolution","pair_id":"S02-I1:pair-2","same":false}
```

규칙:

- `query_id`, `pair_id`, 관계의 엔티티 id가 데이터셋에 없거나 관계 타입이 설계 §7에 없으면 오류로 종료한다(오타가 조용히 0점이 되지 않게).
- 예측이 없는 질문의 검색은 빈 순위(0점), 예측이 없는 엔티티 쌍은 "같지 않음"으로 센다. 누락 수는 출력의 `missing_predictions`, `missing`에 나온다.
- 검색 정답은 질문의 `evidence`에 나온 `record_id`의 집합이다(버전은 보지 않음). 인용은 `(record_id, version)` 쌍으로 비교한다.
- 같은 질문의 같은 `(record_id, version)` 인용은 한 번만 센다. `CONTRADICTS`, `RELATED_TO` 관계는 방향을 구분하지 않는다.
- `"judged": false` 관계는 정밀도에서 빼고 출력의 `n_unjudged`로만 보고한다(`docs/EVALUATION.md` §2.0).
- 중복 레코드(`duplicate_threads`)는 정답 근거에 **원본만** 넣었다. 복사본을 인용하면 틀린 인용으로 센다(보수적 채점).
- `relation`의 엔티티는 정답 엔티티 id로 적는다. 제품 엔티티를 정답 엔티티에 대응시키는 정렬은 이 도구의 범위 밖이다(`docs/EVALUATION.md` §6).
- Insight 지표, Temporal Fact Accuracy, Source Attribution 등은 아직 계산하지 않는다(`docs/EVALUATION.md`에 정의만 있음).

## 지표 정의 요약

정확한 식은 `docs/EVALUATION.md` §2가 정본이다. 구현은 `score.py`의 함수 이름과 같다: `recall_at_k`, `precision_at_k`, `reciprocal_rank`, `relation_metrics`, `pairwise_f1`, `citation_metrics`.

## 참고

- 데이터셋 설명: `eval/golden/README.md`
- 평가 기준과 통과선: `docs/EVALUATION.md`
