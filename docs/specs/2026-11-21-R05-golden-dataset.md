# 스펙: R05 합성 Golden Dataset과 평가 기준

- 날짜: 2026-11-21 / 상태: 초안
- 관련: 이슈 #14(R05), 총괄 #1, Phase 0 #2, 선행 #35. 원 설계: [docs/design/original-design.md](../design/original-design.md) §5, §6.7, §7, §10, §18

## 배경

설계 §18은 "기능을 만들었는가"가 아니라 "지식 품질이 실제로 좋은가"를 재라고 요구하고, 한국어·한영 혼용 업무 환경을 반영한 합성 Golden Dataset(사람이 검토할 수 있는 정답 모음)을 만들라고 한다. 엔진 후보 비교(R01, R03)와 이후 구현이 같은 자로 평가되려면, 결과를 보기 전에 데이터·정답·채점 방식·통과 기준이 먼저 고정되어 있어야 한다. 결과를 본 뒤에 기준을 고르면 기준이 결과에 맞춰진다.

이 spec은 그 자(데이터, 정답, scorer, 평가 문서)를 만드는 일의 기준이다. 제품, 엔진, LLM은 실행하지 않는다. 데이터는 전부 가상이며 실제 사내 데이터는 다루지 않는다.

## 목표

- 가상 회사의 메일형·위키형·메신저형 SourceRecord가 120~180건 있고, 모든 레코드가 `example.test` 도메인과 지어낸 인물·팀·프로젝트·시스템만 쓴다.
- 이슈 #14가 요구한 10개 시나리오가 각각 3개 이상의 "시나리오 인스턴스"(한 시나리오를 구현한 독립된 레코드 묶음)로 들어 있고, 연결하면 안 되는 방해(distractor) 레코드가 별도 시나리오로 들어 있다.
- 모든 정답 라벨이 원문 레코드의 정확한 위치(`record_id`, `version`, `span`, `quote`)를 근거로 가진다.
- 개발용과 봉인 평가용이 시나리오 인스턴스 단위로 겹치지 않게 나뉘어 있다.
- 표준 라이브러리만 쓰는 validator와 scorer가 있고, 테스트가 구현보다 먼저 쓰였다.
- `docs/EVALUATION.md`에 지표 정의, 5단계 ablation, 측정 환경, 수치 통과 기준이 측정 전에 고정되어 있다.
- 생성자가 만든 라벨은 독립 검토를 받지 않았음이 파일로 명시되어 있다.

## 비목표

- 제품·엔진·임베딩 모델·LLM을 실행하거나 점수를 측정하지 않는다. 이 문서 어디에도 실측값은 없다. 측정은 배포처 환경에서 한다.
- 실제 사내 메일·위키·메신저 데이터, 실제 인물·회사·제품 이름은 만들지 않는다(배포처 범위).
- 독립 검토(R05-C2의 "독립 검토 라벨")를 이 작업에서 수행하지 않는다. 절차만 문서로 남긴다.
- 사람 평가가 필요한 지표(Relevance, Novelty, Actionability 등)를 자동 채점하는 코드는 만들지 않는다. 평가 문서에 평가 방식만 고정한다.
- PDF/DOCX/XLSX 등 파일 형식 파싱 평가는 다루지 않는다.

## 요구사항

