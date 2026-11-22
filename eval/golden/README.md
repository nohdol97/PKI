# eval/golden — 합성 Golden Dataset

가상의 회사에서 오간 메일·위키·메신저 글(SourceRecord)과, 그 글에서 사람이 검토할 수 있는 정답(라벨)을 모아 둔 평가용 데이터이다. 제품이 지식을 얼마나 정확히 뽑는지 재는 "자"이며, 평가 기준과 통과선은 [docs/EVALUATION.md](../../docs/EVALUATION.md)에 있다. 이 데이터로 제품을 실행해 본 적은 없다.

## 구조

```text
eval/golden/
  sources/            원문 SourceRecord (한 줄 = 한 (id, version))
    mail.jsonl          52줄
    wiki.jsonl          39줄
    messenger.jsonl     64줄
  labels/             정답 (모든 라벨에 evidence가 있다)
    entities.jsonl          92   엔티티(설계 §7의 타입)
    resolution_pairs.jsonl  56   엔티티 해소 쌍(같음 38, 다름 18)
    relations.jsonl         38   관계(연결해야 함 26, 연결하면 안 됨 12)
    temporal_facts.jsonl    64   시간 유효성이 있는 사실과 기대 상태
    insights.jsonl          17   기대 Insight 12개(추론 8, 명시 4)와 만들면 안 되는 Insight 5개(설계 §10의 타입)
    qa.jsonl                47   질문(답변 가능 40, 불가 7), 인정되는 답 사실, 필수 인용
    REVIEW_STATUS.md        독립 검토 상태와 절차 (사람 검토 전)
    review/second_review_machine.jsonl   라벨을 보지 않은 두 번째 기계 검토(원래 eval 12개 인스턴스)
  splits.json         dev/eval 분할 (시나리오 인스턴스 단위)
  tools/              데이터를 재생성하는 스크립트 (원본은 커밋된 JSONL)
```

회사, 사람, 팀, 프로젝트, 시스템은 전부 지어낸 것이다. 도메인은 `example.test`만 쓰고, 이름이 실제 사람과 닮았다면 우연이다. 실제 사내 데이터, 실제 회사·제품 이름은 들어 있지 않다.

## SourceRecord 필드

설계 §5의 필드에 세 개를 더했다.

| 필드 | 설명 |
|---|---|
| `id`, `external_id`, `source_url` | 레코드 식별자(`mail-0001`, `wiki-0001`, `msg-0001` 형식), 원 시스템 식별자, 가상 URL |
| `source_type` | `mail`, `wiki`, `messenger` 중 하나 |
| `title`, `content`, `author`, `participants`, `thread_id` | 본문과 작성자 정보. 메신저는 메시지 한 건이 레코드 하나이고 같은 `thread_id`로 묶인다 |
| `created_at`, `updated_at` | UTC 오프셋이 붙은 ISO-8601 시각. 시간대 시나리오는 이 오프셋을 의도적으로 다르게 썼다 |
| `content_hash` | `content`의 `sha256:<hex>` |
| `version` | 같은 `id`의 개정 번호. 개정은 줄이 하나 더 생긴다 |
| `access_scope` | 열람할 수 있는 주체 목록(`org:all`, `group:…`, `channel:…`, `user:…`) |
| `metadata` | 자유 필드(여기서는 비어 있음) |
| `connector_instance_id` | 수집한 커넥터 인스턴스. 같은 내용이 다른 커넥터로 다시 들어온 경우를 표현 |
| `operation` | `upsert`, `delete`(삭제 표시, `content`는 빈 문자열), `revoke`(내용은 그대로, `access_scope`가 좁아짐), `access-revoked`(이 PC의 사용자가 그 원본을 더는 볼 수 없음. 골든 데이터에는 없고 가져오기 형식(I01-R22)이 더한 값) |
| `schema_version` | 이 형식의 버전(`"1"`) |

## 시나리오

| 시나리오 | 인스턴스 | 무엇을 시험하는가 |
|---|---|---|
| `schedule_dependency_delay` | 4 | 목표일(A), 의존 관계(B), 의존 대상의 연기가 서로 다른 출처에 흩어진 경우. `S01-I1`이 설계 §10의 A/B 예시(완료 목표 2026-12-05, 의존 대상 연기 2026-12-10) |
| `same_name_different_people` | 4 | 같은 이름의 다른 사람(팀·회사·재직 시기가 다름)과 영문 표기가 같은 사람 |
| `abbreviation_two_meanings` | 3 | 같은 약어가 두 뜻(PG, SR, DR)으로 쓰인 경우 |
| `contradicting_statements` | 4 | 출처마다 날짜·담당자·수치가 다른데 어느 쪽이 맞는지 정해지지 않은 경우 |
| `correction_supersedes` | 4 | 정정 메일, 위키 개정, 메신저 수정이 앞선 사실을 대체하는 경우 |
| `deletion` | 4 | 원문 삭제 후 파생 지식이 사라져야 하는 경우와, 다른 출처가 있어 남아야 하는 경우 |
| `permission_revocation` | 3 | `access_scope`가 좁아져 일부 사용자에게는 답과 인용이 나가면 안 되는 경우 |
| `timezone_offsets` | 3 | 같은 시각의 다른 오프셋 표기, 날짜가 달라 보이는 마감, "내일"이 오프셋에 따라 다른 순간이 되는 경우 |
| `duplicate_threads` | 4 | 전달 메일, 재수집, 채널 교차 게시, 한 군데만 숫자가 다른 근접 중복 |
| `mixed_ko_en_same_concept` | 3 | 롤백/rollback/revert 처럼 한 개념을 한국어·영어·혼용으로 쓴 경우 |
| `distractor_noise` | 4 | 연결하면 안 되는 레코드(같은 이름의 식당, 이름이 비슷한 시스템, 무관한 지연) |

