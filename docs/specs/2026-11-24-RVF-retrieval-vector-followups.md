# 스펙: 검색·벡터 후속 묶음 — 질의 embedding의 전송 정책, 가려진 병합의 관련 링크, 복원 기록, 색인 파일 스키마

- 날짜: 2026-11-24 / 상태: 초안(잠정 결정 D1~D6 포함)
- 관련: 이슈 #254(X01 후속), #285(H01-C3 후속). [X01 spec](2026-11-23-X01-retrieval-qa.md), [H01-C3 spec](2026-11-24-H01-C3-vector-index.md), [ADR 0025](../adr/0025-retrieval-strategies.md), [ADR 0026](../adr/0026-vector-index-generations.md), [ADR 0014](../adr/0014-egress-policy-and-consent.md)
- 번호: 요구사항 `RVF-R<n>`, 완료 기준 `RVF-C<n>`, 결정 `RVF-D<n>`, 작업 `RVF-T<n>`. 마이그레이션은 없다.

## 배경

두 이슈에 남은 항목을 지금 코드(`origin/main` 0b498f93)와 대조했다. **고칠 결함은 4건**이다(보안 2, 정확성 2). 나머지는 이미 끝났거나, 시험 보강·문구이거나, 꺼져 있는 전략의 알려진 한계라 이슈에 남긴다.

| 분류 | 이슈 항목 | 지금 코드에서의 모습 |
|---|---|---|
| **결함 → R1(보안)** | #285 질의 embedding이 전송 정책을 안 거침 | `vector` 전략이 묶인 embedder의 `embed`를 그대로 부른다(`knowledge-engine/src/retrieval/strategies.ts:245`). 서버는 embedder를 감싸지 않고 넘긴다(`backend/src/server.ts:1370`, `backend/src/ask.ts:68`). 외부 embedder를 묶은 빌드에서 `vector`를 켜면 질문 글이 정책 없이 나간다 |
| **결함 → R2(보안)** | #254 #266 덧붙임: version→항목→묶음 경로가 병합 줄을 판정하지 않음 | 적중의 관련 지식 링크가 병합 줄이 보이는지 묻지 않고 대표 항목으로 올라간다(`knowledge-engine/src/retrieval/notes.ts:100`). 가려진 병합(A가 B에 합쳐짐)이 "이 원본은 B의 근거"라는 링크로 드러난다. 그래프 읽기는 같은 경우 줄을 따라가지 않는다(`graph-read.ts:110` `groupView`) |
| **결함 → R3(정확성)** | #285 복원 뒤 `embeddingSpaceDiffers`가 항상 참 | 복원 시작이 `vectors/`를 지운 뒤 색인의 공간(없음)을 백업의 공간과 견준다(`backend/src/boot.ts:322`, `restore-boot.ts:327`). 같은 모델로 복원해도 "임베딩 공간이 달라…"가 나온다 |
| **결함 → R4(정확성)** | #285 `user_version`은 같고 스키마가 다른 색인 파일 | 판 번호만 보고 연 뒤 생성자의 첫 문장이 던진다(`storage/src/adapters/sqlite-vector-index.ts:83`·`:93`). `vectorIndexing`을 켠 백엔드가 시작하지 못한다(H01C3-R1은 "지우고 빈 색인으로 시작") |
| 이미 끝남 | #254 F2(가려진 새 version의 `stale`), R6·R12 충돌 | #261에서 고침. `notes.ts:49`가 보이는 새 version만 세고 X01 spec도 R12 쪽으로 정리됨. 시험 `retrieve.test.ts:377` |
| 이미 끝남 | #254 F3·D1의 전략별 50건 자르기, `LIMIT -1`, 단어별 목록 합치기, D2, F4, F5, P03 선호 연결 | #261·#266(X01-R19~R23). `strategies.ts:84`, `retrieve.ts:105`·`:156` |
| 미룸(이유 있음) | #254 F3·D1의 남은 둘: `temporal` 사실 200건 창, `vector` 상위 50건 | 두 전략 모두 기본 꺼짐이고(ADR 0025) X01 spec 「잘라내기 한계」에 적혀 있다. 드러나는 것은 큰 규모에서 보이는 적중의 구성뿐이다. **그 전략을 켜는 작업의 선행 조건**으로 남긴다(D5) |
| 미룸(이유 있음) | #254 #266 덧붙임의 선호 경로(`preference.ts`)와 사실·관계 가시성 | 선호는 `feedback.learned`(기본 꺼짐, 켜는 길 없음) 뒤이고 순서만 움직인다. 사실·관계가 가려져도 링크의 두 끝(원본·항목)은 둘 다 보이는 것이라 가려진 내용이 나오지 않는다(D2) |
| 미룸(이유 있음) | #285 `boot.ts`가 실패한 시작·주입 경로에서 색인을 안 닫음 | 실패한 시작은 정본 DB 손잡이도 대부분 닫지 않고 프로세스가 끝난다. 색인만의 누수가 아니고 `boot.ts`는 H02 세션과 겹친다(D6) |
| 미룸(이유 있음) | #285 삭제와 통지 embed가 겹치면 다음 시작까지 벡터 검색 꺼짐, 재구축 동안 다른 투영 삭제가 밀림 | 되살아나는 벡터는 없다. 실제 크기에서 잰 뒤 정할 설계 문제(S39) |
| 시험 보강 | #254 F6·F7, #259 덧붙임의 `ask-stream`·`Ask` 시험, #261 덧붙임의 자르기 시험, #266 덧붙임의 선호 시험 둘, #285 시험 보강 다섯 | 동작 결함이 아님 |
| 문구·문서 | #254 F8(`productCommit`), README의 `rerank` 문장, `site-setup.md` 문구, ADR 0025·`eval/results` 재측정, #285 spec 정리, 파일째 지울 때의 디스크 잔여 한 문장 | 문서만 |
| 화면(따로) | #259 덧붙임: 기간의 UTC 날짜, 2000자 안내, live region, `"code" in error`, 연결 없는 제출, 확인 칸이 질문을 고친 뒤에도 유효 | `apps/web`의 작은 개선·결정. 이 묶음은 화면을 건드리지 않는다 |
| 배포처·Windows | 두 이슈의 미검증(Windows, 실제 모델, 선호의 실제 효과, 성능 측정) | `site-setup.md` S36·S39 |

