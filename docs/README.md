# 문서 색인

이 디렉터리의 문서를 한곳에 모은 목록이다. 제품 코드는 아직 없고, 여기 있는 것은 설계·조사·결정·구현 기준이다. 처음 읽는다면 위에서 아래 순서를 권한다.

**읽기 전에**: 이 문서들은 아무것도 설치하거나 실행하지 않고 썼다(실제로 돌려 잰 기록인 [research/2026-11-22-I02B-T01-poc.md](research/2026-11-22-I02B-T01-poc.md)는 예외이고, 그것도 macOS 한정이다). "잠정"이라고 적힌 결정은 배포처에서 실행해 확인하기 전의 것이며, 그 확인은 R07(이슈 #37)에서 한다. spec의 "확정"은 구현할 기준이 고정되었다는 뜻이지 그 기준이 충족되었다는 뜻이 아니다. 낯선 말은 [ARCHITECTURE 0절](ARCHITECTURE.md#0-처음-나오는-말)에 풀이가 있다.

## 구조

| 문서 | 무엇인가 | 상태 |
|---|---|---|
| [design/original-design.md](design/original-design.md) | 사용자가 쓴 원 설계. 요구사항의 출처이며 고치지 않고 보관한다 | 원문 |
| [OSS_EVALUATION.md](OSS_EVALUATION.md) | 재사용할 오픈소스 엔진과 스택의 비교, 채택·보류·기각 판정 | 소스 읽기 결과, 실행 전 |
| [research/2026-11-21-cli-provider-terms-and-isolation.md](research/2026-11-21-cli-provider-terms-and-isolation.md) | Claude Code·Codex CLI를 제품이 호출해도 되는지(약관)와 격리할 수 있는지의 문서 조사 | 문서 조사, 실행 전 |
| [research/2026-11-21-R00-initial-base.md](research/2026-11-21-R00-initial-base.md) | 빈 저장소에 최초 commit을 올린 절차와 증거 | 보관 |
| [research/2026-11-22-I02B-T01-poc.md](research/2026-11-22-I02B-T01-poc.md) | I02-B 착수 전 측정(I02B-T01): 격리 실행기·경로 경계·철회 묶음이 기대는 가정을 macOS에서 실제로 돌려 적은 판정 기록(Windows·Linux 제외) | 측정 완료, 검토 반영 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 구성요소, 프로세스, 정본과 투영, 어댑터 규격, 실패 복구, 보안, **가정 표** | 잠정 |
| [adr/](adr/README.md) | 결정 기록 19건(잠정 14, 확정 4, 미결 1. 0017은 I02-B의 ADR로 들어왔다) | 색인 참조 |
| [adr/0017-local-files-in-place.md](adr/0017-local-files-in-place.md) | 로컬 파일은 사본 없이 승인한 자리에서 읽는다: 색인은 정본 안의 원본 정체 기록, 정규화는 백엔드 밖의 호스트 프로세스, 경로 경계는 닫는 쪽(I02-B) | 잠정(Windows 확인은 S23) |
| [REUSE_AND_BUILD.md](REUSE_AND_BUILD.md) | 기능별 재사용·직접 개발·미룸 목록 | 잠정 |
| [ownership.md](ownership.md) | 공용 저장소와 배포처 포크가 각각 무엇을 갖는가 | 확정(ADR 0012) |
| [site-setup.md](site-setup.md) | 배포처가 채울 설정의 형태와 체크리스트 | 잠정(설정 키 이름은 V01-T17이 구현과 맞춤. 이름과 값의 형태는 잠정) |
| [connector-sdk.md](connector-sdk.md) | 수집기(Connector)를 이 저장소 밖에서 만드는 사람을 위한 안내: 규격, 받아들이는 규칙, 오류와 재시도, 계약 테스트, 예시 수집기, 아직 없는 것 | 잠정(규격은 ADR 0016, 포크에 두고 연결하는 방식은 ADR 0018, 실제 원 시스템에서의 확인은 S18, 포크 조립은 S26, 수집기 자격 증명은 ADR 0019와 S28·S29, 인스턴스 범위 파일은 ADR 0020과 S30·S31) |
| [specs/2026-11-21-R01-oss-evaluation.md](specs/2026-11-21-R01-oss-evaluation.md) | OSS 평가 작업(R01)의 요구사항과 완료 기준 | 확정 |
| [specs/2026-11-21-R06-provisional-architecture.md](specs/2026-11-21-R06-provisional-architecture.md) | 잠정 아키텍처 작업(R06)의 완료 기준과, 기준마다 그것을 충족하는 문서 | 초안 |
| [specs/2026-11-21-V01-vertical-skeleton.md](specs/2026-11-21-V01-vertical-skeleton.md) | Phase 1 뼈대(V01)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-V02-vertical-slice.md](specs/2026-11-21-V02-vertical-slice.md) | Phase 1 수직 흐름(V02)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I01-connector-sdk.md](specs/2026-11-21-I01-connector-sdk.md) | Connector SDK 규격 v2, 원본·근거 계약, JSONL·API 가져오기(I01)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I02-document-normalization.md](specs/2026-11-21-I02-document-normalization.md) | 문서 정규화(I02-A, 이슈 #19의 첫 조각)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I03-persistent-queue.md](specs/2026-11-21-I03-persistent-queue.md) | 영속 작업 대기열·스케줄러·재시도와 절전 복구(I03)의 요구사항, 완료 기준, 테스트, 작업 분해 | 확정 |
| [specs/2026-11-21-I04-invalidation.md](specs/2026-11-21-I04-invalidation.md) | 수정·삭제·권한 철회의 파생물 무효화(I04): 파생물 종류 등록 계약, 소거 범위, tombstone 규칙, access_scope 승계, 복원 뒤 재적용 정책 | 확정 |
| [specs/2026-11-22-I02-local-file-import.md](specs/2026-11-22-I02-local-file-import.md) | 로컬 파일·폴더 가져오기(I02-B, #19·#116): `local-files` 수집기, 위치 승인과 경로 제한, 이동·이름 바꾸기, 감시와 맞춰 보기, 정규화 격리, 경로 신뢰 경계의 위협 모델, 철회와 삭제 장부, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-I02-attachment-metadata.md](specs/2026-11-23-I02-attachment-metadata.md) | 메일 첨부 metadata와 첨부 안의 근거 위치(I02 후속, #122): 레코드의 선택 필드 `attachments`(이름·형식·크기)와 block의 `attachment` 순번, 신뢰하지 않는 값의 한도, JSONL 줄, 버전의 출처 정보에 저장(스키마 변경 없음), `evidenceSource`에서 읽기. 실제 메일 수집기는 배포처 S01 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-I05-site-connector-registration.md](specs/2026-11-22-I05-site-connector-registration.md) | 배포처 수집기를 `site/` 안에서 등록하는 장치(I05, #113): 빌드 시점 진입점 주입, 등록 계약(사이트 종류만), 신뢰 경계, 시작 동작, 등급 매핑과 범위 정책의 공급, 포크 모양에서의 공용 시험, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-I06-connector-credentials.md](specs/2026-11-22-I06-connector-credentials.md) | 수집기에 자격 증명을 넘기는 경로(I06, #114): V01의 비밀 값 저장소에 인스턴스별 칸으로 두고 `initialize`의 접근자로 넘김, 없음·저장소 불가·읽을 수 없음·거부의 사유와 보류, 누출 없음의 시험, 계약 묶음의 위반 코드, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-I07-installed-scopes-file.md](specs/2026-11-22-I07-installed-scopes-file.md) | 설치본이 인스턴스 범위(`site/config/connector-scopes.json`)를 얻는 길(I07, #115): 포크의 등록이 빌드할 때 값을 묶고 실행본은 파일을 읽지 않음, 빌드 판정, 산출물 검사, 설치본 확인 절차, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-I05F-sync-kind-mismatch.md](specs/2026-11-23-I05F-sync-kind-mismatch.md) | 저장된 종류와 어긋난 인스턴스의 동기화(I05 후속, #128): 시작할 때 판정해 `unavailable`(사유 `instance-kind-mismatch`)로 두고, 동기화 요청은 409 `connector-unavailable`, 수집 작업은 그 사유로 보류, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-I06F-secret-input-gaps.md](specs/2026-11-23-I06F-secret-input-gaps.md) | 자격 증명·API 키 입력란의 남은 틈(I06 후속, #162): 두 입력란을 컴포넌트 하나로, 저장 직전의 줄바꿈·길이 검사, 끌어 놓기, 거부 때 앞 글자 보존, 초점의 조건, 브라우저가 바꾼 값의 한계, `cli-kill` 시험의 부하 실패, 설정 화면 키 입력란의 호스트 변경 시 초기화·저장·삭제 결과 문구(#174) | 확정(잠정 결정 포함) |
| [specs/2026-11-23-R04-data-dir-lock.md](specs/2026-11-23-R04-data-dir-lock.md) | 단일 실행의 기준을 데이터 폴더의 잠금으로(R04 후속, #13): `node:sqlite` 배타 잠금을 셸이 프로세스 끝까지 쥠, 다른 userData로 같은 폴더를 여는 두 번째 실행은 표준 오류 한 줄과 종료 코드 1, 낡은 잠금 추정 없음 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-I04-ledger-reapply-cost.md](specs/2026-11-23-I04-ledger-reapply-cost.md) | 삭제 장부 재적용의 줄마다 원본 훑기 비용(I04 후속, #123): 실행 색인을 인스턴스마다 첫 미스에 한 번 만들어 `ensureSourceByHash`에 넘김, 스키마 변경 없음, 읽은 행 수로 검증, 합성 규모 측정 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-S01-semantic-registry.md](specs/2026-11-22-S01-semantic-registry.md) | Semantic 등록부(S01): 상태 전이와 변경 이력·취소, 자동 승격 조건, 인식 유형과 confidence의 분리, 사용자 교정 보존, 표기와 문맥별 정의, 유형 정의 변경의 검사 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-S02-entity-resolution-temporal-graph.md](specs/2026-11-22-S02-entity-resolution-temporal-graph.md) | 개체 해소·시간 그래프·충돌 처리(S02, #23): 지식 유형 16과 관계 유형 11의 판 번호 있는 목록, 식별자·조직·프로젝트·이웃·시간 신호로 만드는 합치기 후보와 동명이인 확인, 행을 옮기지 않는 합치기와 풀기·나누기, 유효 구간과 관측 시각의 분리, SUPERSEDES·CONTRADICTS와 근거를 든 자동 이의, 근거 사슬과 깊이 3의 관계 경로, 범위가 엇갈리는 길의 차단, Provider로 나가는 이름의 등급 | 확정(잠정 결정 포함). 구현은 T01~T10이 끝났고 자동 이의를 켤지는 배포처 S33을 기다린다 |
| [specs/2026-11-23-S02F-followups.md](specs/2026-11-23-S02F-followups.md) | S02 후속(#183·#193·#199·#210): 맞대신 쌍은 나중 줄만 세기, 조직 신호는 끝이 조직일 때만, 구분 표시를 끄면 후보 다시 계산, 항목 시작 사슬의 `HAS` 행 보임 검사, 범위를 지키는 가드 시험 여섯 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-I02F-followups.md](specs/2026-11-24-I02F-followups.md) | I02 후속(#237·#263·#249): 삭제 보류가 스스로 풀리지 않게, "폴더에서 보기"의 읽기 관문, 읽지 않는 위치의 삭제 반영 거절, 전체 다시 훑기의 `instance-busy` 답, 첨부만 바뀐 개정을 변경으로 판정, DOCX 메모 위치 문구 | 확정(잠정 결정 포함) |
| [specs/2026-11-22-S03-analytical-semantic.md](specs/2026-11-22-S03-analytical-semantic.md) | 분석 의미(S03, #24): Dataset·Metric·Join을 등록 행으로 적기, 표 원본에서 실제 스키마 읽기(Dataset 프로파일), 데이터 검사 넷(스키마·Grain·Join cardinality·집계)과 그것을 지나야 하는 승격, 단위·통화·기간·version 충돌, 값을 계산하지 않음, 검토 API 계약, 작업 분해. S02 spec(개체 해소·시간 그래프·충돌) 위에 쓴다 | 확정(잠정 결정 포함). 구현은 T01~T10이 끝났고 프로파일을 켤지는 배포처 S34가 정한다 |
| [specs/2026-11-23-K01-wiki-projection.md](specs/2026-11-23-K01-wiki-projection.md) | 근거 기반 Wiki 투영(K01, #25): 종류별 페이지·index·log를 정본 SQLite의 투영으로 만들기, backlink, 원본 삭제·범위 승계, 다시 만들기, 메모·숨김 편집 레이어, 선택 LLM 요약, API와 "위키" 화면. Wiki OSS는 들이지 않는다 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-K01K02F-followups.md](specs/2026-11-24-K01K02F-followups.md) | K01·K02 후속(#25·#235·#220·#225·#247): 만들기 되돌리기·재검토에서 대상 없는 발견 지우기, 놓친 것 신고의 대표 옮기기, Wiki 이력 줄에서 빠진 수 숨기기, K01-T3 하지 않음 판정 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-K02-reflection-consolidation.md](specs/2026-11-23-K02-reflection-consolidation.md) | Reflection·Consolidation·Knowledge Lint(K02, #26): dirty 표시와 주기 재검토(`reflect`), 점검 규칙 넷과 발견의 상태·왔다 갔다 막기, 결정은 기존 입구로, 오탐·미탐 수, 읽기 문, "점검" 화면, 선택적 LLM 의견(`reflection.refine`) | 확정 |
| [specs/2026-11-23-P01-insight-discovery.md](specs/2026-11-23-P01-insight-discovery.md) | Insight 발견·변경 감지·설명 가능한 순위(P01, #27): 13개 유형 표와 지원 상태, Insight의 사실 줄·이유 요약·신뢰도, 규칙 틀 `recomputeInsights`, 여섯 축 순위(읽을 때 계산), 알림 제외 표시, 작업 분해(첫 묶음 T01+T02) | 확정(잠정 결정 포함) |
| [specs/2026-11-23-P02-notifications-digest-timeline.md](specs/2026-11-23-P02-notifications-digest-timeline.md) | 알림·Digest·Timeline과 반복 억제(P02, #28): 알림 줄 하나(`notifications`)와 순수 판정 함수, 작업 `notify`(scan·daily·weekly), 피드가 기본 통로·OS 토스트는 건수만 든 고정 문구의 at-most-once, 전하기 직전 확인(`mayDeliver`), 조용한 시간·다시 알림, 요약·리포트는 읽을 때 계산, 열린 화면의 5초 순번 읽기, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-23-P03-feedback-learning.md](specs/2026-11-23-P03-feedback-learning.md) | Feedback Learning(P03, #29): 여덟 가지 피드백의 종류 표와 기록 하나(`feedback`), 교정은 S01의 사용자 입구로·선호는 선호 신호로 가르기, 줄 단위 취소, 선호 신호 `preferenceSignals`(순위·피드 숨김·알림 억제·검색이 읽는 한 함수), 재추출·재검토 뒤 유지와 삭제 전파, 합성 자료의 개인화 전후 비교, 작업 분해 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-P5-followups.md](specs/2026-11-24-P5-followups.md) | Phase 5 후속 묶음(#221·#232·#238·#251·#252·#257): 충돌 Insight의 대체된 끝 건너뛰기, `graphTrace`의 끝 항목 검사, 늦은 404가 자기 Insight만 닫기, 선호의 순위 반영, `feedback.learned` 경로·체크박스, 근거 줄 `targetId`와 교정 버튼 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-H01F-followups.md](specs/2026-11-24-H01F-followups.md) | H01 후속 묶음(#270): 복원으로 멈춘 시작의 이유와 복구 절차, 이전 데이터 사본이 있을 때의 취소·새 준비 거절, 머리말의 scrypt 비용 상한과 남는 키 거절, 백업의 조각 읽기와 남은 `.partial` 치우기, 키 없는 사본의 설치 검사, 복원이 바꾸지 않는 설정(`backup.folder`·`providers.*`)과 `restore.last` 지움, 커밋된 복원을 되돌리지 않기 | 초안 |
| [specs/2026-11-23-X01-retrieval-qa.md](specs/2026-11-23-X01-retrieval-qa.md) | 질문별 Hybrid Retrieval·근거 Q&A(X01, #30): 키워드·메타데이터·항목·그래프·시간·Wiki·벡터 전략과 합치기, 길 고르기, 부족·충돌·낡음 표시, 읽기 검사 세 번과 최소 문맥, 문장마다 원본 인용, NDJSON 흘려보내기와 취소, "질문" 화면, 질문·답을 저장하지 않음, 다섯 구성 ablation과 [ADR 0025](adr/0025-retrieval-strategies.md) | 확정(잠정 결정 포함). 구현은 T1~T6이 끝났고 실제 Provider·벡터·Windows 확인과 T1 재측정은 배포처 S37~S41 |
| [specs/2026-11-23-X02-explore-ux.md](specs/2026-11-23-X02-explore-ux.md) | 전체 탐색 UX(X02, #31): "탐색"(이름 찾기·이웃 표·타임라인·근거 원본)과 "지식 검토"(승인·기각·값 고치기·충돌) 화면, 화면 사이 이동, 새 읽기 세 경로(항목 찾기·이웃·원본 version)와 읽기 문, 저장하는 것 없음 | 확정(잠정 결정 포함). 구현은 T1~T6. 실제 수집기 자료의 화면 확인은 배포처 S42 |
| [specs/2026-11-23-H01-backup-restore.md](specs/2026-11-23-H01-backup-restore.md) | 백업·복원(H01, #32): 정본 SQLite의 한 시점 사본과 목록표를 암호구로 암호화한 백업 파일, 준비 → 검사 → 다음 시작의 바꿔치기 → 장부 재적용 → 마무리(작업 회수·동의 지움·폴더 멈춤·투영 재구축), 실패 때의 되돌림, 새 스키마 거절과 옛 스키마 올리기. embedding 교체(H01-C3)는 X01 뒤로 넘김 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-H01-C3-vector-index.md](specs/2026-11-24-H01-C3-vector-index.md) | 실제 벡터 색인과 embedding 교체(H01-C3, #32): 정본과 다른 SQLite 파일에 세대별 벡터를 두는 전수 코사인 색인(잠정, sqlite-vec는 R07), 재구축·새 version 통지의 문서 embedding 쓰기 경로, 옆에 만든 세대를 대상 집합과 대조한 뒤 한 트랜잭션으로 전환, 실패·중단·꺼짐에는 이전 세대 유지, 지운 원본은 모든 세대에서 제거. 색인 만들기와 `vector` 전략은 기본 꺼짐 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-RVF-retrieval-vector-followups.md](specs/2026-11-24-RVF-retrieval-vector-followups.md) | 검색·벡터 후속 묶음(#254·#285): 질의 embedding이 전송 정책을 지나게 하기, 관련 지식 링크가 보이는 병합 줄만 따라가기, 복원 기록의 `embeddingSpaceDiffers`를 묶인 embedder의 공간과 견주기, 판 번호가 같고 표가 다른 색인 파일을 지우고 빈 색인으로 시작 | 확정(잠정 결정 포함) |
| [specs/2026-11-24-H03-C2-measure-runner.md](specs/2026-11-24-H03-C2-measure-runner.md) | 측정 실행기(H03-C2, #34): 합성 문서를 실제 백엔드에 넣어 유휴 CPU·RSS, 처리·검색 p50/p95, LLM 호출 수(대역), 저장 증가, 강제 종료 뒤 복구를 재고 JSON 결과 파일 하나로 남기는 명령. 통과선은 적되 판정하지 않음. 설치 파일 크기·Windows·실제 Provider·수 시간 가동은 미검증 | 초안 |
| [specs/2026-11-24-X02B-explore-curation.md](specs/2026-11-24-X02B-explore-curation.md) | 탐색·지식 검토의 정리 기능과 넘긴 읽기(X02B, #268): 항목 합치기·되돌리기·나누기·구별, 유효 기간·조치 이력, 이웃 그림, 유형 정의 화면, 별칭 찾기·상태로 거른 지식 목록·원본/활동 이어 읽기·인용 원본의 첨부·위치, 읽기 문, 저장하는 것 없음 | 확정(잠정 결정 포함). 구현은 T1~T5. 실제 수집기 자료의 확인은 배포처 S45 |
| [specs/2026-11-23-analytical-read-performance.md](specs/2026-11-23-analytical-read-performance.md) | 분석 읽기 속도(#233, #227 R1): 드라이버가 준비한 문장을 다시 쓰고, 한 읽기 안에서 보임 판정과 사실 행을 기억함. 질의 수로 검증, 200개×3목록 중앙값 3분의 1 이하 목표. 묶음의 구성원은 대표 아래에만 | 확정 |
| [specs/2026-11-24-P3-followups.md](specs/2026-11-24-P3-followups.md) | Phase 3 후속 묶음(#183·#193·#210·#215·#218·#227·#229·#233): 남은 항목을 코드와 대조해 분류하고, 지금 구현할 #233의 속도 한 건(P3F-R1, 읽기 한 번 안의 같은 질의 기억)만 정함. 나머지는 이슈에 둠 | 확정(잠정 결정 포함) |

## 동작 방식

문서가 서로 기대는 순서다.

1. **원 설계**가 무엇을 만들지 정한다.
2. **조사 문서**(OSS 평가, CLI Provider 조사)가 무엇을 재사용할 수 있고 무엇이 아직 확인되지 않았는지 적는다.
3. **ADR**이 조사 근거로 결정을 하나씩 내리고, 실행 근거가 없는 결정은 잠정으로 둔다.
4. **ARCHITECTURE**가 그 결정들을 한 구조로 묶고, 잠정 결정이 기대는 가정을 표로 모은다.
5. **구현 spec**(V01, V02)이 그 구조에서 만들 것과 통과 기준을 정한다.
6. **배포처**가 site-setup의 체크리스트를 따라 실행 검증을 하고, R07에서 가정 표와 대조해 ADR을 확정하거나 고친다.

## 앞으로 쓸 spec

구현 spec은 그 작업을 시작할 때 쓴다(이슈 #15 R06-C1). 지금은 Phase 1의 둘(V01, V02)과 Phase 2의 I01, I03, I04, I05, I06, 그리고 I02의 두 조각(I02-A, I02-B), Phase 4의 K01, K02, Phase 6의 X01, X02, X02B가 있다.

| 작업 | 이슈 | spec을 쓰는 때 |
|---|---|---|
| R02, R03, R04(배포처 실행 검증의 사외 준비) | #11, #12, #13 | 각 작업 착수 시. 실행 절차서와 결과 기록 양식을 함께 낸다 |
| R05(골든 데이터와 평가 기준) | #14 | 착수 시. V02보다 먼저 닫혀야 한다 |
| I01~I04(Phase 2 수집) | #18~#21 | I01, I03, I04와 I02-A, I02-B는 spec이 있다 |
| S01~S03(Phase 3 Semantic) | #22~#24 | S01은 구현이 끝났다(T01~T10. spec은 R07의 엔진 결정 전에 썼고, 그 결정에 걸리는 부분은 spec의 배경에 적었다). 자동 승격을 켤지는 배포처 S32를 기다린다. S02는 구현이 끝났다(T01~T10. 자동 이의를 켤지는 배포처 S33을 기다린다). S03은 구현이 끝났다(T01~T10. 프로파일을 켤지는 배포처 S34를 기다린다) |
| K01(Phase 4 Wiki) | #25 | spec이 확정됐다(S02·S03 위에 썼고, Wiki OSS를 들이지 않는 결정과 LLM 요약을 뒤 작업 K01-T2로 미루는 것을 spec에 적었다) |
| K02(Phase 4 Reflection·Lint) | #26 | 구현이 끝났다(T1~T3. LLM 의견은 기본 끔이고, 켤지는 배포처 S43을 기다린다) |
| P01~P03(Phase 5), H01~H03(Phase 7) | #27~#29, #32~#34 | 각 작업 착수 시 |
| X02B(X02가 넘긴 정리·읽기) | #268 | spec이 확정됐다(새 테이블·마이그레이션 없이 기존 백엔드 조치에 화면을 잇고 읽기 다섯 곳을 읽기 문으로 거른다) |
| X02(Phase 6 전체 탐색 UX) | #31 | spec이 확정됐다(저장하는 것 없이 새 읽기 세 경로와 화면 둘을 더하고 읽기 문으로 거른다) |
| X01(Phase 6 질문) | #30 | spec이 확정됐다(근거 Q&A를 단계별 NDJSON으로 흘리고, 벡터는 찾는 쪽만 부르며 기본 끈다) |

## 참고

- 전체 계획과 작업 사이의 선후: [이슈 #1 총괄](https://github.com/nohdol97/PKI/issues/1)
- 저장소 소개: [../README.md](../README.md)
