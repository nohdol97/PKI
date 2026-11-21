# OSS 평가 — 지식 엔진 후보와 스택 (R01)

- 날짜: 2026-11-21
- 관련: [R01 spec](specs/2026-11-21-R01-oss-evaluation.md), 이슈 #10, 원 설계 [original-design.md](design/original-design.md)
- 상태: 소스·메타데이터 읽기 결과. 실행 검증 전

이 문서는 제품이 재사용할 오픈소스 엔진과 기술 스택 후보를 비교하고 채택/보류/기각을 기록한다. 결론을 먼저 말하면, 이번 조사에서 **채택(확정)한 엔진은 없다.** 후보 3개를 R03(실행 확인)으로 넘기고, 나머지는 기각하거나 참고로만 남겼다.

## 0. 읽는 법

- **고정 commit**: 평가한 코드가 나중에 바뀌어도 같은 내용을 다시 볼 수 있도록, 각 저장소의 특정 commit 전체 SHA에 링크를 고정했다(permalink). 링크는 `https://github.com/<저장소>/blob/<SHA>/<경로>#L<줄>` 형태다.
- **"가능"의 뜻**: 아무것도 설치하거나 실행하지 않았다. 표의 "가능/있음"은 모두 "소스 또는 문서에 그 메커니즘이 있다"는 뜻이다. **Windows 11에서의 실제 동작은 전부 미검증**이며 R03, R04에서 실행으로 확인한다.
- **미검증**: 보고서가 확인하지 못했다고 적은 항목은 이 문서도 미검증으로 적는다. 추측으로 채우지 않았다.
- 수집일은 2026-11-21이다. 가져온 README·이슈 본문은 자료로만 읽었고 지시로 따르지 않았다.

## 1. 판정 방법

점수를 매기기 전에 **탈락 조건을 아래 순서로 먼저 적용**한다. 하나라도 걸리면 그 후보는 점수와 무관하게 엔진으로는 기각한다. 점수는 탈락하지 않은 후보끼리 비교할 때만 쓰며, 이번 문서에서는 점수를 계산하지 않았다.

| 순서 | 탈락 조건 | 쉬운 설명 |
|---|---|---|
| ① | Windows 11 native 실행 | WSL이나 Linux 가상환경 없이 Windows 11에서 직접 돌아가는 경로가 소스·패키지에 있어야 한다 |
| ② | 서버/Docker 불필요 | 사용자 PC에 별도 DB 서버나 Docker를 설치하게 만들면 안 된다. 앱 하나로 설치되어야 한다 |
| ③ | 근거(provenance)·삭제 시 파생물 제거 | 지식이 어느 원문에서 나왔는지 추적되고, 원문을 지우면 그 원문에서만 나온 요약·관계가 함께 사라져야 한다 |
| ④ | 재배포 라이선스 | 제품 라이선스가 MIT(2026-11-21 결정)이므로, 설치 파일에 같이 넣어야 하는 구성요소가 GPL, AGPL, SSPL, BSL, 비상업 라이선스이면 탈락이다 |

**근거의 한계.** 모든 근거는 소스와 메타데이터를 읽은 것이다. 코드를 실행한 적이 없다. 그래서 "가능"은 "메커니즘이 소스에 있다"일 뿐이고, 실제로 동작하는지, Windows에서 되는지는 R03, R04 전까지 **미검증**이다. 이 구분을 판정 칸에서도 유지한다.

(참고) 용어: **SSPL**은 서버 소프트웨어용 강한 카피레프트 라이선스, **BSL**은 일정 기간 뒤에야 오픈되는 제한 라이선스다. 둘 다 MIT 제품에 묶어 배포하기 어려워 탈락 대상으로 본다.

## 2. 계획된 후보 6개 (소스 재검증)

고정 commit은 모두 수집 시점 기본 브랜치의 HEAD였고 `git rev-parse HEAD`로 다시 확인했다.

### 2.1 비교표

각 칸의 괄호 안 `E`번호는 2.2의 근거 링크다. "소스에 있음"은 실행 확인이 아니다.

| 항목 | cognee | graphiti | LightRAG | memind | ddsyasas/llm-wiki | Astro-Han/karpathy-llm-wiki |
|---|---|---|---|---|---|---|
| 고정 SHA | `1961133d0c68` | `9b8a4630092` | `01261ed135bf` | `7536460664228` | `e8dd69ebba0d` | `eafcc77001e4` |
| commit 날짜(UTC) | 2026-11-20 | 2026-11-20 | 2026-11-20 | 2026-08-13 | 2026-06-04 | 2026-07-23 |
| 최신 release | v1.6.10 (2026-11-18) | v0.31.2 (2026-10-20) | v1.5.8rc1 (2026-11-15), PyPI 최신 1.5.7 | 0.2.0 (2026-08-13) | v1.2.3 (2026-05-26) | 없음(릴리스·태그 0) |
| 라이선스 | Apache-2.0 (E1.1) | Apache-2.0 (E2.1) | MIT (E3.1) | Apache-2.0 (E4.1) | MIT (E5.1) | MIT (E6.1) |
| 런타임 | Python >=3.10,<3.15 | Python >=3.10 (임베디드 DB는 3.12 이상) | Python >=3.11 (HEAD 기준) | Java 21(Spring Boot) | Node >=20, Next.js 14 | 에이전트 skill(마크다운) + 표준 라이브러리 Python 스크립트 1개 |
| ① Windows native | 부분: wheel·분류자는 있으나 OpenSSL DLL 보정 코드와 Windows 이슈가 있음 (E1.1, E1.3, 4절) | 아니오(임베디드 경로): falkordblite에 Windows wheel 없음 (E2.3) | 부분: Windows용 파일 잠금·원자적 쓰기 경로가 소스에 있음 (E3.8) | 미검증(Windows 근거 없음) (E4.6) | 부분: README 주장만 있음 (E5.6) | 미검증 |
| ② 서버/Docker 불필요 | 소스에 있음(기본값): SQLite+LanceDB+Ladybug 임베디드 (E1.2) | 아니오(Windows): 기본값은 Neo4j 서버, 임베디드는 SSPL FalkorDB (E2.2, E2.3) | 소스에 있음(기본값). 단 파일 저장소는 "소규모 테스트용"이라고 문서에 적혀 있음 (E3.4) | 서버 불필요(SQLite)지만 JVM 필요, README 권장 시작은 Docker Compose (E4.2) | 소스에 있음(SQLite+파일) (E5.2) | 소스에 있음(파일) |
| ③ 근거(provenance) | 소스에 있음: edge → chunk → 문서 개정 → 파이프라인 실행 (E1.9). 문자 위치 없음 | 부분: episode 단위만 (E2.5) | 부분: chunk 단위. 일부 chunker는 원문 span 보조 파일이 있음 (E3.9) | 부분: item → raw data id (E4.5) | 부분: 페이지 → 원본 id (E5.5) | 부분: `Raw` 필드를 문자열 검색으로 확인 (E6.3) |
| ③ 삭제 시 파생물 제거 | 소스에 있음: `forget()`이 그래프·벡터·원본·세션을 함께 제거 (E1.8). 공유 사실 보존은 미검증 | 부분: `remove_episode`가 단독 근거 edge·node 제거, 트랜잭션 없음 (E2.6) | 소스에 있음: `adelete_by_doc_id`가 추출 캐시로 영향받은 항목을 재구성 (E3.5). 반쯤 끝난 삭제는 복구 도구 필요 | 아니오: 원문 문서 삭제 API 없음 (E4.4) | 아니오: 삭제해도 파생 페이지를 남김 (E5.5) | 아니오: 범위 밖으로 명시 (E6.3) |
| ④ 재배포 라이선스 | 직접 의존성 중 GPL/AGPL/SSPL/BSL/비상업 없음(PyPI 최신 기준). 전이 의존성·모델 가중치는 미검증 (3절) | 서버 기본값 Neo4j는 GPL-3.0, 임베디드 FalkorDB는 SSPL v1 (E2.3, 아래 라이선스 표) | 직접 의존성 중 해당 없음. 전이 의존성 미검증 | 저장소는 Apache-2.0. mysql-connector-j 조건 미확인, Spring 계열 미검증 (E4.2) | 저장소 MIT. npm 전이 의존성 미검증 | stdlib만 사용 |
| 증분 갱신 | 소스에 있음: `update(..., chunk_level_diff=True)` (E1.7). 바뀌지 않은 chunk의 LLM 재추출 생략은 미검증 | 부분: 문서 정체성 없음, 삭제 후 재추가 또는 새 episode (E2.6) | 부분: 삭제 후 재수집만(같은 이름·같은 내용은 중복으로 거부) (E3.6) | 없음: 같은 contentId는 건너뜀 (E4.5) | 없음 (E5.5) | 없음 (E6.3) |
| 사용자 정의 LLM client | 부분: provider 닫힌 목록, 등록 훅 없음. CLI를 쓰려면 로컬 OpenAI 호환 shim 필요(미검증) (E1.4) | 있음: `LLMClient` 추상 클래스 (E2.4). 생략하면 OpenAI 기본값으로 대체됨 | 있음: `llm_model_func` 호출 가능 객체 (E3.2) | 있음(Java 인터페이스) (E4.3) | 부분: OpenAI SDK 모양을 요구 (E5.3) | 해당 없음(에이전트가 LLM) |
| 사용자 정의 embedder | 부분: 엔진 고정 목록, 기본은 영어 전용 `bge-small-en-v1.5` (E1.5) | 있음: `EmbedderClient` (E2.4) | 있음: `EmbeddingFunc`, tokenizer도 주입 가능 (E3.3) | 부분: Spring AI `EmbeddingModel` (E4.3) | 없음: 임베딩 자체가 없음 (E5.2) | 없음(벡터 미사용 설계) |
| 시간 유효성(valid-from/to) | 부분/없음: 데이터 항목 개정 단위의 `valid_from`·`valid_until`만, 사실(edge)에는 없음 (E1.9) | 있음: edge의 `valid_at`·`invalid_at`·`expired_at` (E2.5) | 없음 (E3.9) | 부분: 사건 시각만, 유효 구간 아님 (E4.5) | 없음(생성·수정일만) (E5.5) | 없음 |
| 성숙도 신호 | 90일 commit 2,894, 최근 7일 작성자 10명. stars·기여자 수 미기록 | 90일 commit 129, 최근 7일 작성자 4명. stars 미기록 | 90일 commit 2,299, 최근 7일 작성자 6명. stars 미기록 | 90일 commit 0, 906 stars, 열린 이슈 15 (E4.6) | 90일 commit 0, 75 stars (E5.6) | 90일 commit 0, 2,780 stars (E6.3) |

주의: 90일 commit 수는 GitHub API의 기본 브랜치 commit 개수이며 병합·봇 commit을 포함한다. 활동량을 보여 줄 뿐 품질을 뜻하지 않는다. 시간 유효성은 6개 후보 중 graphiti만 소스에 있다.

### 2.2 근거 링크

Permalink 접두는 후보마다 같다.

**cognee** (`https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/`)

