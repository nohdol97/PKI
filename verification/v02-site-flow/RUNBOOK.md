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

1. S10이 끝난 깨끗한 Windows 11(스냅샷)에 **R04의 설치 파일로** 앱을 설치합니다. 데이터 폴더 `%LOCALAPPDATA%\PKI`가 **비어 있어야** 합니다(앱을 한 번도 켜지 않은 상태, 또는 그 폴더를 지운 상태). 이 PC에서 `apps\desktop\dist\app`이나 원본 실행(`pnpm --filter @pki/desktop start`)으로 앱을 켜지 않습니다. 같은 데이터 폴더를 쓰기 때문입니다(7절).
2. 이 저장소(배포처 포크)를 받은 폴더와 Python 3.8 이상(표준 라이브러리만 씀). `python --version`으로 확인합니다. Windows의 `python3`는 Store 바로 가기일 수 있으니 아래 명령은 `python`을 씁니다.
3. 저장소 루트에 결과 폴더 `v02-result`(gitignore됨)를 만들고, `config.example.json`을 `v02-result\config.json`으로 복사해 채웁니다: 제거 목록의 제품 이름(`productName`), 설치된 exe 경로(`installedExe`), 앱에서 기본 Provider로 고를 실제 Provider(`provider.id`, `provider.name`(id와 같게), `provider.version`). 저장소 안 다른 곳에 두지 않습니다(작업 트리가 바뀐 것으로 기록되고 실수로 커밋될 수 있음).
4. 합성 자료만 씁니다. 실제 업무 자료를 넣지 않습니다.

## 4. 순서

