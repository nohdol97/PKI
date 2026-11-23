# verification — 배포처 실행용 검증 키트 (사외 준비물)

> **이 폴더의 모든 스크립트는 "작성만 됨 — 실행된 적 없음" 상태입니다.** 실제 claude·codex CLI, 후보 엔진, 임베딩 모델, 설치 파일에 대해 한 번도 실행하지 않았습니다. 사외에서 돌린 것은 가짜 대상에 대한 단위 테스트뿐이며 **그 통과는 배포처 실행 증거가 아닙니다**(이슈 #37). 실행 결과가 이슈 #11, #12, #13에 기록될 때 비로소 해당 완료 기준이 충족됩니다.

## 왜 이렇게 나뉘어 있나

제품과 후보를 실제로 돌리는 검증은 Windows 11과 CLI가 있는 배포처에서만 할 수 있습니다. 그래서 사외에서는 스펙, 실행 스크립트, 절차서, 결과 양식까지 준비하고, 배포처 담당자가 **합성 데이터만으로** 실행해 결과를 이슈에 붙입니다(이슈 #37의 방침). 스펙은 `docs/specs/2026-11-21-R02-*.md`, `R03`, `R04`에 있고, 기준별로 "키트가 준비한 것"과 "배포처에 남은 공백"이 표로 적혀 있습니다.

배포처 담당자가 사람이 직접 해야 하는 후속 항목(R02-S1 … R04-S3)과 각 항목이 필요로 하는 것은 [SITE_FOLLOWUPS.md](SITE_FOLLOWUPS.md)에 있습니다.

## 무엇을 어떤 순서로 실행하나

| 순서 | 키트 | 절차서 | 하는 일 | 결과를 붙일 이슈 |
|---|---|---|---|---|
| 1 | `r02-cli-isolation/` | [RUNBOOK](r02-cli-isolation/RUNBOOK.md) | CLI 정상·미설치·미로그인 경로, 악성 문서 부정 테스트, 프로세스 종료 | #11 |
| 1' | (사람) | [TERMS_CHECKLIST](r02-cli-isolation/TERMS_CHECKLIST.md) | 약관·벤더 확인(R02-C4) | #11 |
| 2 | `r03-engine-comparison/` | [RUNBOOK](r03-engine-comparison/RUNBOOK.md) | 엔진 시나리오, 임베딩, 저장소 비교, 내구성. **R02 결과가 먼저 필요**(엔진의 CLI 호출은 R02 통과 프로필만) | #12 |
| 3 | `r04-windows-installer/` | [RUNBOOK](r04-windows-installer/RUNBOOK.md) | 설치 파일 측정·점검. **V01 skeleton 설치 파일이 있어야 함** | #13 |
| 4 | (사람) | 각 이슈 + #37 | 결과를 잠정 ADR의 가정과 대조(R07) | #37 |
| 5 | `v02-site-flow/` | [RUNBOOK](v02-site-flow/RUNBOOK.md) | V02 흐름을 R04 설치 파일로 설치한 앱과 실제 Provider로 실행하고 기록(S14). **R04 설치 파일이 있어야 함**. test double이거나 설치본이 아니면 `배포처 후속` 알림(종료 값 3) | #17 |

R02(약관 확인 포함)와 R04는 서로 독립이라 병행할 수 있습니다. R03의 엔진 시나리오만 R02가 끝나야 하고, R04는 V01 설치 파일만 있으면 되며 R04-C2만 R03 통과 후보가 필요합니다.

모든 하위 명령은 `--dry-run`으로 "무엇이 실행되고 어떤 파일이 생길지"를 먼저 볼 수 있습니다(R02는 이 모드만 사외에서 실행했습니다).

## 결과 파일은 무엇인가

각 키트의 `--out` 폴더에는 두 종류가 생깁니다. **붙여 넣어도 되는 것은 `result.json`과 `result.md` 한 쌍뿐입니다.** `raw/` 폴더는 **로컬 전용이며 절대 붙이거나 커밋하지 않습니다**(`.gitignore`가 제외하고, 폴더 안에 `README_NEVER_PASTE.txt`가 있습니다).

| 파일 | 붙여도 되나 | 들어 있는 것 |
|---|---|---|
| `result.json`, `result.md` (스키마 버전 2) | 예 | 하네스가 직접 만든 값만: 검사 id, 정해진 판정어, 숫자, 참/거짓, 정해진 이유 코드, 고정 목록의 단어와 엄격한 형식의 버전·해시 |
| `raw/*` (CLI·엔진 출력 꼬리, 이름, 스냅샷, predictions, R04 `result-raw.json`) | **아니오** | 원본 출력, 폴더·프로그램 이름, 경로 등 식별될 수 있는 모든 것 |

**모든 문자열 자리는 코드에 선언된 고정 목록으로 닫혀 있습니다.** 검사 id, 지표 이름, `facts`의 키는 고정 등록부에 있어야 하고(새 항목은 코드 변경이 필요), 값 문자열은 고정 어휘에서만 나옵니다. 예외는 키가 정한 한 가지 형식뿐입니다: 버전(`MAJOR.MINOR.PATCH`와 알려진 단어의 prerelease만; 그 밖은 `unknown`과 안내 코드), `model`(알려진 공급사 모델 계열만; 아니면 해시), 해시 자리. 검증이 실패해도 실행은 사라지지 않습니다: `raw/`는 그대로 쓰이고 붙이는 쌍은 INCONCLUSIVE 최소 결과로 대체됩니다(종료 코드 5).

설계 이유: 식별 값을 찾아 지우는 방식(차단 목록)은 완전할 수 없습니다. 그래서 붙이는 파일은 **허용 목록**으로만 만듭니다. CLI·엔진·설치 파일·환경·경로·폴더 이름에서 온 자유 문장은 이 파일에 들어갈 수 없고, 스키마 검사가 허용되지 않은 문자열·키를 거부합니다. 그 위에 정규식 마스킹을 두 번째 방어선으로 한 번 더 걸고, 이 PC의 호스트·사용자·도메인·홈 값이 남아 있으면 파일을 쓰지 않고 실패합니다.

- 판정 어휘: `PASS`, `FAIL`, `BLOCKED`(격리 깨짐, 자동 실행 금지), `INCONCLUSIVE`(시험이 안 돌아 판단 불가), `NOT_RUN`, `NOT_APPLICABLE`. 읽을 수 없는 값은 절대 PASS로 바뀌지 않습니다.
- 이름이 짧은 계정(두 글자 이하)은 단어 전체로만 가립니다. 계정 이름이 하네스 단어 안에 들어 있어 쓰기가 막히면 시험용 계정 이름을 바꿉니다.
- 사람 이름(한글 포함), 전화번호, 회사 이름은 패턴으로 찾을 수 없습니다. 붙이는 파일에는 자유 문장이 없으므로 들어가지 않지만, `raw/`에는 있을 수 있어 붙이지 않습니다.
- 프록시·사설 인증서를 쓰는 배포처는 R02·R03의 `--pass-env HTTPS_PROXY --pass-env NODE_EXTRA_CA_CERTS`처럼 변수 **이름**을 지정해 자식 프로세스에 넘길 수 있습니다(값은 기록하지 않고 이름만 결과에 남음). 기본값은 넘기지 않습니다.

## 이슈에 붙이는 방법

1. 키트 폴더의 `RESULT_TEMPLATE.md`를 열어 실행일, 고정 버전, 명령을 채웁니다.
2. `result.md`(R04는 `python run.py sanitize`로 만든 것)를 이슈 댓글에 붙입니다. 길면 `result.json`의 `checks`만 붙여도 됩니다.
3. 기준별 표(`R02-C1`…)의 "충족 이유"와 "미검증 범위"를 사람이 적습니다. 실행하지 못한 항목은 "미검증"으로 남기고 지우지 않습니다.
4. 공개 저장소의 이슈에는 **합성 입력의 결과와 환경 일반 정보(OS 빌드, CPU/RAM 등급, CLI 버전)** 만 올립니다.

### 붙이면 안 되는 것

- `raw/` 폴더 전체(원본 출력, predictions, R04 `result-raw.json`, 스냅샷, 남은 항목 이름)
- 호스트 이름, 사용자 이름, 계정 이메일, 사내 주소·프록시, 홈 폴더 경로, 사내 URL
- 로그인 정보, 토큰, API 키, 인증 파일(`auth.json` 등)의 내용이나 모양
- 실제 업무 문서·메일·메신저 내용(합성 fixture 이외 모든 것)
- R04에서 `python run.py sanitize`를 거치지 않은 PowerShell 원본 결과

의심스러우면 붙이지 않습니다.

## 스크립트 전체 목록

상태 열은 전부 같습니다: **작성만 됨 — 실행된 적 없음**(실제 대상 기준). "단위 테스트"는 사외 기기에서 가짜 대상으로만 돌렸다는 뜻입니다.

| 파일 | 용도 | 실제 대상에 대한 상태 |
|---|---|---|
| `common/runner.py` | 인자 배열 실행, 시간 제한, 프로세스 트리 종료(Windows Job Object·`taskkill /T /F`), 최소 환경 | 작성만 됨 — 실행된 적 없음 (POSIX는 단위 테스트, Windows 분기는 한 번도 실행 안 됨) |
| `common/redact.py`, `results.py`, `fingerprint.py`, `procinfo.py`, `jsonschema_lite.py` | 2차 마스킹, 허용 목록 결과 스키마와 쓰기·검증, 환경 지문, 프로세스 표·메모리, 스키마 검사 | 작성만 됨 — 실행된 적 없음 (Windows 분기 미실행) |
| `r02-cli-isolation/run.py` | `detect`/`capabilities`/`positive`/`negative`/`cancel`/`not-installed`/`not-logged-in`/`all`/`--dry-run` | 작성만 됨 — 실행된 적 없음 (`--dry-run`과 가짜 CLI만 실행) |
| `r02-cli-isolation/profiles.json`, `profiles.py` | 이름 붙은 argv 프로필과 점검 | 작성만 됨 — 실행된 적 없음 |
| `r02-cli-isolation/negative.py`, `judge.py`, `cli_ops.py` | 악성 문서 시험, 격리 판정기, 감지·능력·종료 | 작성만 됨 — 실행된 적 없음 |
| `r02-cli-isolation/helpers/mcp_stub.py`, `hook_marker.py` | 관찰용 가짜 MCP 서버, hook 마커 | 작성만 됨 — 실행된 적 없음 |
| `r03-engine-comparison/run.py` | `plan`/`install-steps`/`inspect-golden`/`scenario`/`shim`/`cli-adapter`/`embed`/`embed-offline-check`/`storage-compare`/`durability` | 작성만 됨 — 실행된 적 없음 |
| `r03-engine-comparison/scenario.py`, `engine_adapter.py`, `llm_gateway.py`, `shim_server.py` | 시나리오 러너, 어댑터 규약, 호출 계수와 R02 게이트, 루프백 shim | 작성만 됨 — 실행된 적 없음 |
| `r03-engine-comparison/adapters/{lightrag,cognee,sage_wiki}_adapter.py` | 엔진 어댑터 뼈대(호출 미확정) | 뼈대 — 실행된 적 없음, 호출은 `미구현` |
| `r03-engine-comparison/store.py`, `durability.py` | 시간 저장소 비교(제품 SQLite 구현, cortexdb 뼈대), 내구성 점검 | 작성만 됨 — 실행된 적 없음 (SQLite는 임시 파일로 단위 테스트) |
| `r03-engine-comparison/embedding_bench.py`, `embed_workers/*.py` | 임베딩 벤치 러너, 워커 뼈대 2종 | 러너는 작성만 됨, 워커는 뼈대 — 실행된 적 없음 |
| `r04-windows-installer/run.py`, `sanitize_result.py` | 순서 안내, 결과 2차 마스킹 | 작성만 됨 — 실행된 적 없음 |
| `r04-windows-installer/scripts/01..08-*.ps1`, `common.ps1` | 설치·측정·점검 PowerShell | 작성만 됨 — 실행된 적 없음, **구문 검사도 못 함** |
| `v02-site-flow/run.py`, `run_record.py` | V02 배포처 검증 실행기(`preflight`/`prepare`/`record`/`summarize`)와 실행 기록 양식 v1 | 작성만 됨 — 실행된 적 없음 (거부 경로와 기록 양식만 단위 테스트, Windows 분기 미실행) |
| `v02-site-flow/delete_scenario.py`, `delete-config.example.json` | I04 삭제 시나리오(`run.py delete-scenario preflight`/`prepare`/`record`, S22): 카나리 세 개, 무효화 기록 세기, 데이터 폴더 전체 카나리 찾기 | 작성만 됨 — 실행된 적 없음 (거부 경로·찾기·판정·기록 형식만 합성 자료로 단위 테스트, Windows 분기와 실제 수집기 미실행) |
| `v02-site-flow/queue_scenario.py`, `queue-config.example.json` | I03 큐·스케줄러 복구 시나리오(`run.py queue-scenario preflight`/`prepare`/`record --scenario kill\|sleep\|hibernate\|clock-forward\|clock-back\|timezone`, S19): 정본 작업 표를 읽기 전용으로 읽어 효과 행·합쳐진 slot·다시 집힌 작업을 세고 판정, 절전·최대 절전은 사람이 적는 수동 확인 기록 필요 | 작성만 됨 — 실행된 적 없음 (두 거부 경로·판정·기록 형식만 합성 자료로 단위 테스트, Windows 분기와 실제 절전·강제 종료·시계 변경 미실행) |
| `v02-site-flow/scopes_check.py`, `scopes-config.example.json` | I07 설치본 범위 확인(`run.py scopes-check --config --expected --out`, S31): 정본 `connector_instances.configured_scope`를 읽기 전용으로 읽어 포크의 범위 파일과 견주고 `PASS`·`FAIL`·`INCONCLUSIVE`와 수 넷을 기록(값·ID 없음) | 작성만 됨 — 실행된 적 없음 (거부 경로·판정·기록 형식만 합성 자료로 단위 테스트, Windows 설치본과 실제 포크 미실행) |
| `tests/` | 위 코드의 단위 테스트(가짜 CLI, 가짜 엔진, 가짜 워커) | 사외 기기에서 통과 — 배포처 증거 아님 |

## 사외 단위 테스트 실행

```text
python3 -m unittest discover -s verification -p 'test_*.py' -v
```

표준 라이브러리만 씁니다. 하네스에 서드파티 패키지가 없습니다.