- E1.1 런타임·라이선스·Windows 분류자: [pyproject.toml#L11-L22](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/pyproject.toml#L11-L22). 분류자는 주장이지 테스트가 아니다.
- E1.2 임베디드 구성: 기본 그래프 provider [graph/config.py#L47](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/databases/graph/config.py#L47), 의존성 [pyproject.toml#L36-L140](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/pyproject.toml#L36-L140), UI 실행기의 Node/Docker 요구 [README.md#L239](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/README.md#L239)(라이브러리만 쓰면 해당 없음).
- E1.3 Windows 보정: [_windows_openssl.py#L1-L30](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee_db_workers/_windows_openssl.py#L1-L30), [pyproject.toml#L121-L124](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/pyproject.toml#L121-L124). 보정 코드가 있다는 증거이지 묶인 사이드카에서 통한다는 증거가 아니다.
- E1.4 LLM provider: [get_llm_client.py#L79-L103](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/get_llm_client.py#L79-L103)(닫힌 목록), [#L399-L400](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/get_llm_client.py#L399-L400)(미지원 시 오류), [#L105-L112](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/get_llm_client.py#L105-L112)(API 키 요구), [#L300-L317](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/get_llm_client.py#L300-L317)(`custom` = OpenAI 호환 어댑터), 추상 인터페이스 [llm_interface.py#L13-L37](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/llm_interface.py#L13-L37). 등록 훅 비교 대상 [use_graph_adapter.py#L4-L5](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/databases/graph/use_graph_adapter.py#L4-L5)(DB 어댑터만 등록). 키 없는 `mcp-sampling`은 MCP 호스트 위임이며 CLI 래퍼가 아니다 [adapter.py#L1-L12](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/mcp_sampling/adapter.py#L1-L12).
- E1.5 embedder: [get_embedding_engine.py#L126-L190](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/databases/vector/embeddings/get_embedding_engine.py#L126-L190), 기본 모델 [config.py#L30](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/infrastructure/databases/vector/embeddings/config.py#L30). 한국어는 다국어 모델을 설정해야 하며 미검증.
- E1.6 문서당 LLM 호출: [cognify.py#L700-L760](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/api/v1/cognify/cognify.py#L700-L760), [extract_graph_and_summarize.py#L15-L45](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/tasks/graph/extract_graph_and_summarize.py#L15-L45), [cognify/config.py#L22](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/cognify/config.py#L22). 기본은 chunk당 1회, `summary_method="llm"`이면 2회, `extractor="gliner"`면 0회([cognify.py#L158](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/api/v1/cognify/cognify.py#L158)).
- E1.7 증분 갱신: [update.py#L36-L90](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/api/v1/update/update.py#L36-L90), [incremental_chunking.py](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/chunking/incremental_chunking.py).
- E1.8 삭제: [forget.py#L36-L100](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/api/v1/forget/forget.py#L36-L100), [#L546-L600](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/api/v1/forget/forget.py#L546-L600), 공유 노드 소유 표기 [provenance/__init__.py#L1-L12](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/provenance/__init__.py#L1-L12).
- E1.9 근거·시간: [edge_evidence/__init__.py#L1-L33](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/provenance/edge_evidence/__init__.py#L1-L33)(`improve()`·세션 연결·코드 그래프 edge는 근거 행이 아직 없다고 명시), 해시 체인 원장(기본 꺼짐 `PROVENANCE_TRACKING`) [provenance/__init__.py#L1-L40](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/provenance/__init__.py#L1-L40), [마이그레이션#L56-L57](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/alembic/versions/b8c1d3e5f7a9_add_provenance_entries_table.py#L56-L57), 시간 파이프라인 제거 [test_removed_temporal_cognify.py#L1-L6](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/tests/unit/api/v1/cognify/test_removed_temporal_cognify.py#L1-L6), 충돌 상태 "current/superseded"(유효 구간 아님) [conflicts/methods.py#L214-L218](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/cognee/modules/conflicts/methods.py#L214-L218).
- E1.10 저장 안전성: [pyproject.toml#L106-L120](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/pyproject.toml#L106-L120)에 이전 Ladybug 계열의 저장소 손상 결함과 열 수 없게 된 저장소 버그 기록. 저장소 3종(SQLite, Ladybug, LanceDB) 사이 트랜잭션은 찾지 못했다.
- E1.11 무게: [pyproject.toml#L17-L143](https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/pyproject.toml#L17-L143)에 `fastapi`, `gunicorn`, `litellm` 등이 코어 의존성. 사이드카 설치 크기는 미측정.

**graphiti** (`https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/`)

- E2.1 [pyproject.toml#L1-L22](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/pyproject.toml#L1-L22), `falkordblite` 추가 의존성은 Python 3.12 이상 [#L34-L35](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/pyproject.toml#L34-L35).
- E2.2 백엔드는 NEO4J, FALKORDB, NEPTUNE뿐 [driver.py#L59-L62](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/driver/driver.py#L59-L62). 기본 `Graphiti(uri=...)`는 Neo4j 드라이버를 만든다 [graphiti.py#L344-L349](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/graphiti.py#L344-L349). Kuzu 임베디드 드라이버는 PR #2151(2026-11-15 병합)로 제거되었다([GitHub API로 확인](https://github.com/getzep/graphiti/pull/2151)).
- E2.3 임베디드 경로: README는 `graphiti-core[falkordblite]`에 Python 3.12+ 요구 [README.md#L206-L209](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/README.md#L206-L209). PyPI [`falkordblite` 0.11.0](https://pypi.org/pypi/falkordblite/json)은 macOS·manylinux wheel과 sdist만 있고 Windows wheel이 없다(2026-11-21 확인). [falkordblite README](https://github.com/FalkorDB/falkordblite/blob/main/README.md)(main 브랜치, 고정 아님)는 Windows는 Ubuntu용 Bash(WSL)에서만 설치 가능하다고 적는다. FalkorDB 본체 라이선스는 SSPL v1([LICENSE](https://github.com/FalkorDB/FalkorDB)).
- E2.4 [llm_client/client.py#L74](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/llm_client/client.py#L74), [embedder/client.py#L30-L40](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/embedder/client.py#L30-L40), 생략 시 OpenAI 기본값 [graphiti.py#L362-L381](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/graphiti.py#L362-L381). 원격 측정(posthog)이 기본 켜짐 [telemetry.py#L22-L36](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/telemetry/telemetry.py#L22-L36).
- E2.5 시간·근거 [edges.py#L232-L252](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/edges.py#L232-L252). episode보다 작은 span은 모델에 없다(이 읽기 범위 밖은 미검증).
- E2.6 삭제 [graphiti.py#L2523-L2600](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/graphiti.py#L2523-L2600), episode uuid 인자 [#L1586-L1604](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/graphiti.py#L1586-L1604).
- E2.7 호출 단계: [graphiti.py#L1700-L1860](https://github.com/getzep/graphiti/blob/9b8a4630092084734b080f2e6f409c2c23bdcc3a/graphiti_core/graphiti.py#L1700-L1860). episode당 LLM 단계가 최소 4개이고 조건부·반복이라 문서당 호출 수는 미검증.

**LightRAG** (`https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/`)

- E3.1 [pyproject.toml#L14-L58](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/pyproject.toml#L14-L58), 버전 [_version.py#L3](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/_version.py#L3).
- E3.2 LLM: [lightrag.py#L1143](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/lightrag.py#L1143), [ProgramingWithCore.md#L96](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/ProgramingWithCore.md#L96), 동시성·타임아웃 기본값 [constants.py#L103](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/constants.py#L103), [#L777](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/constants.py#L777). 추출 출력은 구분자 텍스트를 LightRAG가 파싱하는 방식으로 추정되며 정확한 형식은 따로 확인하지 않았다 [operate.py#L4423](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/operate.py#L4423).
- E3.3 embedder: [lightrag.py#L1073](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/lightrag.py#L1073), [utils.py#L678-L708](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/utils.py#L678-L708), [AsymmetricEmbedding.md](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/AsymmetricEmbedding.md), tokenizer 주입 [lightrag.py#L958](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/lightrag.py#L958). 기본 tokenizer 경로는 처음 쓸 때 tiktoken BPE 파일을 네트워크에서 내려받는다 [tiktoken_cache.py#L1-L30](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/tiktoken_cache.py#L1-L30)(이슈 #439, 종료). 로컬 우선 설치에는 오프라인 번들이 필요하다.
- E3.4 저장소 기본값 [lightrag.py#L824](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/lightrag.py#L824). 설계 문서가 "파일 기반 저장소 5종은 소규모 테스트·검증용, 운영은 서버형 저장소"라고 적는다 [FileBackedSnapshotContract.md#L22-L24](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/design/FileBackedSnapshotContract.md#L22-L24). 벡터와 그래프는 메모리에 있고 전체 파일을 다시 써서 저장한다. 규모 한계는 미측정.
- E3.5 삭제 [lightrag.py#L8124-L8137](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/lightrag.py#L8124-L8137), 복구 계약 [PurgeRecoveryContract.md#L198](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/design/PurgeRecoveryContract.md#L198). 반쯤 끝난 삭제의 고아 데이터는 `kg_integrity_repair`만 보고한다 [FileProcessingPipeline.md#L1085](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L1085).
- E3.6 증분 갱신 없음 [FileProcessingPipeline.md#L871-L875](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L871-L875), 옵션 변경은 삭제 후 재업로드 [#L914](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L914). 수동 KG 편집 API(`ainsert_custom_kg`, `aedit_entity/relation`)는 있다.
- E3.7 호출 수: [operate.py#L4696](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/operate.py#L4696), [#L4772](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/operate.py#L4772), 보충 추출 기본 1회 [constants.py#L24](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/constants.py#L24), 병합 시 요약 기준 8 [constants.py#L37](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/constants.py#L37), [operate.py#L564-L650](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/operate.py#L564-L650). chunk당 기본 1~2회에 병합 요약이 더해진다. chunk 수는 미측정.
- E3.8 Windows·저장 안전성: [file_atomic.py#L124-L150](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/file_atomic.py#L124-L150), [working_dir_lock.py#L121-L154](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/kg/working_dir_lock.py#L121-L154), 재시작 시 처리 중 문서 복구 [FileProcessingPipeline.md#L1062](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L1062). Gunicorn 다중 프로세스는 Windows 미지원 [LightRAG-API-Server.md#L213](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/LightRAG-API-Server.md#L213)(단일 프로세스 라이브러리 사용이 해당 모드). SVG 래스터화는 Windows에서 GTK3 런타임이 필요하다 [README.md#L280](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/README.md#L280).
- E3.9 근거: [operate.py#L2126-L2127](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/lightrag/operate.py#L2126-L2127), span 보조 파일 [FileProcessingPipeline.md#L608](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L608), [#L682](https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/docs/FileProcessingPipeline.md#L682)(사용자 정의 chunk 함수에는 없음; 이모지가 많은 글에서 span이 어긋난 버그 #4112는 종료). 시간 유효성 개념은 소스·문서에서 찾지 못했다.

**memind** (`https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/`)

- E4.1 [pom.xml#L75-L77](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/pom.xml#L75-L77)(Java 21), [LICENSE](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/LICENSE).
- E4.2 [SqliteJdbcPlugin.java#L29-L43](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-plugins/memind-plugin-jdbc/memind-plugin-jdbc-sqlite/src/main/java/com/openmemind/ai/memory/plugin/jdbc/sqlite/SqliteJdbcPlugin.java#L29-L43), [FileSimpleVectorStore.java#L41](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-plugins/memind-plugin-ai-spring-ai/src/main/java/com/openmemind/ai/memory/plugin/ai/spring/FileSimpleVectorStore.java#L41), README의 Docker Compose 권장·관리자 UI 무인증 [README.md#L103-L111](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/README.md#L103-L111), [#L179-L183](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/README.md#L179-L183), 서버 모듈의 mysql 커넥터·Qdrant 스타터 [memind-server/pom.xml#L116-L128](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-server/pom.xml#L116-L128).
- E4.3 [StructuredChatClient.java#L22-L44](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/llm/StructuredChatClient.java#L22-L44), [SpringAiMemoryVector.java#L60-L65](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-plugins/memind-plugin-ai-spring-ai/src/main/java/com/openmemind/ai/memory/plugin/ai/spring/SpringAiMemoryVector.java#L60-L65). 저장소에 로컬 CPU 한국어 embedder는 없다(미검증).
- E4.4 삭제 [Memory.java#L262-L271](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/Memory.java#L262-L271), [DefaultMemory.java#L478-L492](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/DefaultMemory.java#L478-L492)(벡터 정리 실패는 로그만), [RawDataOperations.java#L25-L55](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/store/rawdata/RawDataOperations.java#L25-L55)(삭제 메서드 없음).
- E4.5 [RawDataLayer.java#L196-L203](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/extraction/rawdata/RawDataLayer.java#L196-L203), [MemoryItem.java#L42-L66](https://github.com/openmemind/memind/blob/7536460664228a7b48e41c4ed61f2a75af244b17/memind-core/src/main/java/com/openmemind/ai/memory/core/data/MemoryItem.java#L42-L66).
- E4.6 90일 commit 0(마지막 2026-08-13), 906 stars, 열린 이슈 15. Windows 관련 이슈·문서 없음(이슈 #63은 무관).

**ddsyasas/llm-wiki** (`https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/`)

- E5.1 [apps/web/package.json#L28-L40](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/apps/web/package.json#L28-L40), [README.md#L506](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/README.md#L506), [core/package.json#L22-L25](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/packages/core/package.json#L22-L25).
- E5.2 [db.ts#L13-L48](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/packages/core/src/db.ts#L13-L48). `packages/`와 `apps/web/src`의 `.ts/.tsx`에서 `embedding|vector` 검색 결과가 없었다.
- E5.3 [llm/client.ts#L14-L40](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/packages/llm/src/client.ts#L14-L40).
- E5.4 [ingest.ts#L105](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/packages/core/src/ingest.ts#L105), [#L469-L560](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/packages/core/src/ingest.ts#L469-L560).
- E5.5 삭제 라우트 [delete/route.ts#L12-L22](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/apps/web/src/app/api/sources/%5Bid%5D/delete/route.ts#L12-L22)("해당 원본만 참조한 Wiki 페이지는 삭제하지 않는다").
- E5.6 [README.md#L241](https://github.com/ddsyasas/llm-wiki/blob/e8dd69ebba0dc7c395c1b8217bb1c30c14e8c84c/README.md#L241)(PowerShell+Node 20 검증은 저자 주장). Windows 이슈 없음, 90일 commit 0.

**Astro-Han/karpathy-llm-wiki** (`https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/`)

- E6.1 [SKILL.md#L1-L8](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/SKILL.md#L1-L8), [check_evidence.py#L36-L39](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/scripts/check_evidence.py#L36-L39).
- E6.2 [README.md#L135](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/README.md#L135).
- E6.3 [SKILL.md#L18](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/SKILL.md#L18), [#L41](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/SKILL.md#L41), 의도적으로 만들지 않은 기능 [README.md#L128-L133](https://github.com/Astro-Han/karpathy-llm-wiki/blob/eafcc77001e496cc43499e4923b663aec722c813/README.md#L128-L133).

### 2.3 핵심 의존성 라이선스 (임베디드 구성 기준)

출처는 2026-11-21에 가져온 PyPI 메타데이터와 GitHub 라이선스 필드다. PyPI "최신"은 저장소가 고정한 버전과 다를 수 있고, 전이 의존성과 모델 가중치는 확인하지 않았다.

| 후보 | 구성요소(역할) | 라이선스 | 비고 |
|---|---|---|---|
| cognee | ladybug(그래프) | MIT | win_amd64 wheel 있음, OpenSSL DLL 보정 필요 (E1.3) |
| cognee | lancedb + pylance(벡터) | Apache-2.0 | win_amd64 wheel 있음. Windows 버그 #6689는 종료 |
| cognee | fastembed, onnxruntime | Apache-2.0, MIT | 모델 가중치는 처음 쓸 때 내려받음. 모델 라이선스 미검증 |
| cognee | SQLAlchemy, aiosqlite | MIT | |
| cognee | litellm, fakeredis, rdflib, dlt, datamodel-code-generator, enola-cli, cryptography | MIT, BSD-3, BSD-3, Apache-2.0, MIT, Apache-2.0, Apache-2.0 OR BSD-3 | 직접 의존성 목록에서 GPL/AGPL/SSPL/BSL/비상업은 찾지 못함 |
| cognee | kuzu(옛 그래프 옵션) | 미확인 | pyproject가 더는 고정하지 않으나 소스 디렉터리는 남아 있음 |
| graphiti | neo4j Python 드라이버 | Apache-2.0 AND Python-2.0 | 드라이버만 |
| graphiti | Neo4j 서버(기본 백엔드) | GPL-3.0 | 별도 서버, JVM 필요. 탈락 유형 |
| graphiti | FalkorDB 엔진(falkordblite 내부) | SSPL v1 | 탈락 유형. [LICENSE](https://github.com/FalkorDB/FalkorDB) 첫 줄이 Server Side Public License VERSION 1 |
| graphiti | falkordblite 래퍼 | BSD(README "New BSD license") | Redis 서버와 FalkorDB 모듈을 함께 담음. 포함된 Redis 서버의 라이선스는 미검증 |
| graphiti | posthog, openai, redis-py | MIT, Apache-2.0, MIT | 원격 측정 기본 켜짐 (E2.4) |
| LightRAG | nano-vectordb(벡터) | MIT | 메모리 내 전수 비교, JSON 파일. 마지막 push 2026-01-09 |
| LightRAG | networkx(그래프) | BSD-3-Clause | 메모리 내 그래프 |
| LightRAG | tiktoken, json_repair, pypinyin, pandas, xlsxwriter, google-genai, pipmaster | MIT, MIT, MIT, BSD-3, BSD-2, Apache-2.0, Apache-2.0 | pipmaster가 실행 중 pip 설치를 할 수 있음(동작 미검증). 해당 클래스 없음 |
| memind | sqlite-jdbc | Apache-2.0 | 포함된 네이티브 라이브러리 라이선스는 별도 확인 못함 |
| memind | Spring Boot / Spring AI | 미확인 | |
| memind | mysql-connector-j(서버 모듈, runtime) | GitHub 필드 NOASSERTION, 조건 미확인 | 확인 전까지 번들 금지. 코어+SQLite 플러그인만 쓰면 피할 수 있음 |
| llm-wiki | better-sqlite3, keytar, next, react, three | 미확인 | 저장소 자체는 MIT |
| karpathy-llm-wiki | 없음(표준 라이브러리) | 해당 없음 | |

cognee와 LightRAG의 임베디드 기본 구성에서는 직접 의존성 기준 탈락 클래스가 나오지 않았다. 탈락 클래스에 걸리는 것은 graphiti의 백엔드 옵션(Neo4j 서버 GPL-3.0, FalkorDB SSPL)이고, memind의 mysql-connector-j만 불분명하다.

### 2.4 Windows 관련 이슈·문서 (제목 그대로)

- cognee: #6808 "Local server dies on packaged Windows hosts: inherited PYTHONPATH makes the venv import pydantic from the host app, and MSIX blocks the native .pyd"(**열림**, 2026-11-20, 묶인 사이드카 실패 유형과 닮음), #6689 "LanceDB fails to persist transaction files on Windows during cognee.remember()"(종료 2026-11-12), #6685 "Ladybug 0.22.3 bump hangs graph engine creation on Windows"(종료 2026-11-12), #6347 "CSV ingestion fails on Windows"(열림), #6344 "Uploads over 1 MiB on Windows are stored under the temp file name"(열림), #6793 Windows 비UTF-8 코드 페이지 테스트 수집 실패(열림), #6313 Windows 경로 이탈 보안 이슈(열림).
- graphiti: #1469 "add_episode crashes with Kuzu C-extension access violation on Windows"(종료, 이후 Kuzu 드라이버 제거), #1173(종료), #1623(종료). falkordblite는 WSL만 안내.
- LightRAG(모두 종료): #3879 "PermissionError [WinError 5] Access is denied during atomic_write on Windows NTFS"(2026-09-08), #4266 "chunk_tracking_repair plan sync() fails on Windows - os.fsync on a read-only handle"(2026-10-26), #4268 sidecar URI 왕복 문제(2026-10-26), #4158, #1117, #439.
- memind: Windows 이슈·문서 없음. llm-wiki: README 주장만. karpathy-llm-wiki: 검색 결과 3건이나 Windows 관련 여부는 개별 확인하지 않아 미검증.

Python 후보 3개 모두 최근에 Windows 파일 잠금·원자적 쓰기·네이티브 확장 버그가 있었고 몇 주 안에 고쳐졌다. 이는 Windows 노출이 크고 수정이 빠르다는 뜻이지 안정성의 증거가 아니다. 깨끗한 Windows 11 설치 실행은 여전히 필요하다.

## 3. 대안 후보

계획된 6개 밖에서 조사한 결과다. `n90`은 2026-08-23 이후 기본 브랜치 commit 수(API 한 페이지 상한 100, "100+"는 상한 도달)다. 새 저장소의 stars는 품질 신호로 쓰지 않았다(예: agent-memory는 11주 만에 4.3k stars).

### 3.1 최종 후보군 (5개)

| 항목 | cortexdb | sage-wiki | agent-memory (tigerless-labs) | llm-wiki-compiler | Hyper-Extract |
|---|---|---|---|---|---|
| 고정 SHA(날짜) | `50c1eeb1f2dd` (2026-11-21) | `63c9d7bd99da` (2026-11-01) | `2648ba02d3c0` (2026-11-12) | `b8e28c666ac6` (2026-11-14) | `a85b4d13662a` (2026-11-05) |
| 라이선스·언어 | MIT, Go | MIT, Go | MIT, Python | MIT, TypeScript | Apache-2.0(LICENSE 본문; GitHub는 NOASSERTION이라 재확인 필요), Python |
| 성숙도 신호(보고된 값) | 529 stars, 기여자 4명, 2025-08 생성, v2.157.1(2026-11-20), n90 100+ | 659 stars, 기여자 14명, v0.2.13(2026-10-25), n90 35 | 4,324 stars(신뢰 낮음), 기여자 22명, 2026-09-01 생성(11주), n90 100+ | 2,276 stars, 기여자 20명, n90 100+ | 4,251 stars, 기여자 20명, n90 100+ |
| Windows 바이너리 | release에 `cortexdb-grpc_windows_amd64.tar.gz` 있음(존재만 확인) | release에 `sage-wiki_v0.2.13_windows_amd64.zip` 있음(존재만 확인) | README에 언급 없음: 미검증 | 소스에 win32 분기 있음(codex 어댑터) | 미검증 |
| 대체하는 범위 | 그래프·벡터·시간·근거 저장과 결정적 정리 단계(추출·Wiki·Q&A는 제외) | compile부터 Wiki 페이지까지 전체(엔진+Wiki 계층). 수집 커넥터·인사이트·Q&A·피드백은 제품 몫 | LLM 어댑터 계층과 수면 정리(consolidation). KG·개체 해소는 아님 | Wiki 페이지 계층만 | 추출과 증분 원본 원장 |
| 사용자 정의 LLM | 코어에 LLM client 없음. 선택적 추출은 `JSONGenerator` 하나(`GenerateJSON`)로 주입 | `provider.Provider{Complete, Embed, Models}`. 주입은 `Workspace.Compile`에만 적용. 질의 시점 expand/rerank는 설정 기반으로 남음 | `Reasoner` 프로토콜. `claude -p`, `codex exec` 어댑터와 격리 플래그가 이미 있음 | `LLMProvider` 인터페이스. 프로세스 내 주입 `runWithProviderOverride`가 공개 SDK에서 닿는지 미검증 | LangChain `BaseChatModel`. CLI를 감싸는 하위 클래스를 끼울 수 있음(미제공) |
| 사용자 정의 embedder | `Embedder{Embed, EmbedBatch, Dim}`, `WithEmbedder` | 검색 경로에 주입 가능. 프로세스 내 CPU embedder 번들 여부 미검증(문서 예시는 Ollama) | `Embedder` 프로토콜, 기본 `FastEmbedder`(ONNX CPU) | 같은 인터페이스. 프로세스 내 CPU embedder 미제공 | LangChain `Embeddings`, `faiss-cpu`. 로컬 CPU 래퍼는 미제공 |
| 저장소 | SQLite 파일 1개(`modernc.org/sqlite` 순수 Go) | SQLite(순수 Go) + 자체 HNSW 벡터, `CGO_ENABLED=0` 빌드. Postgres는 선택 | 마크다운 파일 + 지워도 되는 SQLite FTS5 색인 | 파일 트리와 JSON 임베딩(64 MiB 초과 시 이진), 검색 시 색인을 메모리에 올림 | `data.json` + FAISS 색인 |
| 증분·삭제 | `delete_document_graph`가 문서의 chunk·관계·단독 개체를 제거, 공유 개체는 분리, `dry_run` 지원. 삭제가 시간 이력 행까지 지우는지, 표시만 하는지 미검증 | manifest diff에 `Removed`, 원본 삭제 처리 `handleRemovedSources`. 고아 온톨로지 edge·개체 연쇄 삭제는 미검증 | `store.delete`는 있으나 문서에 "삭제해도 파일이 저장소에 남는다"고 적힘. 소프트 삭제이며 완전 삭제 경로는 미검증 | `llmwiki rm`이 원본과 그 원본에서만 나온 페이지를 삭제(문서 기재, 실행 안 함) | `remove_source(..., strategy="exact")`가 단독 기여 키를 삭제하고 공유 키는 다시 병합 |
| 근거·시간 | edge별 `FactProvenanceFor`, 양시간(bitemporal) `valid_from/valid_to/recorded_at/retracted_at`와 `as_of`. 인용 텍스트가 문자 span인지 chunk 전체인지 미검증 | 관계에 `evidence`(지지 span), `confidence`, `source_doc`. 양시간 edge 유효성 "P3-6" | frontmatter `valid_from/invalid_at`, `recall --as-of`. 근거는 memory 단위이며 원문 span은 미검증 | 페이지 provenance와 "지지 원문 구절", 신선도(fresh/stale/orphaned). 시간 모델 없음 | 원본 원장(`he info --sources`). 근거 span 없음(소스 단위만), 유효 구간 모델 없음 |
| 위험 | CHANGELOG 255 KB, 15개월에 v2.157(API 변동 극심), 기여자 4명, 코딩 에이전트 기억 지향 | 1.0 이전("버전 고정" 권고), 주입 경로는 compile에 한정, 트리플 추출을 켜면 문서당 LLM 호출 1회 추가 | 11주 된 프로젝트, stars 신뢰 낮음, KG 아님 | Node >=24 요구(Electron 번들 Node와 호환 미검증), 표면적이 커서 fork 비용 큼 | LangChain 의존성 무게, 연구 코드 성격, JSON 저장 확장성 |

### 3.2 최종 후보군의 근거 링크

- **cortexdb** (`liliang-cn/cortexdb` @ `50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba`): 코어에 LLM client 없음 [GUIDE.md#L231](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L231), `JSONGenerator` [llm.go#L11-L13](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/graphflow/llm.go#L11-L13), `Embedder` [embedder.go#L11-L23](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/embedder.go#L11-L23), [cortexdb.go#L177-L179](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/cortexdb.go#L177-L179), 순수 Go SQLite [go.mod#L21](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/go.mod#L21), "한 파일" [GUIDE.md#L1294](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L1294), 양시간 [GUIDE.md#L543-L559](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L543-L559), as-of 조회 [facts_asof.go#L14-L40](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/cmd/cortexdb-mcp-stdio/facts_asof.go#L14-L40), 삭제 [GUIDE.md#L453](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L453), [knowledge_api.go#L440](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/knowledge_api.go#L440), [graph_cleanup.go#L30](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/graph_cleanup.go#L30), 근거 [fact_provenance.go#L61](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/fact_provenance.go#L61), [GUIDE.md#L27](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L27), [#L262](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L262), 정리 기능 [GUIDE.md#L23](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/docs/GUIDE.md#L23), [brain.go#L472](https://github.com/liliang-cn/cortexdb/blob/50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba/pkg/cortexdb/brain.go#L472). 개체 해소는 `pkg/graphflow/resolve.go`(점수화한 쌍, `possiblySame` 연결).
- **sage-wiki** (`xoai/sage-wiki` @ `63c9d7bd99da407d6f94f061ec138feae051c558`): [provider.go#L15-L22](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/pkg/provider/provider.go#L15-L22), 주입과 "설정 자격 증명으로 대체하지 않음" [engine.go#L73-L90](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/pkg/engine/engine.go#L73-L90), 연결 [methods.go#L321](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/pkg/engine/methods.go#L321), [pipeline.go#L185](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/compiler/pipeline.go#L185), embedder 주입 [engine.go#L62-L70](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/pkg/engine/engine.go#L62-L70)(질의 시점 LLM 호출이 설정 기반으로 남는다는 코드 주석은 engine.go L62-L67), 저장 [go.mod#L27](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/go.mod#L27), [Makefile#L4-L5](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/Makefile#L4-L5), 증분·삭제 [diff.go#L22](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/compiler/diff.go#L22), [pipeline.go#L509-L510](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/compiler/pipeline.go#L509-L510), [#L1968](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/compiler/pipeline.go#L1968), 근거 [ontology.go#L53-L58](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/ontology/ontology.go#L53-L58), [#L303-L329](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/ontology/ontology.go#L303-L329), 시간 [temporal.go#L12-L26](https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/internal/ontology/temporal.go#L12-L26). 청크·벡터 삭제 함수 `DeleteDocChunks`(`internal/memory/chunks.go#L54`), `DeleteDocChunkVectors`(`internal/vectors/store.go#L451`), 개체 삭제 `DeleteEntity`(`ontology.go#L280`)는 파일 경로만 보고서에 있고 고정 링크는 없다.
- **agent-memory** (`tigerless-labs/agent-memory` @ `2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7`): [reasoning.py#L50-L52](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/core/src/agent_memory/core/reasoning.py#L50-L52), `claude -p` 방언 [hosts.py#L220-L247](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/executor/src/agent_memory/executor/hosts.py#L220-L247), `codex exec` 방언 [hosts.py#L323-L338](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/executor/src/agent_memory/executor/hosts.py#L323-L338), 설계 문장 [README.md#L76-L77](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/README.md#L76-L77), [embeddings.py#L13-L16](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/core/src/agent_memory/core/embeddings.py#L13-L16), 저장 [README.md#L16-L19](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/README.md#L16-L19), 삭제 [store.py#L430](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/core/src/agent_memory/core/store.py#L430), [README.md#L97](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/README.md#L97), [#L111](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/README.md#L111), 시간 [README.md#L86-L100](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/README.md#L86-L100), [recall.py#L87](https://github.com/tigerless-labs/agent-memory/blob/2648ba02d3c0364f9787f0e8fb49f69f47d2e3f7/packages/core/src/agent_memory/core/recall.py#L87). 격리 플래그가 현재 CLI 버전에서 실제로 격리하는지는 실행하지 않아 미검증.
- **llm-wiki-compiler** (`atomicstrata/llm-wiki-compiler` @ `b8e28c666ac695fcfe7d8098eb98b8b16ef2048c`): [provider.ts#L56-L75](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/src/utils/provider.ts#L56-L75), [#L143-L172](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/src/utils/provider.ts#L143-L172), codex 어댑터 [codex-agent.ts#L4](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/src/providers/codex-agent.ts#L4), [#L158](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/src/providers/codex-agent.ts#L158), 로그인 문서 [README.md#L343-L345](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/README.md#L343-L345), 저장 [README.md#L378-L381](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/README.md#L378-L381), 삭제 [README.md#L227-L228](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/README.md#L227-L228), 근거 [README.md#L46-L48](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/README.md#L46-L48), [#L366](https://github.com/atomicstrata/llm-wiki-compiler/blob/b8e28c666ac695fcfe7d8098eb98b8b16ef2048c/README.md#L366). Claude Agent SDK 어댑터는 `src/providers/claude-agent.ts`(L165, L219-L221)에 `tools: []`가 있으나 고정 링크는 없다.
- **Hyper-Extract** (`yifanfeng97/Hyper-Extract` @ `a85b4d13662a77fbaf2a34b204964e4bec7bd743`): [graph.py#L678-L679](https://github.com/yifanfeng97/Hyper-Extract/blob/a85b4d13662a77fbaf2a34b204964e4bec7bd743/hyperextract/types/graph.py#L678-L679), [pyproject.toml#L31](https://github.com/yifanfeng97/Hyper-Extract/blob/a85b4d13662a77fbaf2a34b204964e4bec7bd743/pyproject.toml#L31), `remove_source` [graph.py#L143-L165](https://github.com/yifanfeng97/Hyper-Extract/blob/a85b4d13662a77fbaf2a34b204964e4bec7bd743/hyperextract/types/graph.py#L143-L165), [README.md#L121-L122](https://github.com/yifanfeng97/Hyper-Extract/blob/a85b4d13662a77fbaf2a34b204964e4bec7bd743/README.md#L121-L122), 시간 [temporal_graph.py#L49-L60](https://github.com/yifanfeng97/Hyper-Extract/blob/a85b4d13662a77fbaf2a34b204964e4bec7bd743/hyperextract/types/temporal_graph.py#L49-L60).

### 3.3 기각한 대안과 결정적 이유 (한 가지씩)

| 프로젝트 | 결정적 이유 |
|---|---|
| mem0 | 사실 문장 단위 기억이며 코드에 유효 구간·근거 span이 없고 Wiki 계층이 없다. 저장소는 교체형 벡터 저장소이지 권위 있는 그래프가 아니다 |
| microsoft/graphrag | 삭제된 입력을 계산하지만(`incremental_index.py:55-56`) `packages/`의 다른 곳에서 쓰지 않아 파생 지식이 제거되지 않는다. 일괄 parquet 파이프라인 |
| nano-graphrag / fast-graphrag | 휴면(마지막 commit 2026-01-27 / 2025-11-01)이며 삭제·근거 모델이 없다 |
| HippoRAG | 검색 연구 코드. 삭제해도 다른 chunk의 triple·개체가 남고 시간·근거 모델이 없다 |
| R2R, memobase, kotaemon | 6~13개월 휴면 |
| Letta, Zep OSS | 업스트림 저장소가 더는 임베드 가능한 OSS 엔진을 내지 않는다(Letta는 letta-code로, Zep 저장소는 Cloud 예제) |
| LlamaIndex PropertyGraphIndex | `_delete_node`가 노드 id 하나만 지우고 시간 모델이 없으며 기본 저장소가 메모리다 |
| Haystack, langmem, Mastra | 지식 모델이 없는 프레임워크·에이전트 런타임이다(Mastra memory는 대화·작업 기억) |
| Khoj, Reor, basic-memory, OpenViking | AGPL-3.0(Reor는 보관 처리됨) |
| nashsu/llm_wiki, inkeep/open-knowledge | GPL-3.0 |
| screenpipe | 상용 라이선스 |
| Molio | 수정된 Apache-2.0이며 "호스팅 또는 임베드 서비스"에 상용 라이선스를 요구(조항 전문은 10번째 줄까지만 읽어 나머지 미검증) |
| supermemory | 자체 호스팅 서버 바이너리가 비공개 코드베이스이고 LLM은 OpenAI 호환 endpoint로만 쓴다 |
| SurfSense, Open Notebook, WeKnora, TencentDB-Agent-Memory, MemOS, neo4j-labs/agent-memory, MemMachine | 문서화된 설치 경로가 Docker 또는 별도 DB 서버다(MemMachine의 Neo4j+Postgres는 보고서 기준 미검증 기재) |
| AnythingLLM | RAG 채팅 앱이라 KG·시간·Wiki 파이프라인과 CLI-LLM 어댑터가 없다. fork해도 UI 껍데기만 얻는다 |
| GD4AI/obsidian-llm-wiki | Obsidian 안에서만 돈다 |
| lucasastorian/llmwiki | 에이전트가 도구로 편집하는 Wiki이지 추출 파이프라인이 아니다 |
| mnemon, doobidoo/mcp-memory-service | 코딩 에이전트 기억 서비스(MCP/CLI). embedding은 외부 endpoint가 필요하다(mnemon) / 코드 미개봉(doobidoo) |
| NornicDB | 저장소 전용(cortexdb와 같은 자리). 코드 미개봉 |
| Kuzu, Cozo | 보관 처리됨 / 2년 휴면 |
| claude-obsidian, sdyckjq-lab/llm-wiki-skill | 프롬프트·skill 묶음이지 엔진이 아니다(후자는 라이선스도 없음) |
| kytmanov/obsidian-llm-wiki-local | Ollama 전용이며 휴면 |
| swarmvault | 2026-06-30 이후 휴면. 사용자 정의 provider 모듈(`generateText/generateStructured/embedTexts`)이 TS에서 가장 깨끗하므로 관찰 목록 |

참고: 이름이 암시하는 것과 다른 프로젝트가 여럿 있다(Zep 저장소는 Cloud 예제뿐, Letta는 letta-code 안내, Kuzu 보관, Cozo는 2024-12 이후 commit 없음). TypeScript/Node에서 시간 KG와 임베디드 저장소를 함께 갖춘 성숙한 프로젝트는 찾지 못했다(검색에서 50 stars 이상은 없었고, 가장 가까운 것은 9 stars의 브라우저 확장 `zrg-team/memorall`, AGPL로 탈락한 `inite-ai/inite-brain-service` 등이다).

관찰 목록(후보 아님): txtai(검색 계층으로만 쓸 만한 빌딩 블록, 엔진 아님).

## 4. 스택 평가

출처 약어: `npm:X`는 `https://registry.npmjs.org/X`, `pypi:X`는 `https://pypi.org/pypi/X/json`, `gh:O/R`은 `https://api.github.com/repos/O/R`(과 `/releases/latest`), `hf:ID`는 `https://huggingface.co/api/models/ID`, `ebdoc`은 [electron-builder 문서](https://github.com/electron-userland/electron-builder/tree/master/website/docs/features)(`code-signing/code-signing-win.md`, `auto-update.md`), `MS-AS`는 [Artifact Signing 빠른 시작](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)과 [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq), `MS-SS`는 [배포 기능 상태](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status), `KURE-card`는 [KoE5 README](https://huggingface.co/nlpai-lab/KoE5/raw/main/README.md)다. "추정"은 출처가 말한 것이 아니라 수집자의 결론이다. "Win x64 바이너리"는 등록소에 win-x64 산출물이 존재함을 확인한 것이며 실행하지 않았다.

### 4.1 쉘·패키징

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 바이너리 | 유지보수 | 재배포 조건 | 위험 |
|---|---|---|---|---|---|---|
| Electron | 45.4.1, 2026-11-18. Node 24.22.3, Chromium 156 포함([releases.json](https://releases.electronjs.org/releases.json)) | MIT | 있음: `electron-v45.4.1-win32-x64.zip` 158,296,013 B | 2026-11-20 push, 열린 이슈 793, 8주 주기 메이저, 최신 stable 3개 지원([일정](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)) | MIT. Chromium 고지문 동봉(추정, 표준 관행) | 낮음 |
| electron-builder | 26.18.0, 2026-10-20 | MIT | 해당 없음(빌드 도구) | 열린 이슈 50. 최근 30일 사람 commit 62건이 1인 + 봇(사실상 버스 팩터 1). v27 문서에 publisherName·검증 관련 호환성 깨짐 예고 | MIT | 낮음~중간 |
| electron-updater | npm 6.8.11(2026-10-20), GitHub 태그 6.8.12(2026-10-26) | MIT | 해당 없음(런타임 라이브러리). Windows 자동 업데이트 대상은 **NSIS만**, Squirrel.Windows 미지원(ebdoc auto-update.md) | electron-builder와 같은 저장소 | MIT. 제공처는 GitHub Releases, S3, R2, 일반 HTTPS, Keygen. Authenticode 서명자를 `publisherName`과 대조하며 미서명 업데이트는 `verifyUpdateCodeSignature:false` 없이는 실패(ebdoc code-signing-win.md) | 낮음~중간 |
| Electron Forge | 8.0.1, 2026-09-29 | MIT | 해당 없음 | 열린 이슈 266, 최근 90일 commit 28건이 1인 + 봇 | maker는 squirrel, wix(MSI), msix, appx, zip이며 **NSIS maker 없음**(`gh:electron/forge` `packages/maker`). 자동 업데이트는 Squirrel.Windows/update.electronjs.org(maker 구성에서의 추정) | 낮음~중간 |
| Tauri(대안) | CLI 2.12.6, 2026-11-18 | Apache-2.0 OR MIT | 있음(Rust 빌드, WebView2 필요, 오프라인 부트스트래퍼 모드는 [문서](https://v2.tauri.app/distribute/windows-installer/)) | 열린 이슈 1,487 | 허용적 | 중간(5절 "이 조사가 강제하는 결정" 8번) |
| Windows 코드 서명 | — | — | — | — | (a) 평판을 쌓으려면 공개 신뢰 Authenticode가 필요하고 2024년부터 OV와 EV를 SmartScreen이 같게 취급(MS-SS, ebdoc). (b) OV는 CI에서 쓸 수 있는 `.pfx`, EV는 내보낼 수 없는 하드웨어 토큰(ebdoc). (c) Microsoft **Artifact Signing**(구 Trusted Signing): 공개 신뢰는 미국·캐나다·EU·영국·호주·뉴질랜드·일본·**대한민국**·싱가포르·스위스·노르웨이·이스라엘의 조직에 제공, 개인 개발자는 미국·캐나다만(MS-AS). electron-builder의 `win.sign.type:"azure"`는 **Beta**(ebdoc). (d) 평판은 파일 해시+게시자 인증서로 쌓이며 즉시 우회되는 인증서 종류는 없다. 서명 안 한 파일은 빌드마다 평판이 다시 시작(MS-SS) | 중간: 첫 릴리스의 SmartScreen 경고는 인증서 구매만으로 없앨 수 없음 |

### 4.2 UI

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 | 유지보수 | 재배포 조건 | 위험 |
|---|---|---|---|---|---|---|
| Vite | 8.3.8, 2026-11-11 (Node ^20.19 또는 >=22.12) | MIT | 해당 없음(빌드 시 순수 JS) | 활발 | MIT 고지 | 낮음 |
| React | 19.3.1, 2026-10-14 | MIT | 해당 없음 | 활발 | MIT 고지 | 낮음 |
| shadcn/ui | CLI `shadcn` 4.23.0, 2026-10-27 | MIT([LICENSE.md](https://api.github.com/repos/shadcn-ui/ui/contents/LICENSE.md)) | 해당 없음 | 2026-11-20 push, 열린 이슈 1,749 | npm 의존성이 아니라 컴포넌트 코드를 저장소로 복사하는 "Open Code" 방식([문서](https://ui.shadcn.com/docs)). 복사한 파일의 MIT 고지 유지(추정). 하위 primitive는 별개 패키지(radix-ui 1.8.1 MIT, @base-ui/react 1.9.0 MIT) | 낮음 |
| Playwright(+Electron) | @playwright/test 1.65.1, 2026-11-13 | Apache-2.0 | 있음(번들 드라이버) | 활발 | 개발 전용, 배포하지 않음 | 낮음~중간: Electron API가 [실험적](https://playwright.dev/docs/api/class-electron)으로 문서화됨 |

### 4.3 임베디드 저장소

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 바이너리 | 유지보수 | 재배포 조건 | 위험 |
|---|---|---|---|---|---|---|
| better-sqlite3 | 13.2.0, 2026-11-14 (node>=22, N-API) | MIT | 있음: `prebuilds/**` 동봉, CI가 win32-x64·win-arm64 빌드 | 2026-11-14 push, 열린 이슈 74 | MIT. N-API라 Electron 재빌드가 필요 없을 가능성(추정, 미시험). `.node` 파일에 `asarUnpack` 필요(추정) | 낮음 |
| node:sqlite | Node 내장. Electron 45는 Node 24.22.3 내장. Node 24 문서 기준 **Stability 1.2 릴리스 후보** | Node = MIT(SPDX는 GitHub API가 NOASSERTION이라 미확인) | 해당 없음 | Node 24는 2026-10-20 유지보수 진입, 2028-04-30 종료 | sqlite-vec에 필요한 `loadExtension`이 Electron에서 노출·활성인지 **미검증** | 중간 |
| sqlite-vec | 0.1.9, 2026-03-31(안정), 알파 0.1.10-alpha.4 2026-05-18 | MIT OR Apache-2.0 | 있음: optionalDependency `sqlite-vec-windows-x64`, PyPI `win_amd64` wheel 0.3 MB | README "pre-v1, 호환성 깨짐 예상". 개인 유지보수자. 2026-05-21 이후 commit 0. 열린 이슈 253. 이슈 #368(2026-11-17): 서명 없는 `vec0.dll`을 Windows Smart App Control이 차단([링크](https://github.com/asg017/sqlite-vec/issues/368)) | 허용적. KNN은 전수 비교([문서](https://alexgarcia.xyz/sqlite-vec/features/knn.html)). ANN 브랜치는 미출시 | **높음**(유지보수·서명). 단 작은 코퍼스에서는 무방 |
| LanceDB | npm 0.41.0, 2026-10-29 (node>=22), PyPI 0.41.0 | Apache-2.0 | 있음: npm `@lancedb/lancedb-win32-x64-msvc` 압축 해제 355,807,711 B, PyPI `win_amd64` wheel 85.6 MB | 2026-11-21 push, 열린 이슈 674, 벤처 투자 회사 | Apache-2.0 고지. 바이너리가 큼(설치 파일 압축 후 크기는 추정·미측정) | 라이선스·유지보수 낮음 / 크기 중간 |
| Kuzu | 0.11.3, 2025-10-10 | MIT | PyPI `win_amd64` 4.7 MB | `archived:true`, 마지막 push 2025-10-10 | MIT | **높음**(업스트림 수정 없음) |
| LadybugDB | npm `@ladybugdb/core` 0.22.3 / PyPI `ladybug` 0.22.3 (2026-11-06), GitHub v0.22.3 (2026-11-07) | MIT | 있음: PyPI `win_amd64` wheel 5.8 MB, npm `@ladybugdb/core-win32-x64` 15.6 MB | Kuzu 포크(저장소 2025-10-07 생성). 2026-09-08~11-07 사이 8개 release. 최근 90일 commit이 6명 이상에게 분산. 최근 30일 이슈 132 열림/99 종료. npm 유지보수 계정은 1개이며 기여자에 원 Kuzu 핵심 개발자 포함 | MIT, 아직 0.x. 패키지 이름이 3종(`@ladybugdb/core`와 `ladybug`만 현행, 옛 `lbug`는 0.14.3에서 중단, PyPI `real-ladybug` 0.15.3도 존재) | 중간: 살아 있으나 젊고 1.0 이전 |
| FalkorDBLite | PyPI 0.11.0(2026-10-19), npm 0.3.0(2026-05-02) | 래퍼는 BSD-3-Clause(README), GitHub는 NOASSERTION. 상류 서버 [FalkorDB](https://github.com/FalkorDB/FalkorDB)는 **SSPL v1** | **없음**: PyPI wheel은 cp312-314 manylinux/macOS뿐, npm optionalDep은 linux-x64와 darwin-arm64뿐, README의 Windows 안내는 Ubuntu용 Bash(WSL) | 2026-11-19 push, 63 stars | wheel이 SSPL 모듈을 내장하는지는 추정(wheel 메타데이터로 미확인) | **높음**: Windows 없음 + SSPL. 제외 |
| DuckDB(비교) | v2.0.1, 2026-11-20 (npm `@duckdb/node-api` 2.0.1-r.1) | MIT | 있음: PyPI `win_amd64` 16.1 MB, npm 바인딩 63.5 MB | 2026-11-20 push, 재단 지원 | MIT. 확장(vss/fts)은 기본적으로 실행 중 내려받음, 오프라인 번들은 **미검증** | 라이선스 낮음 / 중간: 2.0.x가 나온 지 하루 |

DuckDB와 SQLite는 관계형이며 Cypher가 없다. Kuzu 설명은 Cypher·벡터·FTS를 제공한다고 하나 Ladybug가 같은 기능을 제공하는지는 따로 확인하지 않았다.

### 4.4 문서 파싱

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 | 유지보수 | 재배포 조건 | 위험 |
|---|---|---|---|---|---|---|
| Docling | 2.151.1, 2026-11-19 (Python >=3.10) | MIT | 순수 Python wheel. 의존성 docling-parse 7.27.0 `win_amd64` 12.1 MB(MIT), docling-ibm-models 4.0.4(MIT), rapidocr 3.10.0(Apache-2.0, 27.3 MB). `docling[standard]`는 torch>=2.2.2, torchvision, scipy, accelerate 필요. `models-onnxruntime` extra는 win32에서 onnxruntime-gpu라 CPU 전용 아님 | 2026-11-20 push, 열린 이슈 1,057, 릴리스 주기 매우 빠름 | 모델을 처음 쓸 때 Hugging Face에서 내려받음: `docling-project/docling-models` 358 MB(`cdla-permissive-2.0, apache-2.0`), layout 계열 172·78·307 MB(Apache-2.0). 설치 파일에 미리 넣는 것은 해당 라이선스상 허용(추정) | 중간: 크고 torch 기반, 한국어 품질 미검증 |
| MarkItDown | 0.1.9, 2026-10-21 | MIT | 순수 Python. extra가 pdfminer-six, pdfplumber, mammoth, openpyxl, pandas, python-pptx, magika를 가져옴 | 0.x, 열린 이슈 822, Microsoft 소유 | MIT. `[all]` 설치 금지(azure 클라이언트가 딸려옴), 형식별 extra 선택 | 낮음~중간(0.x API, 기본 PDF 텍스트만) |
| unstructured | 0.27.37, 2026-11-06 | Apache-2.0 | 기본 의존성에 spacy, numba, python-magic(Windows에서 libmagic 필요, 추정), lxml | 열린 이슈 453, 오픈코어 | Apache-2.0 | 중간~높음 |
| pdfjs-dist | 6.5.438, 2026-11-01 | Apache-2.0 | 해당 없음(순수 JS) | 활발(Mozilla) | Apache-2.0 | 낮음 |
| pdf-parse | 2.4.5, 2025-10-20 | Apache-2.0 | 해당 없음(pdfjs 래퍼) | 마지막 release가 약 13개월 전 | Apache-2.0 | 낮음~중간(대안 pdfjs-dist 또는 unpdf 2.2.1 MIT) |
| mammoth (DOCX) | 1.13.0, 2026-09-26 | BSD-2-Clause | 해당 없음(순수 JS) | 개인 유지보수자 | BSD-2 고지 | 낮음~중간(버스 팩터 1) |
| SheetJS CE | npm `xlsx` **0.18.5, 2022-03-24는 낡은 등록소 사본**. 정본은 [cdn.sheetjs.com](https://cdn.sheetjs.com/)(문서는 0.20.3 안내, 최신 CDN 버전 미확인) | Apache-2.0 | 해당 없음(순수 JS) | GitHub 미러 2024-04-18 push | tarball URL 설치는 npm audit·lockfile 출처 확인을 깨뜨림. npm 0.18.5에는 알려진 권고가 있음(0.19.3에서 수정) | 중간: CDN tarball을 해시로 고정하거나 read-excel-file 9.3.20(MIT), exceljs 4.4.0(MIT, 낡음), Python openpyxl |
| PyMuPDF(대안, **제외**) | 2.1, 2026-11-02, win_amd64 63.0 MB | **AGPL-3.0 또는 Artifex 상용** | 있음 | — | 카피레프트. 제품이 AGPL 호환이 아니면 사용 금지 | 높음(라이선스) |
| pypdfium2(대안) | 5.15.2, 2026-11-09 | BSD-3-Clause / Apache-2.0 | 있음 win_amd64 4.2 MB | 활발 | 허용적 | 낮음 |

HTML/CSV/JSON/TXT/MD는 전용 구성요소 없이 표준 라이브러리와 파서로 처리할 수 있다는 것이 수집자의 추정이며 이 조사에서 따로 확인하지 않았다.

### 4.5 로컬 임베딩

런타임:

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 | 유지보수 | 패키징 메모 | 위험 |
|---|---|---|---|---|---|---|
| @huggingface/transformers (Transformers.js) | 4.3.2, 2026-10-27 | Apache-2.0 | `onnxruntime-node` **1.30.0**에 고정(1.31.1 존재). 1.31.1 tarball은 전 플랫폼 합쳐 307,626,018 B | 2026-11-18 push, 열린 이슈 305. Electron 관련 열린 이슈 #895, #1240, #487 | 모델은 실행 중 HF에서 받음(미리 넣으려면 `env.localModelPath`, 추정) | 중간: Electron 패키징 이슈, 네이티브 `sharp` 의존 |
| onnxruntime(Python) | 1.32.0, 2026-11-13 | MIT | cp311~cp314 win_amd64 16.7 MB | 활발(Microsoft) | MIT | 낮음 |
| fastembed(Python, qdrant) | 0.9.1, 2026-10-24 | Apache-2.0 | onnxruntime 기반, torch 없음, Python >=3.11 | 열린 이슈 124 | 내장 다국어: `intfloat/multilingual-e5-large`(2.24 GB), `paraphrase-multilingual-MiniLM-L12-v2`, `paraphrase-multilingual-mpnet-base-v2`. e5-small/base와 bge-m3는 `add_custom_model`로만 | 낮음 |
| fastembed(npm) | 3.0.0, 2026-09-24 | MIT | onnxruntime-node 1.21.0(오래된 고정) | 1 star, 원 저장소 보관, qdrant-labs로 이전. 다국어는 e5-large뿐 | MIT | 중간~높음 |
| sentence-transformers | 6.3.0, 2026-11-11 | Apache-2.0 | torch 기반(Windows torch 2.15.0 wheel 126.7 MB) | 활발(HF) | 패키징 비용이 가장 큼 | 중간(크기) |

모델(한국어 수치는 KURE 팀이 쓴 KURE-card의 한국어 검색 데이터셋 8종 평균 NDCG이며, 이 팀이 KURE/KoE5를 직접 공개·배포하므로 참고용이고 독립 재현은 없다. 카드의 Top-k 3 표 제목이 `_top1`로 잘못 적혀 있다):

| 모델 | 라이선스 | 파라미터 | 차원 | 최대 토큰 | ONNX | 번들 가능 | 한국어 nDCG (top1/top3) |
|---|---|---|---|---|---|---|---|
| BAAI/bge-m3 | MIT | HF API에 없음(XLM-R-large 급 약 568 M, 추정) | 1024 | 8194 | 저장소 내 fp32 2,267 MB, 커뮤니티 `onnx-community/bge-m3-ONNX`(MIT) int8 568 MB, q4 1,248 MB | 예 | 0.598 / 0.646 |
| nlpai-lab/KURE-v1 (bge-m3 한국어 미세조정) | MIT | 567,754,752 | 1024 | 8194 | ONNX 없음(제3자 GGUF만). 같은 구조라 직접 변환 가능(추정) | 예(MIT). 학습 데이터 라이선스 미확인 | 0.6055 / 0.6554 |
| dragonkue/BGE-m3-ko | Apache-2.0 | 미기록 | 1024 | 8194 | 찾지 못함 | 예 | 0.604 / 0.650 |
| intfloat/multilingual-e5-small | MIT | 117,654,272 | 384 | 512 | 저장소 내 fp32 470 MB, int8 118 MB 등 | 예 | KURE-card에 없음(미검증) |
| intfloat/multilingual-e5-base | MIT | 278,044,162 | 768 | 514 | fp32 1,110 MB, int8 279 MB | 예 | 0.545 / 0.592 |
| intfloat/multilingual-e5-large | MIT | 559,890,946 | 1024 | 514 | fp32 2,235 MB, int8 562 MB | 예 | 0.577 / 0.628 |
| nlpai-lab/KoE5 | MIT | 559,890,432 | 1024 | 514 | 찾지 못함 | 예 | 0.578 / 0.624 |
| Alibaba-NLP/gte-multilingual-base | Apache-2.0 | 305,369,089 | 768 | 8192 | 커뮤니티 `onnx-community` fp32 1,256 MB, int8 340 MB | 예. `trust_remote_code` 필요(추정, 미확인) | 0.537 / 0.597 |
| Snowflake/snowflake-arctic-embed-l-v2.0 | Apache-2.0 | 567,754,752 | 1024 | 8194 | 저장소 내 fp16 1,134 MB, int8 570 MB, q4 1,248 MB | 예 | 0.594 / 0.640 |
| Snowflake/snowflake-arctic-embed-m-v2.0 | Apache-2.0 | 305,368,320 | 768 | 8192 | 저장소 내 int8 311 MB, fp16 613 MB | 예 | KURE-card에 없음(미검증) |
| jinaai/jina-embeddings-v3 | **CC-BY-NC-4.0** | 572,310,396 | 1024 | 8194 | fp16 1,147 MB | **아니오**(비상업) | 0.561 / 0.610 |
| jinaai/jina-embeddings-v4 | **Qwen Research License** | 3,754,885,248 | 2048 | 128000 | 없음 | **아니오**(연구 라이선스, 3.75 B는 CPU에도 무거움) | 해당 없음 |
| jinaai/jina-embeddings-v5-text-small / -nano / omni-* | **CC-BY-NC-4.0** | 596 M / 212 M / 약 986 M | 1024 / 768 / 해당 없음 | 32768 / 8192 | 없음 | **아니오** | 해당 없음 |
| google/embeddinggemma-300m | **Gemma Terms of Use**(HF `gated: manual`) | 302,863,104 | 미확인(gated, 401) | 미확인 | 커뮤니티 `onnx-community/embeddinggemma-300m-ONNX`: fp16 617 MB, q4 197 MB | **조건부**: 사용 제한을 EULA에 전달, Gemma Terms를 수신자에게 제공, 수정 파일 표시, 지정 문구가 든 Notice 파일 동봉([조항 3.1](https://ai.google.dev/gemma/terms)). Google이 원격으로 사용을 제한할 수 있음(3.2) | KURE-card에 없음(미검증) |
| Qwen/Qwen3-Embedding-0.6B | Apache-2.0 | 595,776,512 | 1024 | 32768 | 커뮤니티 `onnx-community` int8 614 MB, q4 914 MB. fastembed에 `Qwen/Qwen3-Embedding-0.6B(-Q)`(1.12 GB 양자화) 내장 | 예 | KURE-card에 없음(미검증) |

모델 파일 크기·라이선스 출처는 `hf:<모델 ID>`와 각 모델의 `config.json`이다. 커뮤니티 ONNX 저장소는 라이선스 필드가 비어 있어 원 모델의 라이선스를 이어받는다고 추정했다.

### 4.6 Python 사이드카 번들링

| 구성요소 | 버전·날짜 | 라이선스 | Win x64 | 유지보수 | 재배포 조건·크기 | 위험 |
|---|---|---|---|---|---|---|
| PyInstaller | 6.22.3, 2026-09-12 | GPL-2.0-or-later WITH Bootloader-exception(PyPI 설명이 상용 포함 비자유 프로그램 배포를 허용한다고 명시) | 있음: `win_amd64` wheel 1.5 MB(부트로더 포함) | 2026-11-17 push, 열린 이슈 119 | 산출물은 GPL에 묶이지 않음. 묶인 제3자 라이브러리는 각자 라이선스 유지. Python 3.8~3.15 | 낮음 |
| Nuitka | 4.3.5, 2026-11-08 | 컴파일러 **AGPL-3.0** + 런타임 예외(`LICENSE-RUNTIME.txt`) | 있음(빌드 머신에 MSVC 또는 MinGW 필요, 추정) | 2026-11-21 push | 컴파일된 산출물이 면제되는지는 런타임 예외에 달려 있으며 법적으로 확인하지 않음 | 중간(라이선스 검토 필요) |
| python-build-standalone | release 20261110 (`astral-sh`) | MPL-2.0(저장소), CPython은 PSF-2.0(추정) | 있음: `cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz` 47,438,699 B, `install_only_stripped` 22,365,213 B | 2026-11-20 push, Astral 관리 | 옮길 수 있는 인터프리터 + site-packages로 배포(동결 단계 없음). 빌드 시 uv 0.13.9(Apache-2.0) 사용 가능 | 낮음~중간 |

크기 기준점(Windows x64 wheel): onnxruntime 1.32.0 = 16.7 MB, torch 2.15.0 = 126.7 MB(CPU 빌드로 추정), duckdb 16.1 MB, lancedb 85.6 MB, pymupdf 63.0 MB, docling-parse 12.1 MB, Electron zip 158.3 MB. 최종 설치 파일 크기와 압축 비율은 **빌드하지 않아 미측정**이다. torch 기반 사이드카와 onnxruntime 전용의 차이 약 110 MB는 wheel 크기 뺄셈일 뿐 측정값이 아니다.

### 4.7 이 조사가 강제하는 결정

1. **번들 제외**: jina-embeddings v3/v4/v5(CC-BY-NC / Qwen Research), PyMuPDF(AGPL), FalkorDBLite(Windows 바이너리 없음, 상류 SSPL). EmbeddingGemma는 아래 2번처럼 조건부다.
2. EmbeddingGemma는 Gemma 이용 조건을 제품 EULA에 전달하고 Notice 파일을 둘 때만 번들 가능하다. 기본값이 아니라 **사용자가 선택해 내려받는 옵션**으로 다룬다.
3. **Kuzu는 주 저장소가 될 수 없다**(보관됨). 대체는 LadybugDB뿐이고 0.x이므로 그래프 계층은 어댑터 뒤에 두고 권위 있는 상태를 내보낼 수 있어야 한다(Wiki·검색은 다시 만들 수 있는 투영이라는 PKI 규칙과 맞음).
4. **네이티브 모듈은 서명·패키징 계획이 따로 필요하다.** sqlite-vec 이슈 #368은 서명 없는 `vec0.dll` 차단 사례다. better-sqlite3 `.node`, onnxruntime, LanceDB, Ladybug 바이너리, Python 사이드카 실행 파일도 같은 위험이 있다. electron-builder가 번들된 모든 DLL·`.node`를 서명하는지는 확인이 필요하다(미검증).
5. **SmartScreen은 첫 릴리스에서 완전히 피할 수 없다.** OV와 EV는 같고 평판은 해시·게시자로 쌓인다. 안정된 서명 정체성 하나를 쓴다. Artifact Signing은 한국 **조직**에는 제공되나 한국 **개인**에는 제공되지 않는다(개인은 미국·캐나다만). 한국의 개인 개발자는 전통 OV 인증서가 필요하다.
6. **자동 업데이트가 패키저를 정한다**: electron-updater는 Windows에서 NSIS에서만 동작하는 경로를 지원하므로 electron-builder + NSIS가 지원되는 길이고 Forge에는 NSIS maker가 없다. 업데이트 검증은 게시자 DN이 서명 인증서와 일치해야 한다.
7. **임베딩 런타임이 사이드카 필요 여부를 가른다**: Node만 쓰는 임베딩(Transformers.js → onnxruntime-node 1.30.0 고정)은 벡터에 Python 사이드카가 필요 없지만 Docling(torch)은 Python 사이드카를 강제한다. Python은 핵심 의존성이 아니라 선택적 "문서 처리" 사이드카로 둔다.
8. **Tauri로 바꿔도 사이드카 문제는 사라지지 않는다**: 외부 바이너리를 지원하지만 Node 백엔드는 여전히 별도 바이너리로 넣어야 하고 UI는 번들 Chromium 대신 WebView2에서 돈다(문서 구조에서의 추정). 절약은 Electron 런타임 약 158 MB뿐이고 Rust와 WebView2 처리가 추가된다.
9. **SheetJS는 npm이 아니라 CDN tarball**에서 받아야 한다. 그러지 않으면 2022년 코드가 배포된다.
10. **한국어 품질은 bge-m3와 그 미세조정(KURE-v1)에 몰려 있다.** 공개된 유일한 한국어 표에서 e5-base 0.545 대 bge-m3 0.598이다. 저렴한 CPU 경로(e5-small int8 118 MB)는 검증된 한국어 수치가 없다.
11. **처음 실행 시 모델 내려받기(Docling, Transformers.js 기본값)는 "오프라인 설치 파일 하나"를 깨뜨린다**: 가중치를 설치 파일이나 설치 후 팩에 미리 넣어야 한다.

### 4.8 그룹별 기본값과 차선 (잠정)

| 그룹 | 기본값 | 차선 | 이유 |
|---|---|---|---|
| 쉘·패키징 | Electron 45 + electron-builder(NSIS) + electron-updater | Electron Forge 8(Squirrel/WiX/MSIX) | 지원되는 자동 업데이트 경로가 NSIS뿐. builder는 Azure/OV/HSM 서명을 지원. 비용은 버스 팩터 1 |
| 서명 | OV(조직으로 등록 가능하면 Artifact Signing), 안정된 정체성 1개 | EV(2026년 SmartScreen 이점 없음) | 둘 다 SmartScreen에서 동등. Artifact Signing은 하드웨어 토큰이 필요 없으나 electron-builder에서 Beta이고 한국에서는 조직 전용 |
| UI | Vite 8 + React 19 + shadcn/ui(복사된 MIT 코드) | Radix/Base UI primitive 직접 사용 | 전부 MIT, 런타임 라이선스 의존 없음 |
| E2E | Playwright `_electron`(실험적) | WebdriverIO/Spectron 계열(미조사) | 실험적임을 명시 |
| 임베디드 저장소 | better-sqlite3 13 + sqlite-vec 또는 작은 코퍼스용 앱 수준 전수 코사인 비교. **벡터는 다시 만들 수 있게 유지** | LanceDB 0.41(Apache-2.0, win-x64 바이너리, 더 큼) | SQLite는 안정적이고 미리 빌드됨. 벡터 계층 위험(sqlite-vec은 사실상 방치 우려)은 격리 |
| 그래프(필요할 때) | LadybugDB(`@ladybugdb/core` / `ladybug`)를 어댑터 뒤에 | DuckDB 2.0(관계형, MIT, Cypher 없음) | win-x64 바이너리가 있는 유일한 Kuzu 계보. 젊으므로 격리 |
| node:sqlite | 아직 채택하지 않음 | better-sqlite3 | 릴리스 후보 단계, 확장 로딩 미검증 |
| 문서 파싱 | 형식별 가벼운 파서: pdfjs-dist(PDF), mammoth(DOCX), SheetJS CDN 또는 read-excel-file(XLSX), 나머지는 내장. 레이아웃이 복잡한 PDF에는 선택적 Docling 사이드카 | 형식별 extra를 고른 MarkItDown(Python) | 기본값에서 torch를 피함. Docling은 품질 옵션이지만 모델 358 MB + torch |
| 임베딩 | BAAI/bge-m3(MIT) int8 ONNX 568 MB(Node의 ORT 또는 fastembed 사용자 정의 모델) | multilingual-e5-base int8(279 MB) 또는 snowflake-arctic-embed-l-v2.0 int8(570 MB, Apache-2.0, 한국어 0.594) | 번들 가능한 모델 중 검증된 한국어 점수가 가장 높고 MIT이며 ONNX가 저장소에 있고 8K 토큰. KURE-v1은 직접 변환하면 더 나은 한국어 상위 호환 |
| 임베딩 런타임 | Node의 Transformers.js 4(onnxruntime-node), Python 없음 | fastembed Python + onnxruntime | 기본 제품에서 Python을 없앰. fastembed가 더 잘 지원되는 대안 |
| Python 번들링 | python-build-standalone(`install_only_stripped`) + 빌드 시 uv(사이드카가 필요할 때만) | PyInstaller 6.22(GPL+예외) | 옮길 수 있는 인터프리터가 네이티브 wheel과의 동결 취약성을 피함. PyInstaller는 라이선스상 안전 |

이 기본값은 Windows에서 실행해 보기 전의 잠정값이다. 모든 수치(크기, 버전)는 레지스트리·API 읽기 결과이며 설치·빌드·실행을 하지 않았다.

## 5. 판정

판정은 1절의 탈락 조건을 먼저 적용한 결과다. **이번 단계에서 "채택"으로 확정한 엔진은 없다.** 소스 읽기만으로는 ①Windows 실행을 확정할 수 없기 때문이다. "보류"는 탈락하지 않았고 R03 실행 후보로 넘긴다는 뜻이다.

### 5.1 엔진·저장 후보

| 후보 | 판정 | R03 위치 |
|---|---|---|
| LightRAG | **보류** | 실행 후보 1 |
| cognee | **보류** | 실행 후보 2 |
| sage-wiki (Go, MIT) | **보류** | 실행 후보 3(새로 추가) |
| graphiti | **기각**(엔진으로) | 설계 참고만 |
| memind | **기각** | — |
| ddsyasas/llm-wiki | **기각**(기반으로) | Wiki 계층 대안 있음 |
| Astro-Han/karpathy-llm-wiki | **참고 패턴만** | 구성요소 아님 |
| cortexdb (Go, MIT) | **보류** | 시간 그래프 저장 계층 후보, R03-C4에서 제품 소유 SQLite 스키마와 비교 |
| tigerless-labs/agent-memory | **참고 구현** | R02 입력, 엔진으로 채택 안 함 |
| Hyper-Extract | **참고** | 원본 단위 정확 제거 설계 |
| llm-wiki-compiler (TS, MIT) | **보류** | K01에서 재평가 |

**LightRAG: 보류 — R03 실행 후보 1.**
- 강점: 호출 가능한 LLM·embedding·tokenizer 주입(E3.2, E3.3), MIT(E3.1), Windows 전용 코드 경로(E3.8), 추출 캐시로 영향받은 항목을 재구성하는 삭제(E3.5).
- 공백: 시간 유효성 없음(E3.9), 갱신은 삭제 후 재수집(E3.6), 파일 기반 저장소는 문서가 "소규모 테스트용"이라고 적음(E3.4), 근거는 chunk 단위(일부 chunker의 span 보조 파일은 조건부, E3.9). 기본 tokenizer가 처음 쓸 때 네트워크에서 파일을 받으므로 오프라인 번들이 필요하다.
- 탈락 조건 4개 중 소스상 걸리는 것은 없다. 단 ①은 부분(코드 경로만), 전부 실행 전이다.

**cognee: 보류 — R03 실행 후보 2.**
- 강점: chunk 단위 diff `update()`(E1.7), `forget()`(E1.8), edge → chunk 근거(E1.9), 임베디드 SQLite/LanceDB/Ladybug(E1.2).
- 공백: provider 목록이 닫혀 있어 CLI 어댑터는 로컬 OpenAI 호환 shim이 필요하다(E1.4, 미검증), 기본 로컬 embedder가 영어 전용(E1.5), **패키지된 Windows 호스트에서 로컬 서버가 죽는 열린 이슈 #6808**, 변경 속도가 매우 빠름(90일 2,894 commit)이라 API가 바뀔 위험이 크다. 사실(edge)에 시간 유효성이 없다.

**sage-wiki (Go, MIT): 보류 — R03 실행 후보 3(새로 추가).**
- 이유: 엔진과 Wiki 계층을 함께 대체하면서 근거 span(`evidence`)과 양시간 edge 유효성이 소스에 있는 유일한 후보다. 단일 Go 바이너리라 Python 사이드카를 피할 수 있다(`CGO_ENABLED=0` 빌드와 Windows release 산출물 존재는 확인, 동작은 미검증).
- 미검증 항목과 성숙도 위험(모두 R03 체크리스트에 있음): 트리플·해소·온톨로지 단계가 주입한 LLM provider를 쓰는지(compile 클라이언트 생성만 추적됨), 질의 시 expand/rerank가 설정 기반으로 남음(CLI-only 환경에서 별도 shim 필요 가능), 원본 삭제 시 온톨로지 edge·개체 연쇄 삭제, 프로세스 내 CPU embedder 번들 여부, 한국어 품질, Windows 실행. 659 stars, 기여자 14명, 1.0 이전이며 "버전 고정"을 권고한다.

**graphiti: 기각(엔진으로).**
- 이유: 쓸 수 있는 임베디드 저장소가 Windows에 없다. falkordblite에 Windows wheel이 없고 SSPL FalkorDB를 내장하며(E2.3), 기본값은 Neo4j 서버(GPL-3.0)이고, Kuzu 드라이버는 2026-11-15에 제거되었다(E2.2). 탈락 조건 ①②④에 걸린다.
- 보존: 양시간 edge 모델(`valid_at`, `invalid_at`, `expired_at`, E2.5)은 **설계 참고**로 남긴다.
- 대안: 위 보류 후보 3개.

**memind: 기각.**
- 이유: JVM 런타임(E4.1), 원문 문서 삭제 없음(E4.4), 증분 갱신 없음(E4.5), 90일간 commit 없음(E4.6). 탈락 조건 ③에 걸린다.
- 대안: 보류 후보 3개.

**ddsyasas/llm-wiki: 기각(기반으로).**
- 이유: 임베딩이 없고(E5.2), 삭제 라우트가 파생 페이지를 남기며(E5.5), 90일간 commit이 없다(E5.6). 탈락 조건 ③에 걸린다.
- Wiki 계층 대안: llm-wiki-compiler(TypeScript, MIT)는 **보류**하고 K01에서 재평가한다(`rm`이 원본과 파생 페이지를 함께 지운다고 문서에 적혀 있으나 실행하지 않음, 시간 모델 없음, Node >=24 요구). 엔진 후보 중 sage-wiki가 R03를 통과하면 Wiki 계층도 함께 얻는다.

**Astro-Han/karpathy-llm-wiki: 참고 패턴만.** 구성요소가 아니다. 증거 확인 스크립트(`Raw` 필드와 근거 문자열 대조) 아이디어만 참고한다(E6.1, E6.3). 삭제와 증분 갱신은 의도적으로 범위 밖이다.

**cortexdb (Go, MIT): 보류.** 시간 그래프 저장 계층 후보로서, 제품이 소유하는 평범한 SQLite 스키마와 R03-C4에서 비교한다. 장점은 양시간 사실, 사실별 근거, 문서 단위 삭제, LLM 없는 코어, 순수 Go SQLite, 키 경로 없음이다. 성숙도 위험이 크다(15개월에 v2.157, 기여자 4명, CHANGELOG 255 KB). 삭제 시 시간 이력이 지워지는지, 인용이 span인지 chunk인지 미검증이다.

**tigerless-labs/agent-memory: 참고 구현.** `claude -p` / `codex exec` 어댑터와 격리 플래그(`--strict-mcp-config --tools ""`, `--ephemeral --ignore-user-config --ignore-rules --sandbox`)가 R02 입력이 된다. 삭제는 소프트 삭제뿐이라("삭제해도 파일이 남는다") 엔진으로는 채택하지 않는다.

**Hyper-Extract: 참고.** `remove_source(..., "exact")`의 원본 단위 정확 제거 설계(단독 기여 키 삭제, 공유 키 재병합)를 참고한다. 근거 span이 없고 시간은 프롬프트 수준이다.

### 5.2 스택 기본값과 차선

4.8절 표를 그대로 따른다. 요약은 다음과 같고 모두 잠정이다.

- 쉘·패키징: Electron + electron-builder NSIS + electron-updater. 차선은 Electron Forge.
- UI: Vite / React / shadcn/ui, E2E는 Playwright.
- 저장소: better-sqlite3 + sqlite-vec(벡터는 다시 만들 수 있게 유지), 차선은 LanceDB. 그래프 저장소가 필요하면 LadybugDB를 어댑터 뒤에서만 쓴다.
- 문서 파싱: 가벼운 JS 파서 + 선택적 Docling 사이드카.
- 임베딩: bge-m3 기본, multilingual-e5-base가 차선(Transformers.js로).
- Python 사이드카가 필요하면 python-build-standalone.

**번들할 수 없는 항목**: jina-embeddings v3/v4/v5, PyMuPDF, FalkorDBLite. EmbeddingGemma는 조건부(Gemma 조건 전달과 Notice 파일).

## 6. 설계에 주는 영향 (잠정 — R06에서 확정)

아래는 R06 전까지 바뀔 수 있는 잠정 판단이다. 확정된 결정이 아니다.

1. **가설: 제품이 권위 있는 Knowledge/Evidence 기록을 SQLite에 두고, 엔진은 다시 만들 수 있는 추출·검색 투영으로 쓴다.** 조사한 어떤 엔진도 시간 유효성, 원문 span 수준의 근거, 사용자 교정 보존, 삭제 계보(lineage)를 한꺼번에 제공하지 않는다. 그래서 R03은 "제품이 권위를 가진다"는 가설과 "엔진이 권위를 가진다"를 비교해 시험해야 한다. **이것은 시험할 가설이지 결정이 아니다.** 이것이 금지된 "엔진 직접 재구현"이 아닌 이유는 기록(레코드)을 저장할 뿐 그래프·벡터 알고리즘을 구현하지 않기 때문이다. 쉬운 비유로, 엔진이 도서관 검색대라면 제품은 원본 장부를 직접 갖고 검색대는 장부에서 언제든 다시 지을 수 있는 색인으로 두는 것이다. 비유가 맞지 않는 점은, 검색대가 장부와 어긋났을 때 무엇이 옳은지를 판정하는 규칙(재구축 절차)을 제품이 따로 정의해야 한다는 것이다.
2. **사이드카 언어가 열린 질문이 되었다.** Python(LightRAG, cognee), Go 단일 바이너리(sage-wiki, cortexdb), 사이드카 없음 중에서 R03 결과로 정한다. Go 후보는 Python 번들링·torch 문제를 피하지만 성숙도 위험이 있다.
3. **설치 파일 안의 네이티브 바이너리는 서명이 필요하고, 첫 릴리스에서 SmartScreen 경고는 완전히 피할 수 없다.** 자동 업데이트를 하려면 NSIS(electron-builder)를 써야 한다(4.7의 4~6번).
4. **Kuzu는 보관됨이므로 LadybugDB는 어댑터 뒤에서만 쓴다.** 0.x이고 패키지 이름이 여러 개이며 Windows 실행은 미검증이다.

## 7. R03에서 실행으로 확인할 항목

판정에 영향을 주는 모든 미검증 항목이다. 모두 지금은 "소스에 있음" 또는 "추정"이며 실행한 적이 없다.

**공통**
- [ ] 깨끗한 Windows 11에서 각 후보의 설치·import·실행(전 판정의 ①). 설치 파일 포장 후에도 같은지.
- [ ] 후보별 문서당 LLM 호출 수와 지연 측정(chunk 수·보충 추출·병합 요약 빈도, graphiti의 조건부 단계).
- [ ] 한국어 임베딩 품질과 모델 가용성, 모델 라이선스·내려받기 동작(fastembed, tiktoken, GLiNER 포함). 한국어 문서에서 추출·검색 품질.
- [ ] 코퍼스 규모 한계: LightRAG 파일 기반 저장소("소규모 테스트용")와 cognee의 Ladybug/LanceDB를 CPU 데스크톱 메모리에서 측정.
- [ ] 원격 측정 기본값: cognee(`TELEMETRY_DISABLED` 미설정 시), LightRAG, memind, llm-wiki는 미확인. graphiti는 기본 켜짐이므로 끄는 방법.
- [ ] 사용자 정의 LLM으로 `claude -p` / `codex exec` 래퍼를 끼운 end-to-end 실행(R02 결과 선행).

**LightRAG**
- [ ] 삭제 후 재수집 때 바뀌지 않은 chunk의 추출 캐시가 재사용되는지(재업로드 경로는 추적되지 않음).
- [ ] 반쯤 끝난 삭제 복구(`kg_integrity_repair`)와 크래시 안전성.
- [ ] 오프라인 tokenizer 번들(tiktoken 캐시 사전 배치)로 네트워크 없이 도는지.
- [ ] `pipmaster`의 실행 중 pip 설치 동작(차단 가능한지).
- [ ] span 수준 근거를 쓸 수 있는 chunker 설정 범위.

**cognee**
- [ ] `update()`의 chunk diff가 바뀌지 않은 chunk의 LLM 재추출을 피하는지.
- [ ] `forget()`이 두 문서가 공유하는 사실을 한 문서 삭제 후에도 남기는지.
- [ ] 로컬 OpenAI 호환 shim(`custom` provider, 더미 키)이 구조화 출력(litellm/instructor) 모드를 만족하는지.
- [ ] 한국어 다국어 embedder 설정(fastembed 목록 또는 OpenAI 호환 로컬 서버).
- [ ] 묶인 사이드카에서 OpenSSL DLL 보정과 이슈 #6808(패키지된 Windows 호스트)이 재현되는지. 저장소 3종 사이의 일관성(크래시 후 복구).
- [ ] 옛 Kuzu 어댑터가 아직 쓸 만한지, 사이드카 설치 크기·import 시간.

**sage-wiki**
- [ ] 트리플·해소·온톨로지 단계가 주입한 completion provider를 쓰는지, 질의 시 expand/rerank를 CLI 전용 환경에서 어떻게 처리하는지.
- [ ] 원본 삭제 시 고아 온톨로지 edge·개체 연쇄 삭제.
- [ ] 프로세스 내 CPU embedder 번들 여부와 한국어 임베딩 경로.
- [ ] Windows release 산출물의 실행, 1.0 이전 API 변동.

**cortexdb(R03-C4)**
- [ ] 삭제가 시간 이력 행을 지우는지 표시만 하는지.
- [ ] `FactProvenanceFor`의 인용이 문자 span인지 chunk 전체인지, `graphflow.Pipeline`의 내용 해시 증분 재수집.
- [ ] 제품 소유 SQLite 스키마 대비 성능·유지 비용, API 안정성(v2.157/15개월).

**agent-memory (R02 입력)**
- [ ] 격리 플래그가 현재 CLI 버전에서 실제로 격리하는지(R02 부정 테스트). 완전 삭제 경로 존재 여부, Windows 지원.

**llm-wiki-compiler (K01)**
- [ ] `runWithProviderOverride`가 공개 SDK에서 닿는지, Node >=24와 Electron 번들 Node의 호환, `rm` 연쇄 삭제.

**스택**
- [ ] 설치 파일·설치 후 크기와 압축 비율(빌드 후 측정). torch 대 onnxruntime 차이.
- [ ] better-sqlite3 미리 빌드된 바이너리가 Electron 45에서 재빌드 없이 로드되는지, `asarUnpack` 필요 여부.
- [ ] `node:sqlite`의 `loadExtension`이 Electron 45에서 쓸 수 있는지.
- [ ] electron-builder가 번들된 `.dll`/`.node`를 기본으로 서명하는지, Smart App Control이 다른 서명 없는 바이너리를 막는지(관찰은 sqlite-vec #368뿐, 재현 안 함).
- [ ] electron-builder v27의 호환성 깨짐과 출시 시기. Electron 46이 이미 stable인지.
- [ ] LadybugDB: Kuzu 파일과의 저장 형식 호환, Windows 실행, 확장 오프라인 배포와 확장 라이선스.
- [ ] DuckDB 확장(vss/fts) 오프라인 번들(비교용).
- [ ] Docling 한국어 OCR·레이아웃 품질, 오프라인 모드의 HF 모델 내려받기, `docling[standard]`가 MSVC 런타임을 요구하는지.
- [ ] 최신 SheetJS CDN 버전, PyInstaller 사이드카의 백신 오탐.
- [ ] 한국어 벤치마크가 없는 모델(e5-small, arctic-m-v2, Qwen3-Embedding, EmbeddingGemma)의 한국어 점수와 KURE 팀 밖의 독립 벤치마크. KURE-v1 직접 ONNX 변환.
- [ ] Windows Smart App Control이 EV/OV에 어떻게 반응하는지, Artifact Signing의 사용자 개체 유형별 가용성과 가격.

## 8. 미검증 범위

- **아무것도 설치하거나 실행하지 않았다.** 모든 능력 표기는 문서·소스 읽기이며 Windows 11 동작은 후보와 스택 모두 미검증이다. cortexdb와 sage-wiki의 Windows release 산출물은 파일 이름으로 존재만 확인했다.
- 라이선스는 PyPI 최신 release 기준이며 저장소가 고정한 버전과 다를 수 있다. 전이 의존성과 모델 학습 데이터 라이선스는 확인하지 않았다.
- 90일 commit 수는 기본 브랜치 원시 개수이며 병합·봇을 포함한다. stars·기여자 수는 후보 6개 중 일부만 보고되었고(memind 906, llm-wiki 75, karpathy-llm-wiki 2,780), cognee·graphiti·LightRAG의 stars와 기여자 수는 수집하지 않았다.
- 대안 조사는 GitHub 검색(+ swarmvault에 한해 npm)만 썼다. PyPI, GitLab, Codeberg, GitHub 밖 프로젝트는 검색하지 않았다. 대안 후보 중 Haystack, kotaemon, R2R, memobase, MemMachine, MemOS 서버 내부, doobidoo, Memori, NornicDB, SurfSense DB 계층, inkeep/open-knowledge, PandaWiki, Molio 라이선스 조항 전문은 코드를 열어 보지 않고 README·설명만으로 판단했다.
- Hyper-Extract, Memori, TencentDB-Agent-Memory, WeKnora의 GitHub 라이선스 탐지는 NOASSERTION이며 LICENSE 본문만 첫 줄 수준으로 읽었다. 표준 본문과 비교하지 않았다.
- 대안 후보 일부(Letta, Zep, R2R, memobase 등)의 SHA는 수집 시점 API HEAD의 12자이며, AnythingLLM은 수집 중 저장소가 바뀌어 복제본 SHA(`472b1e3f`)와 이전 API HEAD(`7e30580e`)가 다르다. AnythingLLM Windows 설치 프로그램 소스가 MIT 저장소에 포함되는지도 미검증.
- 새로 생긴 저장소의 stars 증가 진위와 유지보수자 지속 가능성은 평가하지 않았다.
- Tauri 사이드카 주장은 문서 제목에서의 추정이며 서명 문서는 자세히 읽지 않았다. Nuitka 산출물의 라이선스 영향은 법적 검토가 필요하다.
- 제품의 최종 엔진·저장 구조 결정, 사이드카 언어 결정, CLI 구독 로그인 허용 여부는 이 문서의 범위가 아니다(R06, R02).
