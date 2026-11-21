# fixtures

합성 데이터만 둔다. 실제 업무 자료, 계정, 주소를 넣지 않는다.

- `test-connector.jsonl`: 테스트 Connector(`test-fixtures`)가 내는 원본. 한 줄에 하나, `externalId`·`title`·`body`. 악성 변형(프롬프트 주입을 담은 합성 문서)은 `"malicious": true`를 단다. 이 표시는 합성 목록을 만들 때만 읽히고 Connector가 내는 레코드에는 실리지 않는다.

여기의 자료를 고치거나 더하면 `pnpm --filter @pki/providers build:synthetic-manifest`로 합성 목록을 다시 만들어 함께 커밋한다. 목록이 자료와 어긋나면 `pnpm test`가 실패한다.
