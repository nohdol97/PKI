# R04 결과 기록 양식 (이슈 #13에 붙여 넣기)

> **붙이는 것은 허용 목록 `result.md`(R04는 `sanitize` 결과)뿐이며 `raw/`는 붙이지 않습니다. 값은 `facts`/`metrics` 열의 숫자·판정어입니다.**
>
> **상태: 양식만 있음 — 실행 결과가 아닙니다.** `sanitize_result.py`를 거친 `result.md`를 붙이고 아래 표에 해석을 적습니다. 숫자는 합격선이 없는 기록입니다(R05 이후 판정).

```text
실행일: <YYYY-MM-DD>   실행 위치: 깨끗한 Windows 11 VM (빌드 <번호>), 스냅샷에서 시작
설치 파일: V01 skeleton <버전 또는 커밋>   키트 버전: <커밋 SHA>
```

| 기준 | 항목 id | 판정 | 관찰값 | 충족/미충족 이유 | 미검증 |
|---|---|---|---|---|---|
| R04-C1 | `R04-C1:preflight` | <PASS/FAIL> | <발견된 런타임 범주> | | |
| R04-C1 | `R04-C1:install`, `R04-C1:uninstall` | | <종료 코드, 남은 항목 수> | | |
| R04-C1 | `R04-C1:roundtrip-api` + 수동 A표의 브라우저·Electron | | | | |
| R04-C1 | `R04-C1:single-instance`, `R04-C1:graceful-stop` | | | | |
| R04-C2 | `R04-C2:worker-orphans` (두 번째 설치 파일) | <PASS/FAIL/NOT_APPLICABLE> | | | 두 번째 설치 파일 없음(R04-S2) |
| R04-C3 | 메트릭 `installer_size_bytes`, `installed_size_bytes` | 기록 | <MB> | | |
| R04-C3 | 메트릭 `startup_*`, 수동 콜드 스타트 | 기록 | <중앙값 ms, 콜드 초> | | |
| R04-C3 | 메트릭 `idle_*` | 기록 | <RSS 중앙값/p95/최대 MB, CPU %> | | |
| R04-C3 | `R04-C3:signature-*`, 수동 C표 | | <상태별 개수, 서명 안 된 파일 수> | | 서명·업데이트 결정 미확정 사항 |

**통과 처리 가능 여부:** Windows 11에서 실행한 항목만 충족으로 적는다. 실행하지 못한 항목은 "미검증"으로 남기고 release blocker로 표시한다(#37).
