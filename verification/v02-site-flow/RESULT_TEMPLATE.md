# V02 배포처 검증 결과 기록 양식 (이슈 #17에 붙여 넣기)

> **붙이는 것은 허용 목록 `result.md`뿐이며 `raw/`는 붙이지 않습니다.**
>
> **상태: 양식만 있음 — 실행 결과가 아닙니다.** `run.py record`가 만든 `result.md`를 붙이고 아래 표에 해석을 적습니다. Provider와 버전 같은 값은 `result.md`에서 그대로 옮기고, 설정 파일에 적은 값(특히 모델 이름)을 손으로 적지 않습니다.

```text
실행일: <YYYY-MM-DD>   실행 위치: 깨끗한 Windows 11 (빌드 <번호>), R04 설치 파일로 설치
앱 버전: <result.md의 app_version>   키트 버전: <result.md의 kit_commit>
Provider: <result.md의 provider_id> <result.md의 version 또는 model, 해시 h:… 도 그대로>
```

| 기준 | 항목 id | 판정 | 관찰값 | 충족/미충족 이유 | 미검증 |
|---|---|---|---|---|---|
| V02-C4 | `V02-C4:site-flow` | <PASS/FAIL/INCONCLUSIVE> | <정본의 수, 성공 호출 수> | | |
| V02-C4 | 같은 커밋의 `v02-flow.e2e` 기록(browser, electron) | 기록 | Provider 종류 `test-double` (RUNBOOK 6절의 `run.py summarize --commit <배포처 기록의 commit>`) | | `kit_commit`이 `unknown`이면 미검증 |
| V02-C1·A21 | `dropped_quotes`, `dropped_other` | 기록 | <수> | | 합격선 없음(R05) |

**통과 처리 가능 여부:** Windows 설치본에서 실제 Provider로 실행한 항목만 충족으로 적는다. test double 결과는 실제 Provider 결과로 옮겨 적지 않는다. 실행하지 못한 항목은 "미검증"으로 남긴다.

---

# I03 큐·스케줄러 복구 시나리오 결과 기록 양식 (이슈 #20에 붙여 넣기)

> **붙이는 것은 허용 목록 `result.md`뿐이며 `raw/`와 수동 확인 기록은 붙이지 않습니다.**
>
> **상태: 양식만 있음 — 실행 결과가 아닙니다.** 시나리오마다 `run.py queue-scenario record`가 만든 `result.md`를 붙이고 아래 표에 해석을 적습니다. 값은 `result.md`에서 그대로 옮깁니다.

```text
실행일: <YYYY-MM-DD>   실행 위치: 깨끗한 Windows 11 (빌드 <번호>), R04 설치 파일로 설치
앱 버전: <result.md의 app_version>   키트 버전: <result.md의 kit_commit>
```

| 시나리오 | 항목 id | 판정 | 효과 행 / 합쳐진 slot | 관찰 | 충족/미충족 이유 | 미검증 |
|---|---|---|---|---|---|---|
| `kill` | `I03-C2:queue-scenario` | <PASS/FAIL/INCONCLUSIVE> | <effect_rows> / <merged_slots> | <observed> | | |
| `sleep` | `I03-C2:queue-scenario` | | | | | 수동 확인 기록의 잔 시간은 사람이 적은 값. 합쳐진 slot은 그 기록의 시간대와 겹치는 간격만 센 값 |
| `hibernate` | `I03-C2:queue-scenario` | | | | | 같음 |
| `clock-forward` | `I03-C2:queue-scenario` | | | | | |
| `clock-back` | `I03-C2:queue-scenario` | | | | | |
| `timezone` | `I03-C2:queue-scenario` | | | | | 바뀐 시간대의 반영 시점(I03-A5)은 사람의 관찰 |

**통과 처리 가능 여부:** Windows 설치본에서 여섯 시나리오를 모두 실행한 경우에만 S19를 충족으로 적고(I03 spec C1·C2의 "Windows 설치본" 남는 것), 실행하지 못한 시나리오는 "미검증"으로 남긴다. 전원 차단은 이 양식의 범위 밖이다(A20, S13). 사외의 가짜 시계 결과를 실제 절전의 결과로 옮겨 적지 않는다.