- R05-R1: `eval/golden/sources/{mail,wiki,messenger}.jsonl`에 SourceRecord를 둔다. 필드는 설계 §5의 `id, source_type, external_id, title, content, author, participants, thread_id, source_url, created_at, updated_at, content_hash, version, access_scope, metadata`에 `connector_instance_id`, `operation`(`upsert`/`delete`/`revoke`), `schema_version`을 더한다. 한 `(id, version)` 쌍이 한 줄이다. 총 120~180줄.
- R05-R2: 시나리오 `schedule_dependency_delay`(설계 §10의 A/B 예 포함, 전체 ISO 날짜), `same_name_different_people`, `abbreviation_two_meanings`, `contradicting_statements`, `correction_supersedes`, `deletion`, `permission_revocation`, `timezone_offsets`, `duplicate_threads`, `mixed_ko_en_same_concept`가 각각 3개 이상의 인스턴스를 가진다.
- R05-R3: `distractor_noise` 시나리오가 3개 이상의 인스턴스를 가지며, 각 방해 레코드는 "연결하면 안 됨"으로 라벨링된다(relations의 `expected: false`).
- R05-R4: `eval/golden/labels/`에 `entities`, `resolution_pairs`, `relations`, `temporal_facts`, `insights`, `qa` 여섯 파일을 둔다. 관계 type은 설계 §7, Insight type은 설계 §10, 지식 type은 설계 §7에서 고른다. 모든 라벨에 `evidence`(`{record_id, version, span:[start,end], quote}` 목록)가 있고 `quote`는 해당 레코드 `content`의 `[start,end)` 조각과 같다. `span`은 유니코드 코드포인트 기준이다. Insight는 `is_inference`를 가진다.
- R05-R5: `eval/golden/splits.json`이 각 시나리오 인스턴스를 `dev` 또는 `eval`에 정확히 한 번 배정하고, 인스턴스별 `record_ids`를 적는다. 봉인은 공개 저장소이므로 비밀이 아니라 약속(관례)임을 적는다.
- R05-R6: `eval/golden/labels/REVIEW_STATUS.md`가 모든 라벨 파일을 `generator-labelled, independent review pending`으로 표시하고 독립 검토 절차를 적는다. R05-C2 충족을 주장하지 않는다.
- R05-R7: `eval/scorer/validate.py`가 스키마, evidence의 quote와 span 일치, id 해소, 분할의 서로소·전체 포함, 레코드 해시를 검사하고 위반을 0이 아닌 종료 코드로 알린다.
- R05-R8: `eval/scorer/score.py`가 predictions JSONL(형식은 `eval/scorer/README.md`)에서 Recall@K, Precision@K, MRR, 관계 precision/recall, 엔티티 해소 pairwise F1, citation accuracy를 계산한다.
- R05-R9: `docs/EVALUATION.md`(한국어)가 설계 §18의 Knowledge/Insight/Retrieval/System 지표를 정확한 식으로 정의하고, 5단계 ablation과 유지 조건, 측정 환경, 잠정 수치 기준을 담는다. 측정이 없었고 배포처에서 한다는 사실을 명시한다.
- R05-R10: scorer와 validator의 각 함수는 실패하는 테스트가 먼저 있었다. quote와 span이 어긋난 경우를 잡는 실패 사례 테스트가 있다.
- R05-R11: 데이터와 문서에 실제 이름, 로컬 경로, 실제 도메인 이메일, 비밀값이 없다. 외부 의존성이 없다.
- R05-R12: `eval/golden/README.md`(한국어)가 구성, 라벨 작성 방법, 알려진 한계를 적는다. 데이터를 재생성하는 스크립트는 `eval/golden/tools/`에 두되 커밋된 JSONL이 원본이다.

## 인터페이스 / 설계 개요

경계는 파일 형식 둘이다. 하나는 데이터셋(`eval/golden/`), 다른 하나는 예측 파일(제품이 낼 결과)이다. 둘 사이를 `eval/scorer/`가 잇는다. 한 파일의 상세 스키마는 `eval/scorer/README.md`와 `eval/golden/README.md`가 정본이다.

```text
eval/golden/sources/*.jsonl  ->  (제품이 처리)  ->  predictions.jsonl
eval/golden/labels/*.jsonl   ->  score.py  <-  predictions.jsonl
eval/golden/splits.json      ->  score.py --split dev|eval
```

## 완료 기준 (테스트 가능한 형태)

아래 R05-C1~C3은 이슈 #14의 문구를 그대로 옮긴 것이다.

- [ ] R05-C1: 일정 의존 지연, 동명이인, 약어 다의성, 상충/수정/삭제/권한철회, 시차, 중복 스레드를 포함하며 각 정답에 원문 evidence와 span이 있다.
- [ ] R05-C2: 학습·튜닝용과 봉인된 평가용 집합을 분리하고 생성 모델의 자기 채점을 단독 정답으로 쓰지 않는다. 독립 검토 라벨과 scorer를 기록한다.
- [ ] R05-C3: Knowledge/Insight/Retrieval 지표와 keyword→vector→graph→semantic→wiki ablation을 정의한다. HW·corpus 크기·p50/p95·예산 조건과 수치 통과 기준을 결과 확인 전에 고정한다.

### 기준 ↔ 산출물 매핑

| 기준 | 요구사항 | 산출물 | 확인 방법 | 이 작업 후 상태 |
|---|---|---|---|---|
| R05-C1 | R05-R1~R4 | `eval/golden/sources`, `labels` | `python3 eval/scorer/validate.py eval/golden` 통과(시나리오별 인스턴스 3개 이상, quote=span 일치) | 충족 |
| R05-C2 분리 | R05-R5 | `splits.json` | validator의 분할 검사 | 충족(관례 봉인) |
| R05-C2 자기 채점 금지·독립 검토 | R05-R6 | `labels/REVIEW_STATUS.md` | 파일 검토 | 미충족: 독립 검토 대기 |
| R05-C2 scorer 기록 | R05-R8, R05-R10 | `eval/scorer/` | `python3 -m unittest discover -s eval/scorer/tests -v` | 충족 |
| R05-C3 | R05-R9 | `docs/EVALUATION.md` | 파일 검토(표의 모든 칸에 수치, 측정 없음 명시) | 충족(수치는 잠정) |

## 미해결 질문

- 독립 검토자(두 번째 검토자)를 누가 맡는가. 사람이 맡아야 R05-C2가 닫힌다.
- 임베딩 모델 후보가 정해지면(R01, R03) 한영 혼용 시나리오 하위 집합의 임계값을 다시 볼지는 측정 전 PR로 결정한다.

## 변경 이력

| 날짜 | 변경 내용 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-21 | 초안 작성 | 이 문서 | 이슈 #14(R05) 착수. 구현 전에 R/C 기준 고정 |
