# fixtures

합성 데이터만 둔다. 실제 업무 자료, 계정, 주소를 넣지 않는다.

- `test-connector.jsonl`: 테스트 Connector(`test-fixtures`)가 내는 원본. 한 줄에 하나, `externalId`·`title`·`body`. 악성 변형(프롬프트 주입을 담은 합성 문서)은 `"malicious": true`를 단다. 이 표시는 합성 목록을 만들 때만 읽히고 Connector가 내는 레코드에는 실리지 않는다.

- `v02-*.jsonl`: V02 수직 흐름의 가져오기 원본([V02 spec](../docs/specs/2026-11-21-V02-vertical-slice.md) R1). 한 줄이 원본 version 하나이고, 모양은 R05 골든 데이터의 SourceRecord와 같다(`content`, `connector_instance_id`, `operation`, `schema_version` 등). 스키마는 `@pki/contracts`의 `ImportRecordSchema`다.
  - `v02-mail.jsonl`(목표일), `v02-wiki.jsonl`(의존 관계), `v02-messenger.jsonl`(지연): 함께 가져오면 "의존 업무 지연" Insight 1건.
  - `v02-date-variant.jsonl`: 메신저 원본 대신 넣는 날짜 변형. 의존 대상의 날짜가 목표일보다 일러 Insight가 없다.
  - `v02-malicious.jsonl`: 세 출처의 악성 변형(스크립트 태그, 원격 이미지, "이전 지시를 무시하라"는 문장). 이것만 가져와도 같은 Insight 1건이 생긴다.