인스턴스 id는 `S01-I1` 형식(시나리오 번호-인스턴스 번호)이며 모든 라벨의 `scenario_instance`가 이를 가리킨다. 한 레코드는 한 인스턴스에만 속한다. 다른 인스턴스의 레코드는 서로에게 방해 문서가 된다(같은 이름 "가람"이 `S06-I1`, `S11-I1`에 모두 나온다).

## 라벨 형식

모든 라벨 줄은 `label_id`, `scenario_instance`, `evidence`를 가진다.

- **evidence**: `[{"record_id", "version", "span": [start, end], "quote"}]`. `span`은 `content`의 **유니코드 코드포인트** 위치이고 반개구간 `[start, end)`이다. `quote`는 `content[start:end]`와 정확히 같다. validator가 모든 근거를 검사한다.
- **entities**: `entity_id`(`S01-I1:proj` 형식, 인스턴스 안에서만 유일), `entity_type`(설계 §7의 지식 타입), `name`, `aliases`. `aliases`는 **그 인스턴스의 원문에 실제로 나오는 표기만** 적는다(validator가 검사). 선택 필드 `expected_absent: true`는 "삭제된 레코드만 근거인 엔티티이므로 제품이 드러내면 안 된다"는 표시이다(validator가 근거가 모두 삭제된 레코드인지 검사하고, scorer는 재현율에서 빼고 노출 수를 센다). 같은 대상의 값이 초안에서 확정으로 바뀐 경우처럼 값만 대체된 것은 엔티티를 나누지 않고 한 엔티티의 사실 값이 `superseded`로 바뀐 것으로 라벨링한다(`S09-I3`, 잠정 결정이며 사람 판정 대기).
- **resolution_pairs**: `mention_a`, `mention_b`(근거와 같은 형식), `entity_id_a`, `entity_id_b`, `same`. `same`은 두 id가 같은지와 일치해야 한다.
- **relations**: `subject`, `relation`(설계 §7의 대표 관계), `object`, `expected`(`false`면 "연결하면 안 됨"), `valid_from`, `valid_until`(둘 다 null이면 "기간이 정해지지 않은 관계"이고, 소속처럼 기간이 있는 관계만 값을 적었다).
- **temporal_facts**: `subject`, `attribute`(validator의 통제 어휘만), `value`(시각은 UTC), `valid_from`, `valid_until`(표기 규칙은 `docs/EVALUATION.md` §2.0의 5), `expected_status`, `supersedes`(대체하는 사실의 `label_id`), `as_of`, 선택 `trigger`. 상태는 설계 §6.7의 `candidate`/`verified`/`disputed`/`superseded`/`rejected`에 **이 데이터셋이 추가한** `removed`(원문 삭제로 사라져야 함)와 `restricted`(권한 철회로 일부 사용자에게 숨겨져야 함)를 더했다. `trigger`는 삭제·철회를 일으킨 레코드이다.
- **insights**: `insight_type`, `title`, `is_inference`(**한 출처가 결론을 명시하면 `false`**, 여러 출처를 종합해야만 얻는 결론이면 `true`), `affected_entities`, 선택 `expected: false`(만들어지면 안 되는 Insight), 선택 `trigger`.
- **qa**: `question`, `answerable`, `answer_facts`(인정되는 답의 사실), `evidence_role`. 답할 수 있으면 `required`(필수 인용), 없으면 `forbidden`(인용하면 안 되는 근거). 선택 `viewer`(질문하는 주체), 선택 `trigger`.

Insight 타입은 영어 이름으로 적었다. 설계 §10의 이름과 대응한다.

