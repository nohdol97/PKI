# V02 배포처 검증 절차서: 수직 흐름을 Windows 설치본과 실제 Provider로 (S14)

> **상태: 작성만 됨 — Windows에서 실행된 적 없음.** 사외에서는 거부 두 경우와 기록 양식만 단위 시험으로 돌렸고, 그 통과는 배포처 결과가 아닙니다. **R04의 설치 파일이 아직 없습니다.** 설치 파일이 생기기 전에는 V02-C4를 충족할 수 없습니다.
>
> 스펙: [V02 spec "T12가 넘기는 것"](../../docs/specs/2026-11-21-V02-vertical-slice.md), 배포처 항목: [site-setup.md S14](../../docs/site-setup.md).

## 1. 이 검증이 하는 일

V02의 흐름(합성 출처 3개 가져오기 → "의존 업무 지연" Insight가 "추론"으로 표시 → 근거 3개를 원본 version과 글자 위치까지 열기 → 같은 파일 재입력 → 앱 재시작 뒤에도 그대로)을 **R04의 설치 파일로 설치한 앱**에서 **실제 Provider**로 실행하고, 결과를 test double의 E2E 기록과 구분되는 기록으로 남깁니다.

설치본은 디버깅 스위치가 있으면 시작하지 않으므로 화면을 자동으로 몰 수 없습니다. 화면 걸음은 사람이 하고, 실행기(`run.py`)는 시작 조건을 확인하고 입력 파일을 만들고, 끝난 뒤 앱의 정본 DB를 **읽기 전용으로** 세어 기록합니다.

## 2. 처음 나오는 말

| 말 | 뜻 |
|---|---|
| 실제 Provider | 앱이 실제로 부르는 LLM 경로. `openai-compatible`(API 키 Provider, S05) 또는 검증된 조합 목록에 있고 백그라운드 실행을 켠 CLI(`claude-code`, `codex`, S07) |
| test double | 정해 둔 답을 돌려주는 시험용 가짜 Provider. E2E(`v02-flow.e2e`)가 쓰며, 이 실행기는 그것으로는 기록하지 않습니다 |
| 정본 DB | 앱의 데이터 폴더(`%LOCALAPPDATA%\PKI\pki.sqlite`)에 있는 SQLite 파일 |
| 버린 수 | 추출 응답의 인용문이 원문과 맞지 않아 버린 사실·관계의 수(`dropped_quotes`)와 그 밖에 버린 수(`dropped_other`). 기준 없이 기록만 합니다(A21) |

## 3. 준비

1. S10이 끝난 깨끗한 Windows 11(스냅샷)에 **R04의 설치 파일로** 앱을 설치합니다. 데이터 폴더 `%LOCALAPPDATA%\PKI`가 **비어 있어야** 합니다(앱을 한 번도 켜지 않은 상태, 또는 그 폴더를 지운 상태).
2. 이 저장소(배포처 포크)를 받은 폴더와 Python 3(표준 라이브러리만 씀).
3. `config.example.json`을 `config.json`으로 복사해 채웁니다: 제거 목록의 제품 이름(`productName`), 설치된 exe 경로(`installedExe`), 앱에서 기본 Provider로 고를 실제 Provider(`provider.id`와 버전).
4. 합성 자료만 씁니다. 실제 업무 자료를 넣지 않습니다.

## 4. 순서

저장소 루트에서 실행합니다. 결과 폴더는 `v02-result`(gitignore됨)를 씁니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py preflight --config config.json` | `preflight ok: installed app <버전>, provider <id>`. `배포처 후속`으로 시작하는 알림이 나오면(종료 값 3) 그 이유를 고치고 다시 합니다 |
| 2 | `python verification\v02-site-flow\run.py prepare --config config.json --out v02-result` | `v02-result\v02-plain.jsonl`과 `run-state.json`이 생김. 정본 DB가 이미 있으면 종료 값 4 |
| 3 | 앱을 켜고 설정 화면에서 `config.json`의 Provider를 기본 Provider로 고르고 동의합니다(CLI라면 백그라운드 실행도 켬). 연결 시험이 성공하는지 봅니다 | |
| 4 | 원본 화면에서 `v02-plain.jsonl`을 가져오고, 추출이 끝날 때까지 기다린 뒤 홈을 엽니다 | Insight 1건, "추론" 표지, "확정" 표지 없음 → `insight-inference` |
| 5 | 근거 3개를 하나씩 엽니다 | 각 근거가 원본 version과 강조된 글자를 보임 → `evidence-opened` |
| 6 | 같은 파일을 다시 가져옵니다 | 새 version 0건, 홈의 Insight 그대로 1건 → `reimport-no-new` |
| 7 | 앱을 완전히 닫았다가 다시 켜서 홈과 근거를 엽니다. 그다음 **앱을 닫습니다** | 같은 Insight와 근거 3개 → `restart-kept` |
| 8 | `python verification\v02-site-flow\run.py record --config config.json --out v02-result --observed insight-inference --observed evidence-opened --observed reimport-no-new --observed restart-kept` (확인한 것만 적습니다) | `V02-C4:site-flow PASS`(종료 값 0). 수가 다르면 `FAIL`, 관찰이 빠지면 `INCONCLUSIVE`(종료 값 1) |

`record`는 정본 DB의 성공한 호출이 설정한 Provider 말고 다른 Provider(시험용 `local-model` 포함)의 것이면 기록하지 않고 `배포처 후속` 알림으로 끝나며, `prepare`보다 먼저 생긴 호출 행이 있으면 지난 데이터로 보고 종료 값 4로 끝납니다.

## 5. 판정

`PASS`는 정본의 수가 E2E와 같고(원본 version 3, Insight 행 1, 활성 Insight 1, `succeeded`가 아닌 작업 0), 설정한 Provider의 성공 호출이 3 이상이며, 관찰 넷을 모두 적었을 때만입니다. 버린 수는 판정에 쓰지 않고 적습니다.

## 6. 결과 붙이기

- 붙이는 것: `v02-result\result.md`(또는 `result.json`). 허용 목록의 값만 들어 있습니다: Provider 종류 `real`, Provider id, 버전(알려진 형식이 아니면 해시 `h:…`), 앱 버전, 정본의 수, 버린 수, 관찰 단어.
- 붙이지 않는 것: `v02-result\raw\` 전체(`run-record.windows-installer.json`에는 OS 문자열과 설정 값이 그대로 있음), `config.json`, `v02-plain.jsonl` 밖의 자료.
- [RESULT_TEMPLATE.md](RESULT_TEMPLATE.md)를 채워 이슈 #17에 붙입니다.

## 7. 이 절차가 확인하지 못하는 것

- 화면 걸음은 사람의 관찰입니다. 실행기는 화면을 보지 못합니다.
- 실행 중에 앱이 내보낸 연결은 보지 않습니다(S08, R02-S2).
- 품질(정확도)의 합격선은 없습니다(R05). 실제 업무 자료의 품질은 S15입니다.