## 목표

1. 질문 글은 문서와 같은 전송 정책을 지난 뒤에만 embedder에 간다.
2. 가려진 병합 줄이 관련 지식 링크로 드러나지 않는다.
3. 복원 기록의 `embeddingSpaceDiffers`가 사실을 말한다.
4. 스키마가 다른 색인 파일이 백엔드 시작을 막지 않는다.

## 비목표

- **`vector`·`temporal` 전략이나 `vectorIndexing`·`feedback.learned`를 켜는 것.** 기본값은 그대로다.
- **외부 embedding의 동의 경로.** 정책은 지금의 `denyExternalEmbedding`(전부 거부)을 그대로 쓴다.
- **평가 실행기(`backend/src/retrieval-ablation.ts`).** 제품 경로가 아니고 문서도 직접 embedding한다. 고치지 않는다.
- **`temporal` 창·`vector` 상위 50건의 쪽 읽기, 선호 경로의 묶음 판정, `boot.ts`의 닫기 순서**(배경의 "미룸").
- **시험 보강·문구·화면 항목.** 이슈에 남긴다.
- **`graph-read.ts`·`server.ts`·`storage/src/index.ts`를 고치는 것.** 다른 세션과 겹치는 파일이다.

## 요구사항

- **RVF-R1 질의 embedding은 전송 정책을 지난다.** `ask`가 `retrieve`에 넘기는 embedder는 `embedWithinPolicy`와 `denyExternalEmbedding`으로 감싼 것이다(문서 embedding의 H01C3-R6과 같은 입구). `egress`가 `local`이 아닌 embedder의 `embed`는 불리지 않는다. 거부되면 `vector`는 `unavailable`(고정 문구 `embedding egress denied`, 정책의 이유 글은 싣지 않는다)이고 나머지 전략은 그대로 답한다(X01-R2). 다른 embedder나 다른 전략으로 바꿔 쓰지 않는다.
- **RVF-R2 관련 지식 링크는 보이는 병합 줄만 따라간다.** 적중의 항목을 대표로 올릴 때 `groupView`의 `topOf`를 쓴다(S02-R24 4항과 같은 판정). 병합 줄이나 위 항목이 `search`에서 보이지 않으면 그 항목 자신이 링크의 대상이다. 등록부가 판정하지 못하면 요청이 실패한다(X01-R12 그대로).
- **RVF-R3 `embeddingSpaceDiffers`는 백업의 공간과 묶인 embedder의 공간을 견준다.** 두 공간이 모두 있고 모델 ID·판·차원 가운데 하나라도 다를 때만 참이다. 어느 한쪽이 없으면 거짓이다. 견주기는 필드 값으로 한다(JSON 글의 키 순서에 기대지 않는다).
- **RVF-R4 판 번호가 같아도 표가 다르면 다른 스키마다.** `SqliteVectorIndex`는 `user_version`이 같은 파일의 세 표(`generations`·`vectors`·`marks`)를 쓰는 열 그대로 읽어 보고, 읽지 못하면 H01C3-R1대로 파일을 지우고 빈 색인으로 시작한다.