| 이름 | 설계 §10 |
|---|---|
| `important_work_change` | 중요 업무 변경 |
| `schedule_conflict` | 일정 충돌 |
| `dependency_delay` | 의존 업무 지연 |
| `decision_change` | 의사결정 변경 |
| `conflicting_information` | 상충되는 정보 |
| `unhandled_request` | 미처리 업무 요청 |
| `unresolved_issue` | 미해결 업무 이슈 |
| `similar_problem_resolution` | 유사한 문제의 해결 사례 |
| `related_document_discovery` | 관련 업무 및 기술 문서 발견 |
| `new_opportunity` | 새로운 업무 기회 |
| `policy_definition_change` | 업무 정의 및 정책 변화 |
| `new_relation_discovered` | 새롭게 발견된 중요한 정보 관계 |
| `possibly_missed_information` | 사용자가 놓쳤을 가능성이 있는 정보 |

현재 데이터에는 `important_work_change`, `schedule_conflict`, `dependency_delay`, `conflicting_information` 네 종류만 나온다. 나머지 타입의 라벨은 없다(알려진 한계 참고).

## 분할과 봉인

`splits.json`은 시나리오 인스턴스를 `dev`(개발·튜닝·ablation 단계 선택용, 22개)와 `eval`(최종 평가용, 18개)에 정확히 한 번씩 나눈다. 같은 인스턴스가 양쪽에 있을 수 없고, 한 레코드가 두 인스턴스에 속할 수도 없다(validator가 검사).

**봉인은 관례이다.** 이 저장소는 공개이므로 eval 라벨은 누구나 읽을 수 있다. 비밀이 아니라 "eval 인스턴스를 보고 튜닝하지 않는다"는 약속이다. 튜닝에 eval을 썼다면 결과 보고에 밝혀야 한다.

## 라벨을 만든 방법

1. 사람이 아닌 생성자(LLM)가 시나리오별로 가상 글을 쓰고 정답을 함께 정했다. 정답 값(날짜, 담당자, 관계)은 글 안에 있는 표현에서 정한 것이다.
2. 각 라벨의 `evidence`는 `tools/builder.py`가 글의 정확한 위치를 찾아 계산한다. 인용문이 글에 없으면 생성이 실패하므로 `quote`와 `span`이 어긋난 라벨은 만들어지지 않는다.
3. `python3 eval/scorer/validate.py eval/golden`이 스키마, 근거 일치, id 해소, 분할을 다시 검사한다.
4. 재생성은 `python3 eval/golden/tools/generate.py eval/golden`이며 같은 입력에서 같은 파일을 만든다. 단, **커밋된 JSONL이 원본**이고 스크립트가 원본을 대체하지 않는다. 라벨을 고칠 때는 스크립트와 JSONL을 함께 고치거나 JSONL만 고치고 스크립트를 폐기한다.
5. 사람의 독립 검토는 **아직 하지 않았다**. 원래 eval 12개 인스턴스의 쌍·관계·시간 사실·Insight는 라벨을 보지 않은 기계가 한 번 다시 만들어 비교했고(`labels/review/second_review_machine.jsonl`), 그 결과로 라벨 일부를 고쳤다. 상태와 절차는 [labels/REVIEW_STATUS.md](labels/REVIEW_STATUS.md).

## 알려진 한계

- **사람 검토 전**: 라벨은 생성자의 판단이다. 기계 두 번째 검토는 원래 eval 12개 인스턴스의 일부 라벨 종류만 덮는다(`labels/REVIEW_STATUS.md`). 점수는 "잠정 라벨 기준"이다.
- **크기**: 레코드 155줄, 인스턴스 40개. eval은 인스턴스 18개, 답변 가능 질문 17개, 연결해야 할 관계 14개로 작다. 통계적 결론에는 쓸 수 없다. `docs/EVALUATION.md`의 비율 통과선은 이 때문에 개수로 적혀 있다.
- **배치 유사**: 이번 재작업에서 더한 eval 인스턴스 6개 중 `S04-I4`, `S05-I4`, `S06-I4`, `S09-I4`는 dev의 짝(`S04-I1`, `S05-I1`, `S06-I2`, `S09-I1`)과 레코드 배치가 닮았다. `S02-I4`와 `S11-I4`만 배치와 문장을 다르게 썼다. dev에서 튜닝한 결과가 eval에서 덜 일반화되는지를 보기에는 이 짝들이 약하다.
- **문체**: 가상 글은 짧고 깔끔하다. 실제 업무 글의 노이즈(인용 사슬, 서명, 오탈자, 긴 문서)는 거의 없다.
- **Insight 범위**: 4종만 있고 인스턴스당 많아야 1~2개다. 사람 평가 지표(관련성, 참신성, 실행 가능성)용 데이터는 없다.
- **정렬 없음**: 제품이 만든 엔티티를 정답 엔티티에 대응시키는 규칙은 이 저장소에 없다(`docs/EVALUATION.md` §6).
- **형식 범위**: PDF, DOCX 등 파일 형식 파싱은 다루지 않는다. `metadata`는 비어 있다.
- **중복 채점은 보수적**: 중복 레코드의 정답 근거는 원본만이다. 복사본 인용은 틀린 인용으로 센다.
- **시간 표현**: 상대 날짜("내일", "어제")는 레코드의 `created_at` 오프셋으로 풀어야 정답과 맞는다.
