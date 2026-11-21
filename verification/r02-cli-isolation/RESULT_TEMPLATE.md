# R02 결과 기록 양식 (이슈 #11에 붙여 넣기)

> **붙이는 것은 허용 목록 `result.md`(R04는 `sanitize` 결과)뿐이며 `raw/`는 붙이지 않습니다. 값은 `facts`/`metrics` 열의 숫자·판정어입니다.**
>
> **상태: 양식만 있음 — 실행 결과가 아닙니다.** 아래 `<...>`를 `result.md`/`result.json`의 값으로 채웁니다. `result.md` 전체를 붙여도 됩니다(이미 마스킹됨). 붙이기 전에 [verification/README.md](../README.md)의 "붙이면 안 되는 것"을 확인합니다.

```text
실행일: <YYYY-MM-DD>   실행 위치: 배포처 Windows 11 (빌드 <번호>), 테스트 계정, 합성 데이터만
키트 버전: <커밋 SHA>   고정 버전: claude <버전>, codex <버전>   모델: <이름>
실행 명령: python run.py all --include-controls --confirm-test-account --model-claude <..> --model-codex <..> --repeat <N>
```

| 기준 | 결과 항목(result.json id) | 판정 | 관찰값(한 줄) | 충족 이유 / 미충족 이유 |
|---|---|---|---|---|
| R02-C1 | `R02-C1:detect:claude`, `...:codex` | <PASS/INCONCLUSIVE> | <버전, 경로 종류, 인증 상태> | |
| R02-C1 | `R02-C1:capabilities:*` | <PASS> | <프로필별 빠진 옵션> | |
| R02-C1 | `R02-C1:not-installed:*`, `R02-C1:not-logged-in:*` | <PASS/INCONCLUSIVE> | | |
| R02-C2 | `R02-C2:positive:<프로필>`, `R02-C2:flags:<프로필>` | <PASS/FAIL> | | |
| R02-C3 | `R02-C3:negative:<프로필>` | <PASS/BLOCKED/INCONCLUSIVE> | <contained/leaked/inconclusive 개수> | |
| R02-C3 | `R02-C3:sensitivity:<대조 프로필>` | <PASS/INCONCLUSIVE> | <울린 관찰값> | |
| R02-C3 | `R02-C3:cancel:*` | <PASS/FAIL/INCONCLUSIVE> | <반복 수, 생존 프로세스 수> | |
| R02-C4 | (스크립트 없음) `TERMS_CHECKLIST.md` 기록 | <허용/금지/모호/미확인> | | 미확인은 지원 아님 |

**격리 보장 판정(버전별):** `<프로필>`: `<CONTAINED_ON_OBSERVABLES | BLOCKED | NOT_PROVEN>`. 자동 실행 허용: <예/아니오>. BLOCKED면 이 버전의 백그라운드 자동 실행은 차단한다.

**미검증 범위:** <OS 수준 추적을 했는가(R02-S2), 반복 횟수, 대조가 울리지 않은 관찰값, Windows 빌드 하나만 시험했다는 점 등>