저장소 루트에서 실행합니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py preflight --config v02-result\config.json` | `preflight ok: installed app <버전>, provider <id>`. 표준 출력에 `배포처 후속`으로 시작하는 알림이 나오면(종료 값 3) 그 이유를 고치고 다시 합니다 |
| 2 | `python verification\v02-site-flow\run.py prepare --config v02-result\config.json --out v02-result` | `v02-result\v02-plain.jsonl`과 `run-state.json`이 생김. 정본 DB가 이미 있으면 종료 값 4 |
| 3 | 앱을 **설치된 exe로만** 켭니다(시작 메뉴 바로 가기 또는 `installedExe`. 이 절차의 모든 시작에 같음). 설정 화면에서 `config.json`의 Provider를 기본 Provider로 고르고 동의합니다. **`openai-compatible`**: `providers.openaiCompatible.baseUrl`(`https` 주소)과 `providers.openaiCompatible.model`을 설정하고 API 키를 앱에 입력합니다(S05). 앱에 넣은 모델 이름을 `config.json`의 `provider.version`에 **글자 그대로** 적습니다(실행기는 이 일치를 확인하지 못하며 사람의 기록입니다). **CLI**: 검증된 조합 목록에 있는 버전(S07)을 쓰고 백그라운드 실행을 켭니다. `provider.version`은 그 CLI 버전입니다. 연결 시험은 **설정한 Provider로만** 합니다(연결 시험은 수에 들어가지 않습니다) | 연결 시험 성공. 설치본으로 켰다 → `launched-installed` |
| 4 | 원본 화면에서 `v02-plain.jsonl`을 가져오고, 추출이 끝날 때까지 기다린 뒤 홈을 엽니다 | Insight 1건, "추론" 표지, "확정" 표지 없음 → `insight-inference` |
| 5 | 근거 3개를 하나씩 엽니다 | 각 근거가 원본 version과 강조된 글자를 보임 → `evidence-opened` |
| 6 | 같은 파일을 다시 가져옵니다 | 새 version 0건, 홈의 Insight 그대로 1건 → `reimport-no-new` |
| 7 | 앱을 완전히 닫았다가(알림 영역 포함) 설치된 exe로 다시 켜서 홈과 근거를 엽니다. 그다음 **앱을 완전히 닫습니다** | 같은 Insight와 근거 3개 → `restart-kept` |
| 8 | `python verification\v02-site-flow\run.py record --config v02-result\config.json --out v02-result --observed launched-installed --observed insight-inference --observed evidence-opened --observed reimport-no-new --observed restart-kept` (확인한 것만 적습니다) | `V02-C4:site-flow PASS`(종료 값 0). 수가 다르면 `FAIL`, 관찰이 빠지면 `INCONCLUSIVE`(종료 값 1). DB가 잠겼다는 안내가 나오면 앱을 완전히 닫고 다시 합니다 |

`record`는 정본 DB의 성공한 추출 호출에 설정한 Provider 말고 다른 Provider id(시험용 `local-model` 포함)가 있으면 기록하지 않고 `배포처 후속` 알림으로 끝납니다. `prepare`보다 먼저 생긴 호출 행이 있으면 지난 데이터로 보고 종료 값 4로 끝납니다.

## 5. 판정

`PASS`는 다음을 모두 만족할 때만입니다:
- 정본의 수가 E2E와 같습니다(원본 version 3, Insight 행 1, 활성 Insight 1, `succeeded`가 아닌 작업 0).
- 설정한 Provider의 성공한 추출 호출이 3 이상입니다.
- 관찰 다섯을 모두 적었습니다.

버린 수는 판정에 쓰지 않고 적습니다.

## 6. 결과 붙이기

- 붙이는 것: `v02-result\result.md`(또는 `result.json`). 허용 목록의 값만 들어 있습니다: Provider 종류 `real`, Provider id, 버전(알려진 형식이 아니면 해시 `h:…`), 앱 버전, 정본의 수, 버린 수, 관찰 단어.
- 붙이지 않는 것: `v02-result\raw\` 전체(`run-record.windows-installer.json`에는 OS 문자열과 설정 값이 그대로 있음), `config.json`, `v02-plain.jsonl` 밖의 자료.
- [RESULT_TEMPLATE.md](RESULT_TEMPLATE.md)를 채워 이슈 #17에 붙입니다. Provider와 버전은 `result.md`의 `provider_id`·`version`(또는 `model`) 값을 그대로 옮깁니다(해시 `h:…`도 그대로). 설정에 적은 모델 이름을 손으로 옮겨 적지 않습니다.

### 같은 커밋의 E2E 기록(test double) 짝짓기

C4는 test double 결과와 실제 Provider 결과를 구분해 적으라고 요구합니다. test double 쪽 기록은 이 실행기가 아니라 **같은 커밋에서 돌린 `v02-flow.e2e`** 가 만듭니다. 기준이 되는 커밋은 배포처 실행의 것입니다: `v02-result\raw\run-record.windows-installer.json`의 `commit` 값(40자)이며, `result.md`의 `kit_commit`은 그 앞 12자입니다. E2E는 그 커밋을 체크아웃한 저장소에서 돌립니다. 저장소의 Node 도구(`pnpm install --frozen-lockfile`)가 있는 PC에서 돌립니다. 사외 개발 PC여도 되고 배포처 PC여도 됩니다. 설치본 PC에서 돌린다면 `record`를 끝낸 **뒤에** 합니다. E2E는 임시 데이터 폴더를 쓰지만 Electron 쪽이 이 PC에서 원본 쉘을 띄우기 때문입니다.

1. 시작 시각을 적어 둡니다(UTC, 예: `2026-11-22T01:00:00.000Z`).
2. `pnpm exec playwright test apps/web/e2e/v02-flow.e2e.ts --project=browser --project=electron`
3. `python verification\v02-site-flow\run.py summarize --records test-results\v02-flow --since <1의 시각> --commit <배포처 기록의 commit 40자>`

`--commit`에는 배포처 기록의 40자 SHA를 줍니다. `HEAD`도 받지만 그것은 E2E를 돌린 PC의 HEAD일 뿐이므로, 같은 PC·같은 체크아웃에서 배포처 실행과 E2E를 둘 다 했을 때만 씁니다. 배포처 기록의 `commit`이 `unknown`이면(git이 아닌 폴더에서 실행) 같은 커밋임을 보일 수 없습니다. 이때 `--commit unknown`은 거부되며(종료 값 2), 결과 양식의 짝짓기 행을 **미검증**으로 적습니다. 1의 시각보다 먼저 끝났거나, 다른 커밋이거나, 양식에 맞지 않는 기록은 `ignored`에 세어지고 표에 나오지 않습니다. 표의 두 줄(`browser`, `electron`, 종류 `test-double`)을 결과 양식의 둘째 행에 옮깁니다.

## 7. 이 절차가 확인하지 못하는 것

- 화면 걸음은 사람의 관찰입니다. 실행기는 화면을 보지 못합니다.
- **어느 실행 파일이 정본 DB를 썼는지 실행기는 알 수 없습니다.** 설치본, `dist\app`, 원본 실행이 모두 같은 데이터 폴더를 쓰고, 빌드 종류는 DB에 남지 않습니다. 기록의 `windows-installer`는 사람이 설치된 exe로만 앱을 켰다는 관찰(`launched-installed`)에 기댑니다. 제품 이름(`productName`)도 설정에서 오므로 실행기는 그 이름이 이 제품의 것인지 확인하지 못합니다.
- 실행 중에 앱이 내보낸 연결은 보지 않습니다(S08, R02-S2).
- 품질(정확도)의 합격선은 없습니다(R05). 실제 업무 자료의 품질은 S15입니다.

## 8. 삭제 시나리오: 실제 수집기의 삭제·권한 상실과 파일 소거 (S22, I04-R19)

> **상태: 작성만 됨 — 실행된 적 없음.** 이 저장소에는 실제 수집기가 없고 Windows에서 돌려 본 적도 없습니다. 사외에서는 거부 경로와 카나리 찾기·판정·기록 형식만 합성 자료로 단위 시험했습니다. 그 통과는 배포처 결과가 아닙니다. 스펙: [I04 spec](../../docs/specs/2026-11-21-I04-invalidation.md) I04-R19, 배포처 항목: [site-setup.md S22](../../docs/site-setup.md).

**무엇을 증명하나.** 합성 원본 셋을 실제 수집기로 가져온 뒤, 하나는 출처에서 삭제하고 하나는 권한을 잃게 만들면, ① 그 두 원본이 읽기 경로에서 바로 사라지고 ② 엔진·벡터 색인 등 투영의 제거 작업이 끝나며(끝나지 않았거나 포기한 것이 있으면 앱이 투영을 강제로 다시 만든 뒤) ③ 아래 세 곳의 **어느 파일에도**, 그리고 키워드 색인의 단어 목록에도 그 두 원본의 글이 남지 않습니다. 남겨 둔 셋째 원본은 대조군입니다: 그 글이 파일에서도, 키워드 색인에서도 찾아지지 않으면 찾기가 아무것도 못 보는 것이므로 판정이 `INCONCLUSIVE`입니다. (대조군이 정본 표 `source_versions`에서만 찾아지고 색인에서는 아니라면 색인을 찾았다는 증거가 못 되므로 색인 쪽을 따로 묻습니다.)

**용어.** *카나리*: 합성 원본의 본문에 넣는 임의의 영문 소문자 단어(셋이 서로 다른 글자로 시작하게 만듭니다). *출처 삭제*: 원 시스템에서 그 항목이 지워졌다고 수집기가 알리는 사건(`source-deleted`). *권한 상실*: 사용자가 그 항목을 더는 볼 수 없다고 수집기가 알리는 사건(`access-revoked`). *투영*: 정본에서 만들어 다시 만들 수 있는 색인(키워드, 엔진, 벡터).

**준비.** 3절의 준비와 같되, 설정은 `delete-config.example.json`을 `v02-result\delete-config.json`으로 복사해 채웁니다(`productName`, `installedExe`, 쓸 수집기 종류 `collector.kind`: `site-mail`·`site-messenger`·`site-wiki`, **`userDataDir`**: Electron의 userData 폴더(Chromium 저장소)의 절대 경로로 **필수**이며 없으면 `preflight`가 설정 오류로 멈춥니다. 이 폴더는 데이터 폴더 `%LOCALAPPDATA%\PKI` 밖입니다(`storage/src/data-directory.ts`가 일부러 따로 정했고 `apps/desktop`은 userData 위치를 바꾸지 않아 로밍 `%APPDATA%` 아래에 앱 이름으로 생깁니다. 앱 이름은 패키지 이름 `pki-desktop`(`apps/desktop/build/build.ts`)에서 오지만 R04의 패키저가 다른 이름을 줄 수 있어 설치본에서 확인된 값이 아닙니다: 설치한 PC에서 실제 폴더를 보고 적습니다). 엔진·벡터 색인이 이 두 폴더 밖에 파일을 둔다면 그 절대 경로를 `extraScanDirs`에. 이 실행기는 Provider를 묻지 않습니다. 데이터 폴더가 **비어 있어야** 합니다(옛 흔적이 이번 결과로 읽히지 않게).

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py delete-scenario preflight --config v02-result\delete-config.json` | `preflight ok`. 설치본이 아니거나 Windows가 아니면 `배포처 후속`으로 시작하는 알림과 종료 값 3 |
| 2 | `python verification\v02-site-flow\run.py delete-scenario prepare --config v02-result\delete-config.json --out v02-result` | 역할(`deleted`, `revoked`, `kept`)별 카나리 단어 셋이 출력되고 `delete-scenario-state.json`이 생김. 정본 DB가 이미 있으면 종료 값 4 |
| 3 | 수집기의 **시험 시스템**에서 합성 항목 셋을 만들고 각 본문에 카나리 하나씩 넣습니다. 앱은 **설치된 exe로만** 켭니다. 수집기를 동기화해 셋 모두 가져오고 추출이 끝날 때까지 기다립니다 | 앱에서 셋 모두 보임 → `launched-installed` |
| 4 | 시험 시스템에서 `deleted` 항목을 지우고 동기화합니다 | 그 항목이 Sources·검색·근거에서 바로 사라짐 → `source-deleted-event` |
| 5 | 시험 시스템에서 `revoked` 항목의 열람 권한을 뺍니다(항목은 남기고 시험 계정만 못 보게). 수집기가 이것을 **권한 상실 사건**(`access-revoked`)으로 알려야 합니다. 내용은 그대로 두고 범위만 좁히는 **범위 변경**(`scope-change`, JSONL 가져오기의 `revoke` 줄)은 삭제가 아니라 이 시나리오의 권한 상실이 못 됩니다. 동기화합니다 | 그 항목이 같은 화면들에서 바로 사라짐 → `access-revoked-event` |
| 6 | 두 원본의 글이 어느 읽기 화면에도 없는지 봅니다(`kept` 항목은 그대로) | → `reads-gone` |
| 7 | 활동 화면(또는 상태)에서 투영 제거 작업이 모두 끝났는지, 끝나지 않은 것이 있으면 투영이 다시 만들어졌는지 봅니다. 그다음 **앱을 완전히 닫습니다**(알림 영역 포함) | → `projections-clean` |
| 8 | `python verification\v02-site-flow\run.py delete-scenario record --config v02-result\delete-config.json --out v02-result --observed launched-installed --observed source-deleted-event --observed access-revoked-event --observed reads-gone --observed projections-clean` (확인한 것만 적습니다) | `I04-C3:delete-scenario PASS`(종료 값 0). 지운 수가 다르거나 카나리가 남았으면 `FAIL`, 대조군을 못 찾았거나 관찰이 빠지면 `INCONCLUSIVE`(종료 값 1) |

