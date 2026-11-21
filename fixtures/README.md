# fixtures

합성 데이터만 둔다. 실제 업무 자료, 계정, 주소를 넣지 않는다.

- `test-connector.jsonl`: 테스트 Connector(`test-fixtures`)가 내는 원본. 한 줄에 하나, `externalId`·`title`·`body`. 악성 변형(프롬프트 주입을 담은 합성 문서)은 `"malicious": true`를 단다. 이 표시는 합성 목록을 만들 때만 읽히고 Connector가 내는 레코드에는 실리지 않는다.

- `v02-*.jsonl`: V02 수직 흐름의 가져오기 원본([V02 spec](../docs/specs/2026-11-21-V02-vertical-slice.md) R1). 한 줄이 원본 version 하나이고, 모양은 R05 골든 데이터의 SourceRecord와 같다(`content`, `connector_instance_id`, `operation`, `schema_version` 등). 스키마는 `@pki/contracts`의 `ImportRecordSchema`다.
  - `v02-mail.jsonl`(목표일), `v02-wiki.jsonl`(의존 관계), `v02-messenger.jsonl`(지연): 함께 가져오면 "의존 업무 지연" Insight 1건.
  - `v02-date-variant.jsonl`: 메신저 원본 대신 넣는 날짜 변형. 의존 대상의 날짜가 목표일보다 일러 Insight가 없다.
  - `v02-malicious.jsonl`: 세 출처의 악성 변형(스크립트 태그, 원격 이미지, "이전 지시를 무시하라"는 문장). 이것만 가져와도 같은 Insight 1건이 생긴다.
- `v02-expected.json`: 위 세 묶음(`plain`, `date-variant`, `malicious`)의 기대 결과. 항목, 사실, 관계, Insight와 각 근거(원본 version, 코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나온다.

여기의 자료를 고치거나 더하면 `pnpm --filter @pki/providers build:synthetic-manifest`로 합성 목록을 다시 만들어 함께 커밋한다. 목록이 자료와 어긋나면 `pnpm test`가 실패한다.

## documents/

문서 정규화(`@pki/document-normalize`)용 합성 파일이다. 내용은 모두 지어낸 것이며 `.jsonl`은 두지 않는다(합성 목록 생성기는 `fixtures/` 맨 위의 `.jsonl`만 읽는다).

- 이름 규칙: `normal-*`(정상), `limit-*`(한계 표시를 내는 파일), `corrupt-*`(손상·거부되는 파일). 형식마다 하나 이상 있다. 텍스트는 UTF-8, UTF-8 BOM, UTF-16LE·BE BOM, CRLF, EUC-KR, CP949 확장 글자("똠")를 따로 둔다. HTML에는 스크립트·이벤트 처리기·원격 그림·CSS·`iframe`이, Markdown에는 `<script>`와 원격 그림이, DOCX에는 외부 그림 연결이, PDF에는 링크 주석이 들어 있다.
- 일부러 BOM, CRLF, 깨진 바이트, 위험한 HTML을 담으므로 손으로 고치지 않는다. `.prettierignore`가 이 디렉터리를 제외한다.
- 이진 파일과 인코딩 파일은 `packages/document-normalize/src/testing/generate-fixtures.ts`가 같은 바이트로 만든다(압축 항목 시각과 PDF 날짜를 고정). 고치려면 이 스크립트를 고치고 `pnpm --filter @pki/document-normalize build:fixtures`로 다시 만들어 함께 커밋한다. 생성 결과가 커밋본과 다르면 `pnpm test`가 실패한다.
- 압축 폭탄, `../` 항목, 크기를 속인 항목 같은 공격 입력은 파일로 두지 않고 테스트가 메모리에서 만든다.
- 파일마다 기대하는 결과(오류 종류, 블록 수, 한계 표시, 인코딩, 메타데이터)는 `packages/document-normalize/src/fixtures.test.ts`의 표에 있다.
