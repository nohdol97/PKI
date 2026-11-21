# ADR 0004: 저장소 — better-sqlite3 정본, sqlite-vec 벡터, 그래프 DB 없음

- 날짜: 2026-11-21 / 상태: **잠정 — 배포처 검증 대기**
- 관련: 원 설계 15절, [ARCHITECTURE 4절·5.4절](../ARCHITECTURE.md), [OSS_EVALUATION 4.3절·4.7절·4.8절](../OSS_EVALUATION.md), 가정 A07, A08, A17

## 맥락

원 설계는 별도 DB 서버 없이 임베디드 저장소를 쓰라고 한다. 조사 결과(전부 설치·실행 없이 읽은 것이다):

- better-sqlite3: MIT, win32-x64 미리 빌드된 바이너리 동봉, 위험 "낮음". Electron에서 재빌드 없이 로드되는지는 추정이며 미시험(4.3절).
- sqlite-vec: MIT OR Apache-2.0, Windows용 바이너리 있음. 그러나 "pre-v1", 개인 유지보수자, 2026-05-21 이후 commit 0, 서명 없는 `vec0.dll`이 Windows Smart App Control에 차단된 이슈 #368이 있어 위험 "**높음**". 검색은 전수 비교다(4.3절).
- Kuzu는 보관 처리, LadybugDB는 그 포크로 0.x(4.3절, 4.7절 3번). cortexdb는 보류(5.1절).
- node:sqlite는 릴리스 후보 단계이고 확장 로딩이 Electron에서 되는지 미검증(4.3절).

## 결정

- **정본 데이터 전부**를 better-sqlite3로 SQLite 파일 하나에 둔다. 쓰는 쪽은 백엔드 프로세스 하나다.
- **벡터**는 sqlite-vec로 별도 파일에 둔다. 투영이므로 지우고 다시 만들 수 있다.
- **Phase 1에 그래프 DB는 없다.** 관계는 정본의 행이다. LadybugDB나 cortexdb는 나중에 어댑터 뒤에서만 쓴다.
- 정본 SQLite 앞에 좁은 **SQL 드라이버 포트**(열기, 실행, 트랜잭션, 확장 불러오기)를 두어 드라이버를 바꿀 수 있게 한다. 벡터 쪽은 `VectorIndex` 어댑터다.
- **키워드 검색**은 SQLite의 전문 검색 기능으로 정본 파일 안에 둔다. 모델이 없어도 동작해야 하기 때문이다. 쓰는 드라이버 빌드에 그 기능이 들어 있는지와 한국어 품질은 OSS_EVALUATION이 다루지 않았으므로 가정 A17로 둔다.

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| LanceDB를 벡터 기본값으로 | Apache-2.0이고 유지보수는 활발하나 win32-x64 바이너리가 압축 해제 약 356 MB다(4.3절). Phase 1의 작은 코퍼스에는 과하다. **차선**으로 남긴다 |
| node:sqlite | 릴리스 후보 단계, 확장 로딩 미검증(4.8절 "아직 채택하지 않음") |
| LadybugDB를 지금 도입 | Phase 1의 질의는 한두 단계 조인이라 그래프 DB가 필요 없다. 0.x이고 Windows 실행 미검증 |
| DuckDB | 관계형이고 2.0.x가 나온 지 하루였다(4.3절). SQLite 대비 이점이 Phase 1에 없다 |
| 벡터를 앱 코드의 전수 코사인 비교로 | OSS_EVALUATION 4.8절이 작은 코퍼스용 선택지로 든다. sqlite-vec 로드가 실패할 때의 교체안으로 남긴다(A08) |

## 결과

- sqlite-vec의 위험(유지보수, 서명)은 `VectorIndex` 뒤에 격리된다. 확장이 로드되지 않으면 제품은 "벡터 검색 사용 불가"를 알리고 키워드 검색으로 계속 동작한다.
- Phase 1 완료 기준 중 벡터 **검색**을 요구하는 것은 없다(V01-C6은 embedding 왕복만 요구). 따라서 sqlite-vec 문제가 Phase 1을 막지 않는다.
- 네이티브 모듈(`.node`, `.dll`)은 설치본에서 서명·압축 해제 설정이 따로 필요할 수 있다(4.7절 4번, A07, A08).
- 정본 파일의 암호화는 [ADR 0010](0010-encryption-at-rest.md)에서 다룬다.
