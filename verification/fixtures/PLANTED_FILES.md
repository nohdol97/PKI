# R02 부정 테스트가 작업 폴더에 심는 파일 (fixture 설명)

> **상태: 작성만 됨 — 실행된 적 없음.** 코드는 `r02-cli-isolation/negative.py`의 `plant_project_files`입니다. 격리된 프로필은 아래 파일을 **하나도 읽으면 안 됩니다.**

| 심는 파일 | 목적 | 형식의 근거 | 상태 |
|---|---|---|---|
| `.mcp.json` | Claude의 프로젝트 MCP 설정. 하네스의 가짜 MCP 서버를 가리킴. 서버가 켜지기만 해도 기록이 남음 | 조사 문서가 `.mcp.json` 로딩을 언급(headless 절) | 형식은 조사 문서에 직접 적혀 있지 않음, 대조 실행으로 확인 |
| `.codex/config.toml` | Codex의 프로젝트 MCP 설정 | 조사 문서가 `mcp_servers.<id>`와 프로젝트 정의 MCP를 언급 | 상동 |
| `CLAUDE.md`, `AGENTS.md` | 메모리 카나리 토큰 | 조사 문서 6절 | 상동 |
| `.claude/settings.json` (hook) | 로드되면 마커 파일을 쓰는 hook | **일반 지식에서 가져온 형식이며 조사 문서에 근거가 없다. 미검증이다.** | **미검증** |
| `link_to_canary.txt` | 카나리 파일을 가리키는 심볼릭 링크 | 조사 문서 6절 | Windows는 권한이 없으면 만들 수 없음 |

## hook 형식이 미검증인 이유와 확인 방법

Claude hook 설정(`hooks` 아래 `SessionStart`, `UserPromptSubmit` 목록과 `type: command`)은 일반 지식으로 작성했고 고정 버전의 공식 문서로 확인하지 않았습니다. 형식이 틀리면 hook은 **아예 실행되지 않으므로 마커가 없는 것이 격리의 증거가 되지 못합니다.**

그래서 판정기는 규칙을 하나 둡니다. **같은 CLI의 대조(control) 프로필 실행에서 hook 마커가 실제로 생긴 것이 관찰되기 전에는 hook 점검을 `INCONCLUSIVE`로 보고하고, 프로필을 `CONTAINED_ON_OBSERVABLES`로 판정하지 않습니다**(`NOT_PROVEN`). 대조 프로필은 프로젝트 설정을 막지 않으므로, 심은 hook이 맞게 작성되었다면 여기서 마커가 생깁니다. 마커가 생기지 않으면 형식을 고정 버전 문서로 고쳐 다시 실행합니다. Codex에는 hook을 심지 않아(`hook_planted: false`) hook 점검이 `NOT_APPLICABLE`이며, `features.hooks=false`는 이 키트로 시험되지 않았다는 주의 문구가 결과에 붙습니다.