**찾는 곳.** ① 데이터 폴더 `%LOCALAPPDATA%\PKI`의 모든 파일(`-journal`·`-wal`·`-shm` 포함) ② `userDataDir`의 모든 파일(Chromium 저장소) ③ `extraScanDirs`의 모든 파일. 이 밖은 보지 않습니다. **찾는 방식**: 카나리 단어의 끝 12글자를 대소문자 구분 없이 ASCII, UTF-16LE, UTF-16BE로 찾습니다(SQLite FTS5는 앞 단어와 앞부분이 같은 단어를 뒤쪽 조각만으로 저장하므로 단어 전체가 아니라 끝을 찾습니다). 추가로 정본의 키워드 색인이 **논리적으로** 지운 카나리를 단어로 아직 갖고 있는지 SQLite `fts5vocab`으로 읽기 전용으로 묻습니다. 이 물음은 색인이 "어떤 단어를 가졌다고 말하는가"만 보며 파일의 바이트는 보지 않습니다. 반대로 바이트 찾기는 색인에 단어로 등록되지 않고 파일에 남은 조각(지워진 뒤의 잔여)을 잡는 것입니다. 둘이 서로 다른 것을 봅니다. 그리고 대조군이 색인에 단어로 있는지도 이 물음으로 확인합니다(바이트 찾기가 색인을 읽었다는 증거가 못 되므로). 정본 DB가 FTS5를 쓰는 표 `keyword_index`를 가져야 하고 실행기가 쓰는 Python의 SQLite에 FTS5가 있어야 합니다. 없으면 오류로 끝나며 통과가 되지 않습니다. 데이터 폴더의 tombstone 장부 파일(`tombstone-ledger*.jsonl`, 옆으로 치운 이름과 `.tmp` 포함)도 그 안의 파일이므로 같은 방식으로 읽히고, 카나리 발견 수는 0이어야 합니다(장부 줄에는 해시와 연결 인스턴스 ID·종류만 있습니다).

**판정.** `PASS`는 다음을 모두 만족할 때만입니다: 정본의 무효화 기록에 `source-deleted` 1건, `access-revoked` 1건, `user-deleted` 0건, 지운 두 카나리가 찾는 곳의 모든 파일에서 0건이고 키워드 색인 단어 목록에도 없음, 대조군 카나리가 파일과 색인 양쪽에서 찾아짐, 읽을 수 없던 폴더·파일이 0개, 관찰 다섯 모두. **읽을 수 없는 경로**에는 권한이 막힌 폴더·파일 말고 가리키는 곳이 없는 바로가기(끊어진 심볼릭 링크)도 들며, 있으면 판정이 영구히 `INCONCLUSIVE`입니다(안전한 쪽으로 둔 것입니다). 그 링크를 지우거나 열 수 있게 한 뒤 `record`를 다시 실행합니다. 그 경로를 범위에서 빼야 한다면 그 폴더를 미검증으로 적습니다. 지운 카나리가 남았거나 삭제 사건 수가 다르면 `FAIL`, 대조군이 안 찾아졌거나 읽을 수 없는 경로(개수만 기록)가 있거나 관찰이 빠지면 `INCONCLUSIVE`입니다(종료 값 1). 하나라도 남았으면 그 단어가 어느 종류의 파일에 있는지 배포처 안에서 찾습니다(Chromium 저장소, 엔진 색인, 데이터베이스의 여유 공간 등). 그 파일 이름은 결과에 적히지 않습니다.