- `v02-expected.json`: 위 세 묶음(`plain`, `date-variant`, `malicious`)의 기대 결과. 항목, 사실, 관계, Insight와 각 근거(원본 version, 코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나온다.

- `s01-glossary.jsonl`: S01(Semantic 등록부)의 표기·정의 추출 원본([S01 spec](../docs/specs/2026-11-22-S01-semantic-registry.md) R2·R3). 한 줄이 원본 version 하나이고 모양은 `v02-*.jsonl`과 같다. 용어집 한 쪽(`wiki-s01-0001`)과 그 악성 변형(`wiki-s01-m001`: 스크립트 태그, 원격 이미지, "이전 지시를 무시" 문장)이다. 한 개념의 정의가 두 문맥에 하나씩 있고, 표기는 약어·한영 표기·동의어 셋이며 `MT`와 `mt`는 같은 표기다.
- `s01-expected.json`: 위 두 원본의 기대 결과(`plain`, `malicious`). 개념, 표기(종류, 인용문), 정의(값, 문맥 꼬리표)와 각 근거(코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나오고, 표기는 자기 인용문 안에 있으며, 정의의 값은 인용문과 같다.

- `s02-entities.jsonl`: S02(개체 해소)의 추출 원본([S02 spec](../docs/specs/2026-11-22-S02-entity-resolution-temporal-graph.md) R4·R5·R7). 한 줄이 원본 version 하나이고 모양은 `v02-*.jsonl`과 같다. 조직 개요 한 쪽(`wiki-s02-0001`)과 그 악성 변형(`wiki-s02-m001`: 스크립트 태그, 원격 이미지, "이전 지시를 무시" 문장)이다. 사람(Person) 하나의 사번(`identifier.key`, 꼬리표 "인사")과 메일 주소(`identifier.email`), 소속·담당·의존 관계 셋, 결정(Decision) 하나의 진술(`statement`), 목록에 없는 유형 제안 하나(`Milestone`)가 있다. 메일 주소는 `example.test`다.
- `s02-expected.json`: 위 두 원본의 기대 결과(`plain`, `malicious`). 식별자(값, 꼬리표), 관계, 진술, 유형 제안과 각 근거(코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나오고, 식별자 값과 진술은 자기 인용문 안에 있다.
- `s03-analytical.jsonl`: S03(분석용 의미)의 추출 원본([S03 spec](../docs/specs/2026-11-22-S03-analytical-semantic.md) R7·R9). 한 줄이 원본 version 하나이고 모양은 `v02-*.jsonl`과 같다. 기준 문서 한 쪽(`wiki-s03-0001`: Metric "월간 매출"의 계산 기준·단위 `원`·통화 `KRW`·기간 `month`·판 `v1`, `MEASURED_ON` Dataset "월별 매출표")과 충돌 fixture 넷, 곧 한 줄짜리 문서 넷(`wiki-s03-0002`~`0005`: 단위 `천원`, 통화 `USD`, 기간 `quarter`, 판 `v2`)이다. 표 원본(CSV)은 두지 않는다: 시험이 메모리에서 만든다.
- `s03-expected.json`: 위 원본의 기대 결과(`base`, `unit`, `currency`, `period`, `version`). 사실(값, 근거)과 관계와 각 근거(코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나오고, 단위·판의 값과 계산 기준의 열 이름은 자기 인용문 안에 있다.
- `x01-ask.jsonl`: X01(질문별 검색)의 가져오기 원본([X01 spec](../docs/specs/2026-11-23-X01-retrieval-qa.md) C1a). 한 줄이 원본 version 하나이고 모양은 `v02-*.jsonl`과 같다. 개요·코드명 메모·운영 노트·배포일 안내(같은 `external_id`의 version 1·2)·점검 공지·코드명 대장 일곱 줄이다. 코드명 메모(`wiki-x01-0002`)는 두 항목의 한글 이름을 한 번도 쓰지 않고 관계의 근거가 된다.
- `x01-expected.json`: 위 원본에 심는 지식(항목, 관계, 사실, 사실 사이 `SUPERSEDES`·`CONTRADICTS` 연결과 각 근거의 인용문)과 질문 표본. 인용문은 자기 원본에 정확히 한 번 나온다. 시험이 라벨에서 심는다(추출 없음).

여기의 자료를 고치거나 더하면 `pnpm --filter @pki/providers build:synthetic-manifest`로 합성 목록을 다시 만들어 함께 커밋한다. 목록이 자료와 어긋나면 `pnpm test`가 실패한다.

- `p01-insights.json`: P01(Insight 발견)의 규칙 층 시나리오([P01 spec](../docs/specs/2026-11-23-P01-insight-discovery.md) D8). 13개 유형마다 `support`(`supported`·`unsupported`)가 있고, 지원 유형은 항목·원본·사실·관계로 된 `scenario`, 조건을 깨는 `variant`(사실 또는 관계만 바꿈), 기대 결과(`expected`: Insight의 항목, 사실 줄, 근거 인용문)를 갖는다. 관계에는 `observedAt`을 줄 수 있다(항목은 2026-11-21): "새 관계"는 관계가 항목보다 늦게 관측될 때만 선다. 미지원 유형은 `support`만 둔다. 가져오기를 지나지 않는 JSON이라 합성 목록(`.jsonl`만 읽음)에 넣지 않는다. 유형 표와 같은 13개인지는 `knowledge-engine/src/insight-code-rules.test.ts`가 대조한다.
- `p01-status.jsonl`: P01-T05의 가져오기 원본(스펙 R11·R12). 한 줄이 원본 version 하나이고 모양은 `v02-*.jsonl`과 같다. 요청(Request) "결제 연동 요청"의 상태 `open`과 목표일(`wiki-p01-0001`), 이슈(Issue) "정산 오류 이슈"의 상태 `in_progress`(`wiki-p01-0002`)다. 가져오면 "미처리 요청"과 "미해결 이슈"가 한 건씩 생긴다.
- `p01-expected.json`: 위 원본의 기대 결과(`base`). 항목, 사실(값, 근거), Insight와 각 근거(코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나온다. 추출 double(`fixtureExtraction`)이 `v02-expected.json`과 같은 모양으로 읽고, `knowledge-engine/src/insight-import.test.ts`가 대조한다.
- `p03-personalization.json`: P03(피드백 학습)의 전후 비교 시나리오([P03 spec](../docs/specs/2026-11-23-P03-feedback-learning.md) R13). Insight 신호 열네 건(`insights`: 유형·신뢰도·긴급 날짜·바뀐 시각), 사용자가 그 가운데 여섯 건에 준 피드백(`feedback`), 피드백을 주지 않은 여덟 건의 "이 사용자에게 관련 있음" 라벨(`relevant`)이다. `knowledge-engine/src/feedback-eval.test.ts`가 피드백 없는 Insight의 순위를 선호 신호 없이(전), 신호와 `feedback.learned`를 켜고(후) 계산해 상위 3건의 관련 비율과 관련 있음 평균 순위를 출력한다. 가져오기를 지나지 않는 JSON이라 합성 목록에 넣지 않는다. 장치가 식대로 도는지 보이는 합성 자료이고, 개인화가 실제로 쓸모 있다는 증거가 아니다.

## documents/

문서 정규화(`@pki/document-normalize`)용 합성 파일이다. 내용은 모두 지어낸 것이며 `.jsonl`은 두지 않는다(합성 목록 생성기는 `fixtures/` 맨 위의 `.jsonl`만 읽는다).

- 이름 규칙: `normal-*`(정상), `limit-*`(한계 표시를 내는 파일), `corrupt-*`(손상·거부되는 파일). 형식마다 하나 이상 있다. 텍스트는 UTF-8, UTF-8 BOM, UTF-16LE·BE BOM, CRLF, EUC-KR, CP949 확장 글자("똠")를 따로 둔다. HTML에는 스크립트·이벤트 처리기·원격 그림·CSS·`iframe`이, Markdown에는 `<script>`와 원격 그림이, DOCX에는 외부 그림 연결이, PDF에는 링크 주석이 들어 있다.
- 일부러 BOM, CRLF, 깨진 바이트, 위험한 HTML을 담으므로 손으로 고치지 않는다. `.prettierignore`가 이 디렉터리를 제외한다. 저장소 맨 위의 `.gitattributes`가 이 디렉터리를 `-text`로 두므로 `core.autocrlf=true`로 체크아웃해도 바이트가 바뀌지 않는다(이 속성은 `fixtures.test.ts`가 파일마다 확인한다).
- 이진 파일과 인코딩 파일은 `packages/document-normalize/src/testing/generate-fixtures.ts`가 같은 바이트로 만든다(압축 항목 시각과 PDF 날짜를 고정). 고치려면 이 스크립트를 고치고 `pnpm --filter @pki/document-normalize build:fixtures`로 다시 만들어 함께 커밋한다. 생성 결과가 커밋본과 다르면 `pnpm test`가 실패한다.
- 압축 폭탄, `../` 항목, 크기를 속인 항목 같은 공격 입력은 파일로 두지 않고 테스트가 메모리에서 만든다.
- 파일마다 기대하는 결과(오류 종류, 블록 수, 한계 표시, 인코딩, 메타데이터)는 `packages/document-normalize/src/fixtures.test.ts`의 표에 있다.