## 인터페이스 / 설계 개요

- **R1**: 새 파일 `backend/src/ask-embedding.ts`의 `queryEmbedding(embedder, policy = denyExternalEmbedding)`이 `status`는 그대로, `embed`는 `embedWithinPolicy`를 지나게 한 값을 돌려준다. 거부(`EmbeddingEgressDeniedError`)는 `AdapterUnavailableError("embedding egress denied")`로 바꾼다(`vectorIds`가 이미 이 오류를 `unavailable`로 알린다). `ask.ts`는 `retrieve`를 부르는 한 자리에서 `deps.vector.embedding`을 이것으로 감싼다. `AskDeps.vector`의 embedder 형에 `describe`가 더해진다. `server.ts`와 `knowledge-engine`의 `VectorDeps`·`vectorIds`는 바뀌지 않는다.
- **R2**: `notes.ts`의 `relatedLinks` 안에서 `entityGroups.representativeOf` 한 줄을 `groupView(db, judge).topOf`로 바꾼다. `graph-read.ts`는 가져다 쓰기만 한다.
- **R3**: `composition.ts`의 `embedderSpace`를 내보내고 `boot.ts`의 한 줄이 색인의 공간 대신 그것을 넘긴다. 견주기는 `restore-boot.ts`의 작은 함수 하나다.
- **R4**: `sqlite-vector-index.ts`의 `#openCurrent` 안, 판 번호가 같은 갈래에 읽어 보기를 더한다.

그림은 넣지 않는다(서로 독립인 작은 변경 넷이라 순서 있는 교환·상태 전이·네 개 이상 부품의 구조가 없다).

## 완료 기준 (테스트 가능한 형태)

| 기준 | 문장 | 증명 테스트 |
|---|---|---|
| RVF-C1 | `vector`를 켜고 준비된 `egress: "external"` embedder와 `ready`인 색인으로 `ask`를 돌리면, embedder의 `embed` 호출이 0건이고 `route.vector`가 `unavailable`(이유에 `embedding egress denied`)이며 키워드 적중은 그대로 나온다. 같은 구성의 로컬 embedder면 `vector`가 `used`다(R1) | `backend/src/ask-gate.test.ts` |
| RVF-C2 | 항목 A가 B에 합쳐져 있고 적중의 원본이 A의 근거일 때, 등록부가 그 병합 줄을 `search`에서 가리면 적중의 링크는 A이고 B가 아니다. 줄이 보이면 B다(R2) | `knowledge-engine/src/retrieval/retrieve.test.ts` |
| RVF-C3 | 백업의 공간이 묶인 embedder의 공간과 같을 때 `vectorIndexing`을 켠 복원 시작 뒤 `restore.last`의 `embeddingSpaceDiffers`가 거짓이다. 견주는 함수는 판이 다른 두 공간에 참, 한쪽이 없으면 거짓을 답한다(R3) | `backend/src/vector-index.boot.test.ts`, `backend/src/restore-boot.test.ts` |
| RVF-C4 | `user_version`이 빌드와 같고 `generations` 표의 열이 다른 파일로 `SqliteVectorIndex`를 열면 던지지 않고 `status`가 `unavailable`이며 새 세대를 만들어 활성화할 수 있다(R4) | `storage/src/adapters/sqlite-vector-index.contract.test.ts` |

경계값·조합의 전수 시험은 하지 않는다. **변이 검사는 허용·차단을 정하는 두 자리에만 한다**: ① R1의 `embedWithinPolicy`를 `embedder.embed` 직접 호출로 바꾸면 C1이 빨개진다 ② R2의 `topOf`를 `representativeOf`로 되돌리면 C2가 빨개진다. 변이가 맞힌 줄을 PR에 적는다. R3·R4는 허용·차단 검사가 아니다.