**붙이는 것.** `v02-result\result.md`만. 허용 목록의 값은 다음 열두 가지입니다: `collector_kind`(수집기 종류), `app_version`, `deleted_source_deleted`·`deleted_access_revoked`·`deleted_user_deleted`(종류별 지운 수), `canaries_found`(파일에서 찾은 지운 카나리 수), `index_canaries_found`(색인에 남은 지운 카나리 수), `control_canary_found`·`control_canary_in_index`(대조군이 파일·색인에서 찾아졌는지), `unreadable_paths`(읽을 수 없던 경로 수), `observed`(관찰 단어), `kit_commit`. `raw\`, `config`, 상태 파일(카나리 단어가 있음)은 붙이지 않습니다. 결과는 이슈 #21에 남깁니다.

**이 절차가 확인하지 못하는 것(미검증으로 둡니다).** 화면과 투영 작업은 사람의 관찰입니다. 찾기는 위 세 곳의 파일 바이트만 봅니다: OS 백업·볼륨 스냅샷, 지운 파일 조각, 임시 폴더, 크래시 덤프, 페이지 파일, Provider 쪽 보관은 보지 않습니다(S11, S05·S08). 파일 안에서도 다음 꼴은 못 봅니다: 압축되었거나 접두 압축된 저장소(엔진의 FST·LZ4, Snappy 등. 그 안의 글자는 바이트로 나타나지 않습니다), 암호화된 저장소, SQLite 페이지 경계에서 둘로 나뉘어 저장된 글, UTF-16 밖의 인코딩(zlib·base64 등). 키워드 색인에 단어가 남았는지는 `fts5vocab`이 논리적으로 묻지만(바이트가 아니라 색인이 가진 단어 목록), 압축된 파일 안의 글자는 그것으로도 보지 못합니다. 엔진·벡터 색인이 이런 형식이면 그 구현의 자체 확인 수단(저장된 단어를 묻는 명령)을 배포처가 따로 씁니다. 알림 영역에서 앱이 꺼졌는지는 사람이 확인합니다. 어느 실행 파일이 DB를 썼는지는 7절과 같이 확인하지 못합니다.

## 9. 큐·스케줄러 복구 시나리오: 강제 종료, 절전·최대 절전, 시계, 시간대 (S19, I03-R25)

> **상태: 작성만 됨 — 실행된 적 없음.** Windows에서 돌려 본 적이 없습니다. 사외에서는 거부 경로와 판정·기록 형식만 합성 자료로 단위 시험했습니다. 그 통과는 배포처 결과가 아닙니다. 스펙: [I03 spec](../../docs/specs/2026-11-21-I03-persistent-queue.md) I03-R25, 배포처 항목: [site-setup.md S19](../../docs/site-setup.md).

**무엇을 확인하나.** 설치된 앱에서 가져오기 뒤의 추출 작업이 도는 도중, 또는 주기 작업이 기다리는 동안 다음 여섯 가지를 겪은 뒤, 정본의 작업 표에서 ① 끝나지 않은 작업이 남지 않았고 ② 성공한 추출 작업의 수(효과 행)가 가져온 합성 원본 수와 같고 ③ 포기한 작업이 없고 ④ 시나리오의 흔적(`kill`: 시도 2 이상으로 끝난 작업, `sleep`·`hibernate`·`clock-forward`: 한 작업으로 합쳐진 slot)이 있는지를 봅니다. **결과가 한 번만 남는다는 것 자체는 이 실행이 증명하지 않습니다**: 정본의 작업 표가 같은 원본 버전의 추출 작업 둘, 같은 주기·slot의 작업 둘을 키로 막으므로(`storage/src/migrations.ts`) 그 둘은 이 절차에서 셀 수 없고, 같은 작업의 두 번 실행에도 결과가 한 번인 것은 개발 쪽 시험(I03-C1의 `kill.resume`, `effect.once`)이 증명합니다. 이 절차가 설치본에서 보는 것은 끝나야 할 작업이 끝났는지, 그 수가 맞는지, 놓친 주기가 합쳐졌는지입니다. 시나리오는 `kill`(실행 중 강제 종료), `sleep`(절전에서 깨어남), `hibernate`(최대 절전에서 깨어남), `clock-forward`(시계를 앞으로), `clock-back`(시계를 뒤로), `timezone`(시간대 변경)입니다. 하나씩 따로 실행하고 결과도 시나리오마다 따로 남깁니다.

**용어.** *slot*: 주기의 예정 시각 하나(10분 주기면 10분마다 하나). *합쳐진 slot*(잠정): 앱이 꺼졌거나 PC가 잠든 사이 한 점검이 여러 slot이 예정을 지난 것을 보고 **작업 하나만** 등록했을 때, 그 작업에 합쳐진 slot의 수(예정을 지난 slot 수 − 실제로 실행된 1). 8시간 잔 10분 주기는 48개가 예정을 지났고 합쳐진 slot은 47입니다. 이 수는 작업 행에 저장되지 않으므로 실행기가 `prepare` 때의 주기별 다음 예정 시각과 그 뒤 등록된 작업들의 slot 간격(주기 길이로 나눈 값)으로 다시 계산합니다. 주기 표의 `coalesced_count`(끝나지 않은 작업이 있어 새 작업을 넣지 않은 경우의 수)는 다른 사건이라 세지 않습니다. 주기의 길이는 `prepare` 때의 것을 쓰므로 그 뒤 주기를 바꾸거나 되돌려도 수가 바뀌지 않습니다. `sleep`·`hibernate`는 **수동 확인 기록의 시간대와 겹치는 간격만** 셉니다(작업의 slot이 깨운 시각보다 한 주기 이상 앞서지 않고, 간격이 재운 시각보다 한 주기 넘게 늦게 시작하지 않은 것). 앱이 꺼져 있던 동안을 시작 점검이 합친 것은 절전의 증거가 아닙니다. 일·주 주기는 24시간 단위로 어림합니다. *효과 행*: 이 실행기가 센 결과의 수. **성공한 추출 작업**이며(원본 버전마다 하나), 파생 지식의 행은 따로 세지 않습니다. *시도 2 이상으로 끝난 작업*(`retried_jobs`): 끊긴 작업이 임대 기한이 지난 뒤 다시 잡혀 끝난 경우가 그 예이지만, Provider 호출 실패 뒤의 보통 재시도로 끝난 작업도 같이 세므로 강제 종료의 유일한 증거는 아닙니다(사람의 관찰 `killed-while-running`과 함께 읽습니다).

**준비.** 3절의 준비와 같되 설정은 `queue-config.example.json`을 `v02-result\queue-config.json`으로 복사해 채웁니다(`productName`, `installedExe`, `expectedEffectRows`: 시나리오마다 가져올 합성 원본의 수. 기본 3). 이 실행기는 Provider를 묻지 않지만, 추출이 실제로 돌려면 3절·4절처럼 실제 Provider가 설정되어 있어야 합니다. 시나리오마다 **새 합성 원본 셋**(V02의 `v02-plain.jsonl`의 제목과 본문 문구를 바꾼 것)을 씁니다. 같은 글을 다시 가져오면 중복으로 걸러져 추출이 새로 돌지 않습니다. **짧은 주기가 필요한 시나리오(`sleep`, `hibernate`, `clock-forward`).** 놓친 slot이 합쳐지는 것을 보려면 하루보다 짧은 주기가 하나 있어야 합니다. 제품이 기본으로 만드는 주기는 수집 동기화 1시간(끌어올 수 있는 수집기 인스턴스마다)과 정리 매일 03:00뿐인데, 공용 제품의 수집기 `site-*` 셋은 `not-implemented`이므로 **S01~S04의 실제 수집기가 있는 포크에서만** 동기화 주기가 생깁니다(I03 spec T09 6항). 수집기가 없는 설치본에서는 정리 주기가 설치본에도 있으므로, `prepare` 전에 활동 화면의 주기 표에서 **정리 주기의 종류를 10분으로 바꿉니다**(주기 줄의 "바꾸기": I03 spec T11 5항이 모든 주기에 있다고 적은 동작이며 설치본에서 눌러 본 적은 없습니다). 그 화면에서 바꿀 수 없으면 이 세 시나리오는 실행할 수 없고 미검증으로 남깁니다(배포처 후속: 수집기를 갖춘 뒤 실행). 시나리오가 끝나면 주기를 **원래대로**(매일 03:00) 돌린 뒤 4번 단계를 합니다(10분 주기의 정리 작업이 열려 있으면 판정이 `INCONCLUSIVE`입니다). 이 시나리오들은 정본에 `schedule_id`가 있는 작업이 새로 등록되었는지로 합쳐진 slot을 셉니다.

데이터 폴더가 비어 있지 않아도 됩니다. 시나리오마다 `prepare` 때의 작업 표 상태를 기준으로 그 뒤의 것만 셉니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py queue-scenario preflight --scenario <이름> --config v02-result\queue-config.json` | `preflight ok`. 설치본이 아니거나 Windows가 아니면 `배포처 후속`으로 시작하는 알림과 종료 값 3 |
| 2 | **앱을 설치된 exe로 켜고 활동 화면에서 모든 주기의 다음 예정이 지금보다 뒤인 것을 확인한 다음**(앱이 꺼져 있던 동안 지난 slot을 시작 점검이 합치면 그 수가 시나리오의 것과 섞입니다) 같은 명령에서 `preflight`를 `prepare`로 바꾸고 `--out v02-result`를 붙입니다. 앱은 켜 둔 채로 3번 단계를 합니다 | `queue-scenario-state.json`이 생김(시나리오 이름, 주기별 다음 예정과 길이가 들어 있음). 어떤 주기의 다음 예정이 이미 지났으면 `prepare`는 `stale-data`로 거부하고(종료 값 4) 아무것도 쓰지 않으므로, 앱을 켜고 점검(30초)이 한 번 돈 뒤 다시 실행합니다 |
| 3 | 아래 시나리오별 절차를 합니다 | 시나리오별 관찰 단어 |
| 4 | 앱을 켠 채로 작업이 모두 끝나고(활동 화면에 끝나지 않은 작업 0) 앱을 **완전히 닫습니다**(알림 영역 포함) | |
| 5 | `prepare`를 `record`로 바꾸고 `--observed <단어>`를 확인한 만큼 붙입니다 | `I03-C2:queue-scenario PASS`(종료 값 0). 어긋남은 `FAIL`, 증거가 없거나 관찰이 빠지면 `INCONCLUSIVE`(종료 값 1) |

