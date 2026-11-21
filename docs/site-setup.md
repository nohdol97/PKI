# 배포처 설정 체크리스트 (사외 검증 키트 이관)

이 문서는 사외에서 준비한 검증 키트(`verification/`)를 배포처에서 실행할 때 사람이 해야 하는 일의 목록이다. 제품의 배포처 설정 전반(수집기, 인증, 엔드포인트)은 제품 코드가 생길 때 이 문서에 이어서 적는다. 각 항목 ID는 `docs/specs/2026-11-21-R0*-*.md`의 "배포처 후속 항목"과 같다. 실행 결과는 이슈 #11, #12, #13, #37에 기록한다(`verification/README.md` 참고).

## 배포처 설정 체크리스트

- [ ] R02-S1: 공식 약관·벤더 서면 확인(C4) — `verification/r02-cli-isolation/TERMS_CHECKLIST.md`를 따라 사람이 공식 조건을 읽고 벤더에 확인한다. 미확인은 지원으로 표시하지 않는다.
- [ ] R02-S2: OS 수준 프로세스·파일·네트워크 추적 — Sysmon/ETW/procmon으로 R02 부정 테스트 중의 자식 프로세스·파일 열기·연결을 기록한다(`RUNBOOK.md`의 "추가 추적").
- [ ] R03-S1: LightRAG 어댑터의 상류 API 호출 확정 — `adapters/lightrag_adapter.py`의 근거 없는 호출(삽입·질의·export 등)을 설치한 고정 버전의 문서로 확인해 채운다.
- [ ] R03-S2: cognee 어댑터의 상류 API 호출 확정과 로컬 OpenAI 호환 shim 구조화 출력 확인 — 설정 키 이름, 삽입·검색 호출, 구조화 출력 모드(tools 또는 json schema)를 확인한다.
- [ ] R03-S3: sage-wiki 어댑터의 실행 파일 호출 방식 확정 — 하위 명령, 설정 파일 형식, LLM 엔드포인트 지정 방법을 확인한다.
- [ ] R03-S4: cortexdb 저장 계층 어댑터의 호출 방식 확정 — MCP stdio 실행 파일의 도구 이름과 인자, 삭제 뒤 이력 행의 거동을 확인한다.
- [ ] R03-S5: 임베딩 워커 백엔드(라이브러리 호출) 확정 — fastembed 또는 sentence-transformers 워커를 완성하고 모델 HF 커밋 SHA를 기록한다.
- [ ] R04-S1: V01 skeleton 설치 파일 제작·전달 — 이 키트는 설치 파일을 만들지 않는다. 설치 파일을 받아 `config.json`을 채운다.
- [ ] R04-S2: R04-C2 두 번째 설치 실험 — R03에서 통과한 후보의 Python/native 모듈을 담은 설치 파일을 만들어 같은 스크립트를 `-IncludeCrashTest`로 돌린다.
- [ ] R04-S3: 코드 서명 인증서·업데이트 배포 경로 결정 — `CHECKLIST_MANUAL.md`의 미확정 사항 칸에 결정을 기록한다.

네트워크 설치(pip, 모델 내려받기, GitHub 릴리스 내려받기)는 모두 배포처의 승인이 필요하다. 승인 없이 실행하지 않는다.
