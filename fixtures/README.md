# fixtures

합성 데이터만 둔다. 실제 업무 자료, 계정, 주소를 넣지 않는다.

- `test-connector.jsonl`: 테스트 Connector(`test-fixtures`)가 내는 원본. 한 줄에 하나, `externalId`·`title`·`body`. 악성 변형(프롬프트 주입을 담은 합성 문서)은 `"malicious": true`를 단다. 이 표시는 합성 목록을 만들 때만 읽히고 Connector가 내는 레코드에는 실리지 않는다.

- `v02-*.jsonl`: V02 수직 흐름의 가져오기 원본([V02 spec](../docs/specs/2026-11-21-V02-vertical-slice.md) R1). 한 줄이 원본 version 하나이고, 모양은 R05 골든 데이터의 SourceRecord와 같다(`content`, `connector_instance_id`, `operation`, `schema_version` 등). 스키마는 `@pki/contracts`의 `ImportRecordSchema`다.
  - `v02-mail.jsonl`(목표일), `v02-wiki.jsonl`(의존 관계), `v02-messenger.jsonl`(지연): 함께 가져오면 "의존 업무 지연" Insight 1건.
  - `v02-date-variant.jsonl`: 메신저 원본 대신 넣는 날짜 변형. 의존 대상의 날짜가 목표일보다 일러 Insight가 없다.
  - `v02-malicious.jsonl`: 세 출처의 악성 변형(스크립트 태그, 원격 이미지, "이전 지시를 무시하라"는 문장). 이것만 가져와도 같은 Insight 1건이 생긴다.
- `v02-expected.json`: 위 세 묶음(`plain`, `date-variant`, `malicious`)의 기대 결과. 항목, 사실, 관계, Insight와 각 근거(원본 version, 코드 포인트 `[시작, 끝)`, 인용문). 인용문은 자기 원본에 정확히 한 번 나온다.

여기의 자료를 고치거나 더하면 `pnpm --filter @pki/providers build:synthetic-manifest`로 합성 목록을 다시 만들어 함께 커밋한다. 목록이 자료와 어긋나면 `pnpm test`가 실패한다.