**시나리오별 절차.** 모든 시나리오는 설치된 exe로만 앱을 켭니다(`launched-installed`). 합성 원본 셋을 가져온 직후, 추출이 도는 동안에 시작합니다.

| 시나리오 | 할 일 | 관찰 단어 |
|---|---|---|
| `kill` | 활동 화면에서 작업이 `running`인 것을 본 순간 작업 관리자로 앱과 백엔드 프로세스를 **강제로 끝냅니다**(정상 종료가 아니다). 임대 기한(기본 2분)이 지나도록 기다린 뒤 설치된 exe로 다시 켭니다. 끊긴 작업이 다시 집혀 끝나는 것을 봅니다 | `killed-while-running`, `restarted-installed`, `no-duplicate-visible`(같은 원본에 결과가 둘로 보이지 않음) |
| `sleep` | 합성 원본을 가져온 뒤 위의 10분 주기(또는 수집기의 1시간 주기)가 기다리는 중에 PC를 **절전**으로 보내고 10분 넘게 둡니다. 깨우고, 앱이 켜진 채 살아 있는지 봅니다. 활동 화면의 그 주기에서 합쳐진 수와 놓친 수를 봅니다. **PC를 재우기 전에 아래 수동 확인 기록을 적습니다** | `slept-with-work-due`, `woke-app-running`, `merge-visible` |
| `hibernate` | `sleep`과 같되 PC를 **최대 절전**으로 보냅니다(`powercfg /a`로 최대 절전이 켜진 것을 먼저 확인) | `hibernated-with-work-due`, `woke-app-running`, `merge-visible` |
| `clock-forward` | 앱이 켜진 채로 Windows 시계를 **8시간 앞으로** 옮기고(자동 시간 설정을 끈 뒤) 다음 점검(30초)을 기다려 활동 화면의 합쳐진 수를 봅니다. 시계를 **원래대로** 돌립니다 | `clock-moved-forward`, `clock-restored`, `merge-visible` |
| `clock-back` | 앱이 켜진 채로 시계를 **8시간 뒤로** 옮기고 한 시간 안에 다음 점검을 몇 번 기다립니다. 같은 주기가 같은 시각에 다시 돌지 않는지, 작업이 임대 때문에 영구히 막히지 않는지 봅니다. 시계를 **원래대로** 돌립니다 | `clock-moved-back`, `clock-restored`, `no-rerun-visible` |
| `timezone` | 앱이 켜진 채로 Windows 시간대를 다른 곳(예: 9시간 이상 차이)으로 바꾸고 다음 점검을 기다립니다. 매일·매주 주기의 다음 실행 시각이 새 시간대로 맞춰지는지, 같은 날 다시 돌지 않는지 봅니다. 바꾼 시간대가 앱에 늦게(다시 켠 뒤에) 반영되면 그것을 기록에 적습니다(가정 I03-A5). 시간대를 **원래대로** 돌립니다 | `timezone-changed`, `timezone-restored`, `no-rerun-visible` |

**절전·최대 절전의 수동 확인 기록.** 실행기는 PC를 재울 수 없고 재웠는지 볼 수도 없습니다. `sleep`과 `hibernate`는 재우기 **전에** 사람이 `v02-result\sleep-confirmation.json`을 적고(`prepare` 뒤에), 깨운 뒤 `wokeAt`을 채웁니다. 이 기록이 없으면 `record`는 `배포처 후속`으로 시작하는 알림을 내고 종료 값 3으로 끝나며(이유 `sleep-record-missing`) 아무것도 쓰지 않습니다. 기록이 이 실행과 맞지 않아도 같습니다(이유 `sleep-record-invalid`): 필드가 정확히 아래 넷이 아님, 시나리오 이름이 다름, 시각이 형식에 맞지 않음, 재운 시각이 `prepare`보다 앞섬, 잔 시간이 10분(가장 짧은 주기)보다 짧음.