## 잠정 결정

바꾸려면 적힌 자리 하나를 고치면 된다.

- **RVF-D1 정책 검사는 `ask.ts`에 둔다.** 제품에서 `retrieve`에 embedder를 넘기는 자리가 거기 하나라 어느 호출자도 건너뛸 수 없고, 여러 세션이 고치는 `server.ts`를 건드리지 않는다. `knowledge-engine`은 `providers`를 모르므로 `vectorIds` 안에는 둘 수 없다. 조립 지점으로 옮기려면 `server.ts`의 `createAskRoute` 인자에서 감싸고 `ask.ts`의 감싸기를 지운다. 질문 글의 등급은 `embedWithinPolicy`의 지금 값(`general`)을 그대로 쓴다. 정책이 전부 거부하는 동안에는 차이가 없고, 외부 embedding의 동의 경로를 만드는 포크가 X01-D10(질문은 가장 엄격하게)에 맞춰 정한다.
- **RVF-D2 병합 판정은 관련 링크에만 넣는다.** 기본으로 켜진 경로이고 항목 이름이 화면에 나가기 때문이다. 선호 경로(`preference.ts`의 `withGroups`)는 설정이 꺼져 있고 켜는 길이 없어 뒤로 둔다. 넣으려면 그 한 줄을 `groupView`의 `membersOfTop(topOf(…))`로 바꾸고 시험 하나를 더한다. `feedback.learned`를 켜는 작업의 선행 조건이다.
- **RVF-D3 `embeddingSpaceDiffers`는 "둘 다 있고 다를 때"만 참이다.** 화면 문구가 "공간이 달라 다시 만든다"이므로 견줄 것이 없는 경우(백업에 색인이 없었음, embedder 없음)는 다르다고 하지 않는다. 색인은 복원 뒤 어느 경우에나 다시 만든다(H01C3-R10). "한쪽만 있어도 참"으로 바꾸려면 견주는 함수의 조건 하나를 고친다.
- **RVF-D4 스키마 확인은 열을 읽어 보는 것으로 한다.** `sqlite_master`의 글을 견주면 공백 차이로도 지우게 된다. 지워지는 것은 다시 만들 수 있는 투영뿐이다.
- **RVF-D5 `temporal` 200건 창과 `vector` 상위 50건은 고치지 않는다.** 두 전략은 기본 꺼짐이고 한계는 X01 spec에 적혀 있다. 켜는 작업이 먼저 `temporal`은 키워드처럼 쪽 단위로 읽고(X01-R20), `vector`는 거른 뒤 50건이 찰 때까지 `k`를 늘려 다시 찾게 한다.
- **RVF-D6 `boot.ts`의 색인 닫기는 넘긴다.** 고치는 것은 R3의 한 줄뿐이다. 실패한 시작의 정리는 정본 DB와 함께 H02의 수명 주기 작업에서 본다.

## 미검증 범위

- 외부 embedder를 실제로 묶은 빌드와 배포처 정책 아래의 동작. C1은 가짜 embedder로만 본다.
- 실제 등록부에서 병합 줄만 가려지는 경우가 생기는 조건. C2는 시험용 등록부로 가린다.
- 실제 모델(bge-m3)의 `describe()` 값으로 한 복원, Windows에서 열린 색인 파일을 지우는 동작(S39).
- 평가 실행기의 embedding은 정책 밖이다(비목표).

## 작업 분해

PR 하나, 한 구현자. 넷의 제품 파일은 서로 겹치지 않는다.

| 작업 | 산출물 | 기준 | 선행 |
|---|---|---|---|
| RVF-T1 | 질의 embedding의 정책 감싸기 | C1 | 없음 |
| RVF-T2 | 관련 링크의 병합 줄 판정 | C2 | 없음 |
| RVF-T3 | 복원 기록의 공간 견주기 | C3 | 없음 |
| RVF-T4 | 색인 파일의 표 확인 | C4 | 없음 |
| RVF-T5 | 문서: X01·H01-C3 spec과 ADR 0026의 낡는 문장과 이력 | (문서) | T1~T4 |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
|---|---|---|---|
| 2026-11-24 | 처음 씀(초안) | 전체 | 이슈 #254·#285의 남은 항목을 코드와 대조해 보안 2건·정확성 2건을 한 묶음으로 정함 |
