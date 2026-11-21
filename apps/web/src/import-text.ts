// Words for a JSONL import's result on the Sources screen (V02-R2).
import type { ImportJsonlResponse, ImportLineError } from "@pki/contracts";

const REASON: Record<ImportLineError["reason"], string> = {
  "invalid-json": "JSON 형식이 아닙니다",
  "invalid-record": "필드 형식이 맞지 않습니다",
  "content-hash-mismatch": "content_hash가 내용과 맞지 않습니다",
  "revision-not-newer": "이미 받은 version보다 새롭지 않은데 내용이 다릅니다",
  tombstoned: "삭제되거나 권한이 철회된 원본입니다",
  "instance-conflict": "다른 종류의 Connector가 쓰는 connector_instance_id입니다",
  "change-kind-unsupported": "삭제와 권한 철회는 아직 가져오지 않습니다",
};

export function importSummaryText({ received, created, errors }: ImportJsonlResponse): string {
  return `변경 ${received}건을 읽어 새 version ${created}건을 저장했습니다. 거부된 줄 ${errors.length}건.`;
}

export function lineErrorText({ line, reason, field }: ImportLineError): string {
  return `${line}번째 줄: ${REASON[reason]}${field ? ` (${field})` : ""}`;
}