```json
{ "schema": 1, "scenario": "sleep", "sleptAt": "2026-01-01T01:10:00.000Z", "wokeAt": "2026-01-01T01:40:00.000Z" }
```

(시각은 UTC이며 위는 형식의 예입니다. `hibernate`는 `scenario`를 그 이름으로 씁니다. 이 파일에는 시각 둘 말고 다른 글을 넣지 않습니다. 넣으면 `sleep-record-invalid`입니다.)

**판정.** `PASS`는 시나리오마다 다음을 모두 만족할 때만입니다: 효과 행이 `expectedEffectRows`와 같음, 포기한 작업(`dead_letter`)이 0, 끝나지 않은 작업이 0, 시나리오의 증거가 있음(`kill`: 시도 2 이상으로 끝난 작업이 1개 이상, `sleep`·`hibernate`·`clock-forward`: 합쳐진 slot이 1 이상), 그 시나리오의 관찰 단어가 모두 있음. 효과 행이 다르거나 포기한 작업이 있으면 `FAIL`, 끝나지 않은 작업이 남았거나 증거가 없거나 관찰이 빠지면 `INCONCLUSIVE`입니다(종료 값 1). `FAIL`이면 그 작업 표를 배포처 안에서 열어 어느 작업인지 찾습니다. 그 내용은 결과에 적히지 않습니다.

**붙이는 것.** `v02-result\result.md`만. 허용 목록의 값은 다음 아홉 가지입니다: `scenario`, `app_version`, `effect_rows`(성공한 추출 작업 수), `merged_slots`(합쳐진 slot 수), `retried_jobs`(시도 2 이상으로 끝난 작업 수), `jobs_open`(끝나지 않은 작업 수), `jobs_dead_letter`(포기한 작업 수), `observed`(관찰 단어), `kit_commit`. `raw\`, `config`, 상태 파일, 수동 확인 기록은 붙이지 않습니다. 결과는 이슈 #20(I03)에 남깁니다. 여섯 시나리오를 모두 실행하기 전에는 S19를 끝났다고 적지 않습니다.

**이 절차가 확인하지 못하는 것(미검증으로 둡니다).** 전원 차단(플러그를 뽑는 것)은 하지 않습니다. 정본 SQLite의 갑작스러운 종료 내성은 A20(S13)의 몫입니다. 화면, 강제 종료, 절전, 시계·시간대 변경은 모두 사람의 관찰이며 실행기는 그 사건을 보지 못합니다. 효과 행은 성공한 추출 작업의 수이고 파생 지식의 행 수가 아닙니다. 합쳐진 slot은 slot 간격에서 다시 계산한 값이며 일·주 주기는 어림입니다. Provider 호출이 두 번 일어났는지는 이 절차가 보지 않습니다(두 번 호출은 막지 못하며 예산으로 셉니다. I03 spec C1). 절전 중 Broker 시간 제한과 CLI 프로세스 트리 종료(I03-A2)는 `woke-app-running`과 작업이 끝났다는 사실로만 간접히 보입니다. 바꾼 시간대를 프로세스가 바로 따르는지(I03-A5)는 `timezone`의 사람 관찰입니다. 어느 실행 파일이 DB를 썼는지는 7절과 같이 확인하지 못합니다.

## 10. Semantic 실측 (S32, S01-R25)

> **상태: 작성만 됨 — 실행된 적 없음.** Windows에서 돌려 본 적이 없습니다. 사외에서는 거부 경로와 숫자를 세는 부분만 합성 SQLite로 단위 시험했습니다. 그 통과는 배포처 결과가 아닙니다. 스펙: [S01 spec](../../docs/specs/2026-11-22-S01-semantic-registry.md) S01-R24·R25, 배포처 항목: [site-setup.md S32](../../docs/site-setup.md).

**무엇을 하나.** 실제 Provider로 실제 자료에서 표기(`alias.*` 사실)와 정의를 추출하고, 자동 승격(`semantic.autoVerify`)을 켜기 전과 켠 뒤에 정본의 숫자를 읽기 전용으로 셉니다. **통과·실패를 판정하지 않습니다.** 숫자를 보고 켤지 정하는 것은 사람입니다. 결과 파일은 숫자와 코드 이름(상태, 종류 이름 `alias.synonym` 등, `on`·`off`·`unset`)만 담고 글, 값, 항목 이름은 담지 않습니다.

**준비.** 3절의 준비와 같되(설정은 `config.example.json`을 그대로 씁니다) 합성 자료가 아니라 **실제 자료**를 추출합니다. 그래서 결과 폴더의 파일을 공용 이슈에 올릴 때는 아래 "붙이기"의 숫자만 옮깁니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py semantic-scenario preflight --config v02-result\config.json` | `preflight ok`. 설치본이 아니거나 Windows가 아니거나 test double Provider이면 `배포처 후속`으로 시작하는 알림과 종료 값 3 |
| 2 | 설정 `semantic.autoVerify`를 **한 번도 쓰지 않은 채로** 설치된 exe로 켜서 실제 자료를 추출하고 앱을 완전히 닫습니다(알림 영역 포함) | 활동 화면에서 추출이 끝남 |
| 3 | `... semantic-scenario record --config v02-result\config.json --out v02-result --phase off` | `semantic-counts.off.json`이 생김, 종료 값 0 |
| 4 | 앱을 켜 `POST /api/settings/semantic`으로 `{ "autoVerify": true }`를 보냅니다. 켜도 이미 있는 행을 훑지 않으므로, 다음 추출이나 원본의 변경(새 version, 삭제, 정리)이 닿는 행부터 판정됩니다. 추출을 한 번 더 돌리거나 원본을 바꿉니다 | 설정 API가 `autoVerify: true`를 돌려줌 |
| 5 | 정책이 올린 행을 API(`GET /api/semantic`)로 훑어 **틀린 것에 이의나 기각**을 냅니다(`POST /api/semantic/decide`). 틀린 승격이 없으면 그 사실을 적습니다. 앱을 완전히 닫습니다 | |
| 6 | `... record ... --phase on` | `semantic-counts.on.json`이 생김, 종료 값 0 |

**숫자의 뜻.** 모두 **지금 상태의 행**을 센 것이고 변경 이력의 줄 수가 아닙니다. 올렸다가 되돌리고 다시 올린 행은 한 번입니다.

