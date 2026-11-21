# R03 결과 기록 양식 (이슈 #12에 붙여 넣기)

> **상태: 양식만 있음 — 실행 결과가 아닙니다.** 아래 `<...>`를 `result.md`/`result.json`의 값으로 채웁니다.

```text
실행일: <YYYY-MM-DD>   실행 위치: 배포처 Windows 11 (빌드 <번호>), 합성 데이터와 eval/golden만
키트 버전: <커밋 SHA>   R02 결과 참조: <프로필 이름, CLI 버전, 판정>
```

## 고정 버전 (실제로 돌린 것)

| 대상 | 돌린 버전 | release/HEAD | 설치 명령 | 비고 |
|---|---|---|---|---|
| LightRAG | <1.5.7 또는 SHA> | <release/HEAD> | | |
| cognee | <1.6.10 또는 SHA> | | | |
| sage-wiki | <v0.2.13 또는 SHA> | | | |
| cortexdb | <v2.157.1 또는 SHA> | | | |
| 임베딩 런타임 | <fastembed 0.9.1 등> | | | |
| 모델 | BAAI/bge-m3 <HF SHA>, intfloat/multilingual-e5-base <HF SHA> | | | |

## 기준별 결과

| 기준 | 항목 id | 판정 | 관찰값 | 충족/미충족 이유 | 미검증 |
|---|---|---|---|---|---|
| R03-C1 | `R03-C1:<엔진>:import`…`restart` | <PASS/FAIL/NOT_RUN> | <단계별 시간, LLM 호출 수, 최대 RSS, 저장 크기> | | |
| R03-C2 | `R03-C2:cli-adapter`, 시나리오의 `llm_by_purpose` | | <호출 종류별 횟수, shim이 거절한 요청 종류> | | |
| R03-C3 | `R03-C3:embed:<모델>`, `R03-C3:offline:<모델>` | | <dim, load, docs/s, 최대 RSS, 모델 캐시 크기> | | scorer 점수: <값, 한국어/영어/혼용별> |
| R03-C3 | 라이선스 파일 | | <파일 이름·해시> | 모델 라이선스: <확인한 값> | |
| R03-C4 | `R03-C4:store:sqlite:*`, `R03-C4:store:cortexdb:*` | | <as_of, span, 삭제 계통, 삭제 뒤 이력 행, export> | | |
| R03-C4 | `R03-C4:durability:*` | | <crash 뒤 무결성, 동시 읽기 오류 수, 단일 writer 거동> | | 엔진 대상 점검: <했는가> |

## 후보 비교 요약 (사람이 판단)

- 시간 유효성·span 근거·사용자 교정 보존·삭제 계통을 **함께** 제공한 후보: <있음/없음, 근거>
- "제품 SQLite가 정본, 엔진은 투영" 가설과 "엔진이 정본"의 비교: <관찰 요약>
- 실제로 필요한 저장소(SQLite / vector / graph): <선정 후보와 이유>

**미검증 범위:** <실행하지 못한 어댑터(S1~S5), 오프라인 네트워크 차단 여부, Windows 빌드 하나만 시험 등>
