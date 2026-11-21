# R03 절차서: 엔진·임베딩·저장소 비교 (배포처 실행용)

> **상태: 작성만 됨 — 실행된 적 없음.** 후보 엔진은 설치하지도, import하지도, 실행하지도 않았습니다. 어댑터 3종은 **뼈대**이며 상류(upstream, 후보 프로젝트) API 호출이 확인되지 않은 곳은 `NotImplementedError`로 비워 두었습니다. 사외 단위 테스트(가짜 엔진, 가짜 임베딩 워커, SQLite 임시 파일)는 배포처 실행 증거가 아닙니다(이슈 #37). 근거: [OSS 평가](../../docs/OSS_EVALUATION.md) 5절·7절, 스펙: [R03 스펙](../../docs/specs/2026-11-21-R03-engine-comparison.md).

## 1. 이 검증이 하는 일

문서를 넣고(import) 사실을 뽑고(추출) 서로 잇고(관계) 일부를 고치고(증분 수정) 지우고(삭제) 프로그램을 껐다 켜도(재시작) 결과가 올바른지, 그때 LLM을 몇 번 부르고 시간·메모리·디스크를 얼마나 쓰는지를 후보 엔진 3종(LightRAG, cognee, sage-wiki)에 같은 입력으로 잽니다. 임베딩 모델 2종(BAAI/bge-m3, intfloat/multilingual-e5-base)의 속도·메모리와 검색 결과 파일을 만들고, 시간 그래프 저장은 cortexdb와 제품이 직접 소유하는 SQLite 구조를 같은 시험에 겁니다.

## 2. 처음 나오는 말

| 말 | 뜻 |
|---|---|
| 엔진 | 문서에서 지식을 뽑아 저장·검색해 주는 오픈소스 프로그램(여기서는 후보 3종) |
| 어댑터 | 서로 다른 엔진을 같은 모양(`ingest`, `update`, `delete`, `query`, `export`, `restart`)으로 다루게 하는 중개 코드. 후보마다 하나 |
| 탐침 질의 | 엔진 내부 표현과 무관하게 "이 질문을 하면 이 문서가 나와야 한다/나오면 안 된다"를 확인하는 질문. `verification/fixtures/records/probes.json` |
| 증분 수정 | 바뀐 문서만 다시 처리하는 것. 바뀌지 않은 부분까지 LLM을 다시 부르면 낭비입니다 |
| 게이트웨이 | 엔진이 하는 모든 LLM 호출이 지나가는 관문. 호출 횟수를 셉니다. 본문은 저장하지 않습니다 |
| shim | 두 프로그램의 모양 차이를 메우는 얇은 중개기. 여기서는 CLI를 "OpenAI 호환 서버"처럼 보이게 하는 로컬(127.0.0.1) 서버 |
| predictions 파일 | 질문마다 검색된 문서 순위를 적은 JSON Lines 파일. `eval/scorer/score.py`가 점수를 냅니다 |
| WAL, 단일 writer | SQLite가 읽기와 쓰기를 동시에 허용하는 방식(WAL)과 한 번에 한 쓰기만 허용하는 성질 |

## 3. 선행 조건

1. **R02가 끝나 있어야 합니다.** 엔진의 LLM 호출은 R02에서 `CONTAINED_ON_OBSERVABLES`로 판정된 CLI 프로필만 씁니다. 판정이 없거나 BLOCKED이거나 CLI 버전이 달라졌으면 하네스가 실행을 거부합니다(`--r02-result`).
2. 평가 데이터 `eval/golden/`와 채점기 `eval/scorer/`가 이 저장소에 있어야 합니다(`docs/r05-golden-dataset` 브랜치 기준으로 필드 이름을 확인해 반영했습니다). 레코드는 `sources/*.jsonl`의 `id`/`content`/`version`/`operation`, 질문은 `labels/qa.jsonl`의 `label_id`/`question`/`scenario_instance`, 분할은 `splits.json`의 `splits.dev|eval`(시나리오 인스턴스 목록)입니다. 데이터가 바뀌어 필드가 달라지면 `python run.py inspect-golden --golden eval/golden`으로 실제 필드를 보고 `--field-map map.json`으로 맞춥니다.
3. **네트워크 설치는 배포처 승인이 필요합니다.** `python run.py install-steps`로 고정 버전과 명령을 봅니다. 후보 하나당 가상환경 하나를 따로 만듭니다(서로의 의존성이 섞이지 않게). LightRAG는 release 1.5.7을 1순위, HEAD를 2순위로 적었고 어느 것을 돌렸는지 결과에 씁니다. 모델 내려받기도 승인 대상입니다.

## 4. 순서

폴더는 `verification/r03-engine-comparison`입니다. 먼저 `python run.py plan`으로 전체 순서와 "근거 없는 호출 목록"을 봅니다.

| 단계 | 명령 | 기준 | 비고 |
|---|---|---|---|
| 1 | `python run.py storage-compare --store sqlite --workdir w/s` | R03-C4 | 제품 SQLite 구조의 표준 시험(시간 유효성, span 근거, 삭제, export). 이 PR에서 구현 완료 |
| 2 | `python run.py durability --target sqlite --workdir w/d` | R03-C4 | crash(쓰는 도중 프로세스 트리를 강제 종료한 뒤 무결성 확인), 동시 읽기, 단일 writer |
| 3 | `python run.py embed --model bge-m3 --backend fastembed --dataset golden` (모델마다) | R03-C3 | 워커(S5)를 먼저 완성해야 함. 아니면 `미구현, 배포처 후속` 안내 |
| 4 | `python run.py embed-offline-check --model bge-m3 --backend fastembed --cache-dir <캐시>` | R03-C3 | 내려받은 뒤 오프라인 변수로 다시 실행, 라이선스 파일의 이름·크기·해시만 기록 |
| 5 | `python run.py cli-adapter --r02-result ..\r02-cli-isolation\r02-result\result.json --profile <R02 통과 프로필> --model <모델>` | R03-C2 | 게이트 확인 + 구조화 호출 1회 |
| 6 | 어댑터 완성(아래 5절) 뒤 `python run.py scenario --engine lightrag --workdir w/l --r02-result ... --profile ... --model ...` (엔진마다) | R03-C1 | cognee는 먼저 `python run.py shim ...`로 shim을 띄우고 cognee가 그 주소를 쓰게 설정 |
| 7 | `python run.py storage-compare --store cortexdb --workdir w/c` | R03-C4 | S4 완성 전에는 안내만 출력 |

`--dry-run`을 모든 하위 명령에 붙여 무엇을 할지 먼저 볼 수 있습니다. 결과는 `--out`(기본 `r03-result`)의 `result.json`과 `result.md` 한 쌍입니다.

## 5. 어댑터 뼈대를 완성하는 방법 (R03-S1~S5)

`adapters/*.py`의 `PLANNED_CALLS`는 계획한 호출마다 OSS 평가의 근거 링크를 붙였습니다. **근거가 `None`인 호출은 추측하지 않고 비워 두었습니다**(`python run.py plan`이 목록을 보여 줍니다). 완성 절차:

1. 설치한 고정 버전의 공식 문서·소스에서 그 호출을 확인한다(링크를 `PLANNED_CALLS`의 evidence에 적는다).
2. 해당 메서드의 `SiteTodo`를 실제 호출로 바꾼다. 모든 LLM 호출은 `setup`에서 받은 `gateway`를 지나게 한다. API 키를 몰래 넣지 않는다.
3. 시나리오를 돌려 결과를 확인하고, 확인하지 못한 것은 결과에 "미확인"으로 남긴다.

cognee는 구조화 출력 방식(tools 호출인지 json schema인지)이 확인되지 않았습니다. shim이 `tools` 요청을 501로 거절하고 그 종류를 기록하므로, 종료 때 출력되는 "refused request kinds"를 이슈에 적으면 다음 단계가 정해집니다.

## 6. 결과 읽는 법과 주의

- 각 시나리오 단계의 판정은 탐침 질의 기준입니다. FAIL이면 `data.checks`에서 어떤 확인이 틀렸는지 봅니다("forbidden source", "stale text" 등).
- `unverified`로 나온 확인(예: export 미구현)은 통과가 아닙니다.
- 검색 **품질**은 이 키트가 아니라 `eval/scorer/score.py`가 판정합니다. `embed --dataset golden --split dev`는 predictions를 만든 뒤 `python3 eval/scorer/score.py eval/golden <predictions> --split dev`를 자동으로 실행하고 그 JSON의 `retrieval`을 결과에 남깁니다. 스키마는 `{"kind":"retrieval","query_id":<qa label_id>,"ranked":[레코드 id 순위]}`입니다. 채점기는 답할 수 있는 질문만 센다는 점, `access_scope`/`viewer`를 쓰지 않는다는 점을 알아 둡니다. eval 분할은 관례상 봉인되어 있으므로 튜닝에 쓰지 않습니다.
- 임베딩 대상 문서는 각 `id`의 최신 버전이고, 마지막 작업이 `delete`인 레코드는 제외합니다. 언어(ko/en/mixed)는 데이터에 필드가 없어 한글 글자 비율로 추정합니다(`guess_lang`).
- e5 모델의 `query: `/`passage: ` 접두어와 bge-m3의 접두어 없음은 모델 카드 관례를 `models.json`에 적은 것이며 **미확인**입니다. 점수를 믿기 전에 모델 카드와 대조합니다.
- 내려받은 모델의 HF 커밋 SHA를 결과에 적습니다(고정되어 있지 않음).
- crash 점검은 SQLite 구조에서만 구현되어 있습니다. 엔진의 crash·동시 읽기·단일 writer 점검은 어댑터 완성 뒤 같은 절차를 엔진 호출로 바꿔 실행합니다(`durability.py`의 `EngineTarget`).
- 삭제 점검의 핵심은 **공유 사실**입니다. 문서 s1과 s2가 같은 사실을 말할 때 s1을 지워도 s2를 통해 사실이 남아야 하고, s1은 어디에도 참조되면 안 됩니다. cortexdb는 삭제 뒤에도 이력 행이 남는 것으로 읽히므로(OSS 평가 7절) 그 행이 지워지는지가 확인 대상입니다.

## 7. 하지 말아야 할 것

- 실제 업무 문서를 넣지 않습니다(합성 fixture 또는 `eval/golden`).
- R02 판정이 없는 CLI 프로필, 대조(control) 프로필로 엔진을 돌리지 않습니다.
- 모델 API 키를 설정에 넣지 않습니다(R03-C2: 몰래 추가 금지).
- 승인 없이 pip, 모델, 릴리스를 내려받지 않습니다.

결과 기록: [결과 양식](RESULT_TEMPLATE.md).