| 이름 | 뜻 |
|---|---|
| `setting` | 저장된 설정. `on`, `off`, `unset`(한 번도 쓰지 않음), `other` |
| `forms` | 종류(seed 종류 `alias.synonym`·`alias.abbreviation`·`alias.translation`)별로 표기 사실의 상태별 수. 그 밖의 종류(사용자가 만든 종류 포함)는 이름 없이 `other`로 셉니다 |
| `definitions` | 정의 사실의 상태별 수 |
| `promoted` | 정책이 `auto-verify`로 올린 적이 있는 사실·관계의 수 |
| `promotedStanding` | 그 가운데 지금 `verified`인 수 |
| `promotedJudgedWrong` | 그 가운데 사용자가 틀렸다고 본 수: 사용자의 이의·기각으로 지금 `disputed`·`rejected`이거나, 사용자의 값 고치기로 `superseded`가 된 것. 정책이 낸 이의(그 상태를 만든 줄의 주체가 정책. 취소·근거 복귀는 되돌린 줄 앞으로 거슬러 읽습니다)와 이의를 낸 뒤 취소해 `verified`로 돌아온 행은 세지 않습니다 |

`--phase`는 파일 이름과 `phase` 칸만 정합니다. 저장된 설정과 어긋나면(`off`인데 설정이 `on`, `on`인데 `on`이 아님) 표준 오류에 `warning:` 한 줄을 내지만 막지 않습니다.

**붙이기.** 두 파일의 숫자와, 켤지 정한 결과(켠다·끈 채로 둔다·더 잰다)를 이슈 #22(S01)에 남깁니다. 글, 값, 항목 이름, 설정 파일은 붙이지 않습니다.

**이 절차가 확인하지 못하는 것(미검증으로 둡니다).** 이 실행기는 Windows에서 돌려 본 적이 없습니다. 설치본의 정본 경로가 `%LOCALAPPDATA%\PKI\pki.sqlite`와 같은지(포크의 빌드에서)와 실제 Provider가 표기를 인용문 그대로 돌려주는지는 확인하지 못했습니다. "틀렸다"는 판단은 사용자가 API로 낸 이의·기각·값 고치기에서만 오므로, 사용자가 훑지 않은 승격은 틀리지 않은 것으로 셉니다. 내용 해시가 다른 거의 같은 글 두 원본은 두 원본으로 세는 것이 조건 자체이고, 그 승격이 틀렸는지가 이 숫자가 보려는 것입니다. 숫자가 작으면(수십 건 미만) 정밀도로 읽을 수 없습니다.

## 11. 개체 해소 실측 (S33, S02-R28)

> **상태: 작성만 됨 — 실행된 적 없음.** Windows에서 돌려 본 적이 없습니다. 사외에서는 거부 경로와 숫자를 세는 부분만 합성 SQLite로 단위 시험했습니다. 그 통과는 배포처 결과가 아닙니다. 스펙: [S02 spec](../../docs/specs/2026-11-22-S02-entity-resolution-temporal-graph.md) S02-R27·R28, 배포처 항목: [site-setup.md S33](../../docs/site-setup.md).

**무엇을 하나.** 실제 Provider로 실제 자료에서 넓힌 유형(Person·Organization 등)의 항목과 식별자·유효 구간을 추출하고, 합치기 후보가 얼마나 나오는지 보며, 자동 이의(`semantic.autoDispute`)를 켜기 전과 켠 뒤에 정본의 숫자를 읽기 전용으로 셉니다. **통과·실패를 판정하지 않습니다.** 숫자를 보고 켤지 정하는 것은 사람입니다. 결과 파일은 숫자와 코드 이름(유형 이름, `on`·`off`·`unset`, `user`·`link-check`)만 담고 글, 값, 항목 이름은 담지 않습니다.

**준비.** 10절과 같습니다(설정은 `config.example.json`을 그대로 씁니다). 합성 자료가 아니라 **실제 자료**를 추출하므로, 결과 폴더의 파일을 공용 이슈에 올릴 때는 아래 "붙이기"의 숫자만 옮깁니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py entity-scenario preflight --config v02-result\config.json` | `preflight ok`. 설치본이 아니거나 Windows가 아니거나 test double Provider이면 `배포처 후속`으로 시작하는 알림과 종료 값 3 |
| 2 | 설정 `semantic.autoDispute`를 **한 번도 쓰지 않은 채로** 설치된 exe로 켜서 실제 자료를 추출하고 합치기 후보를 훑어 받아들이거나 물리친 뒤 앱을 완전히 닫습니다(알림 영역 포함) | 활동 화면에서 추출이 끝남 |
| 3 | `... entity-scenario record --config v02-result\config.json --out v02-result --phase off` | `entity-counts.off.json`이 생김, 종료 값 0 |
| 4 | 앱을 켜 설정 `semantic.autoDispute`를 켭니다(쓰는 길은 설정 API이고 화면에는 없습니다). 켜도 이미 있는 행을 훑지 않으므로 다음 추출이 닿는 행부터 판정됩니다. 추출을 한 번 더 돌리고 `GET /api/conflicts`로 목록을 훑습니다. 정책이 이의를 건 사실이 틀렸으면 되돌립니다. 앱을 완전히 닫습니다 | |
| 5 | `... record ... --phase on` | `entity-counts.on.json`이 생김, 종료 값 0 |

**숫자의 뜻.** 모두 **지금 상태의 행**을 센 것이고 변경 이력의 줄 수가 아닙니다.

| 이름 | 뜻 |
|---|---|
| `setting` | 저장된 설정. `on`, `off`, `unset`(한 번도 쓰지 않음), `other` |
| `items` | 항목 유형(seed 열세 개)별 수. 그 밖의 유형(사용자가 만든 유형 포함)은 이름 없이 `other`로 셉니다 |
| `candidates` | 합치기 후보 행의 수. **후보 가운데 받아들인 수는 따로 적히지 않습니다**: 합치기 줄이 후보에서 왔는지 사용자가 직접 골랐는지를 남기지 않기 때문입니다 |
| `merges` | 합치기 줄의 수. `active`는 적용 중, `resting`은 묶음의 계보를 묶을 수 없어 쉬는 중 |
| `distinctBy` | 구분 표시의 수를 남긴 쪽별로. `user`는 사용자가 물리친 쌍, `link-check`는 연결을 다시 확인하는 코드가 거절한 쌍(`links_refused`) |
| `factsWithValidity` | 유효 구간(시작이나 끝)이 붙은 사실의 수 |
| `validityFixedByUser` | 그 가운데 사용자가 구간을 고친 사실의 수(고친 횟수가 아니라 행). 사용자가 틀렸다고 본 수의 근거입니다 |
| `autoDisputes` | 정책이 모순을 이유로 이의를 건 사실의 수. `off`에서는 0이어야 합니다 |

`--phase`는 파일 이름과 `phase` 칸만 정합니다. 저장된 설정과 어긋나면 표준 오류에 `warning:` 한 줄을 내지만 막지 않습니다.

**붙이기.** 두 파일의 숫자와, 켤지 정한 결과(켠다·끈 채로 둔다·더 잰다)를 이슈 #23(S02)에 남깁니다. 글, 값, 항목 이름, 설정 파일은 붙이지 않습니다.

**이 절차가 확인하지 못하는 것(미검증으로 둡니다).** 이 실행기는 Windows에서 돌려 본 적이 없습니다. 설치본의 정본 경로가 `%LOCALAPPDATA%\PKI\pki.sqlite`와 같은지(포크의 빌드에서)와 실제 Provider가 유효 기간을 맞게 돌려주는지는 확인하지 못했습니다. 합치기 후보가 "맞았는지"는 사용자의 합치기·물리치기에서만 오고, 훑지 않은 후보는 맞은 것으로도 틀린 것으로도 세지 않습니다. 숫자가 작으면(수십 건 미만) 정밀도로 읽을 수 없습니다.


## 12. 분석 의미 실측 (S34, S03-R20)

> **상태: 작성만 됨 — 실행된 적 없음.** Windows에서 돌려 본 적이 없습니다. 사외에서는 거부 경로와 숫자를 세는 부분만 합성 SQLite로 단위 시험했습니다. 그 통과는 배포처 결과가 아닙니다. 스펙: [S03 spec](../../docs/specs/2026-11-22-S03-analytical-semantic.md) S03-R20·R21, 배포처 항목: [site-setup.md S34](../../docs/site-setup.md).

**무엇을 하나.** 표 파일(CSV·XLSX)과 분석 의미(Dataset·Metric·Join과 검사)가 실제 자료에서 얼마나 나오는지, 표 프로파일(`analytical.profile`)을 켠 뒤 정본의 숫자를 읽기 전용으로 셉니다. **통과·실패를 판정하지 않습니다.** 프로파일은 꺼진 채로 나가고, 켤지는 이 숫자를 보고 사람이 정합니다. 결과 파일은 숫자와 코드 이름(항목 유형, 사실 종류, 검사 이름)만 담고 글, 값, 항목 이름은 담지 않습니다. 단계가 하나뿐이라 `--phase`가 없습니다(꺼진 상태에는 잴 것이 없습니다).

**준비.** 10절과 같습니다(설정은 `config.example.json`을 그대로 씁니다). **실제 자료**(표가 든 폴더나 가져오기)를 쓰므로 결과 폴더의 파일을 공용 이슈에 올릴 때는 아래 "붙이기"의 숫자만 옮깁니다.

| 순서 | 할 일 | 확인 |
|---|---|---|
| 1 | `python verification\v02-site-flow\run.py analytical-scenario preflight --config v02-result\config.json` | `preflight ok`. 설치본이 아니거나 Windows가 아니거나 test double Provider이면 `배포처 후속`으로 시작하는 알림과 종료 값 3 |
| 2 | 설치된 exe로 설정 `analytical.profile`을 켭니다(쓰는 길은 `POST /api/settings/analytical`이고 화면에는 없습니다. 본문은 `{ "profile": true, "maxCells": 200000 }`처럼 두 키가 모두 있어야 하며, 한도를 따로 정하지 않았으면 기본값 200000을 보냅니다). 켜면 이미 있는 표 자료의 프로파일 작업이 쌓입니다 | 활동 화면에서 작업이 끝남 |
| 3 | 실제 Provider로 표를 설명하는 문서를 추출하고, `GET /api/analytical`로 목록을 봅니다. 맞지 않는 표나 행은 되돌립니다. 앱을 완전히 닫습니다(알림 영역 포함) | |
| 4 | `... analytical-scenario record --config v02-result\config.json --out v02-result` | `analytical-counts.json`이 생김, 종료 값 0. 저장된 `analytical.profile`이 `on`이 아니면 표준 오류에 `warning:` 한 줄(막지는 않음) |

**숫자의 뜻.** 모두 **지금 상태의 행**을 센 것입니다.

| 이름 | 뜻 |
|---|---|
| `setting` | 저장된 `analytical.profile`. `on`, `off`, `unset`(한 번도 쓰지 않음), `other` |
| `maxCells` | 저장된 `analytical.maxCells`(숫자). 쓰지 않았으면 `unset` |
| `tableSources` | 지금 판의 블록에 csv·xlsx 위치가 있는, 지워지지 않은 출처의 수 |
| `tables` | 표 행(`dataset_tables`)의 수 |
| `sourcesWithoutTable` | 표 출처인데 표 행이 없는 수. **왜 없는지(표가 아님, 한도 초과 등)는 제품이 이유를 저장하지 않아 나누어 세지 않습니다** |
| `datasetsRejected` | 표를 가진 Dataset 가운데 사용자가 물리친 수. 표가 아닌 것을 표로 잘못 본 정도의 근거입니다 |
| `items` | Dataset·Metric·Join을 상태별로 센 수 |
| `facts` | 분석 사실을 종류(seed 열세 개)별로 센 수. 그 밖의 종류(사용자가 만든 종류 포함)는 이름 없이 `other`로 셉니다 |
| `checks` | 검사 줄을 검사 이름(`schema`, `grain`, `join-cardinality`, `aggregation`)별로 통과·실패로 센 수 |
| `largest` | 행이 가장 많은 표의 `rowCount`와 프로파일·검사 작업의 `profileMs`·`checkMs`. **작업이 큐에서 기다린 시간을 포함한 상한**입니다(작업에 시작 시각이 없음). 작업이 없으면 `null` |

**붙이기.** 파일의 숫자와, 프로파일을 켤지 정한 결과(켠다·끈 채로 둔다·더 잰다)를 이슈 #24(S03)에 남깁니다. 글, 값, 항목 이름, 설정 파일은 붙이지 않습니다.

**이 절차가 확인하지 못하는 것(미검증으로 둡니다).** 이 실행기는 Windows에서 돌려 본 적이 없습니다. 설치본의 정본 경로가 `%LOCALAPPDATA%\PKI\pki.sqlite`와 같은지(포크의 빌드에서)와 실제 Provider가 열 이름·집계를 맞게 돌려주는지는 확인하지 못했습니다. 표가 아닌 것의 이유별 수는 세지 않습니다. 숫자가 작으면 정밀도로 읽을 수 없습니다.
