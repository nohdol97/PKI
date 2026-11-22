// Words for a JSONL import's result on the Sources screen (V02-R2).
import type { ImportJsonlResponse, ImportLineError } from "@pki/contracts";

const REASON: Record<ImportLineError["reason"], string> = {
  "invalid-json": "JSON 형식이 아닙니다",
  "invalid-record": "필드 형식이 맞지 않습니다",
  "content-hash-mismatch": "content_hash가 내용과 맞지 않습니다",
  "revision-not-newer": "이미 받은 version보다 새롭지 않은데 내용이 다릅니다",
  "scope-change-content-mismatch": "권한이 좁아진 줄의 내용이 저장된 최신 version과 다릅니다",
  tombstoned: "삭제되거나 권한이 철회된 원본입니다",
  "instance-conflict": "다른 종류의 Connector가 쓰는 connector_instance_id입니다",
  "too-many-instances": "한 파일에 든 connector_instance_id가 너무 많습니다",
  "instance-failed": "이 connector_instance_id의 저장이 실패해 저장하지 않았습니다",
};

export function importSummaryText({
  received,
  created,
  errors,
  errorCount,
}: ImportJsonlResponse): string {
  const listed = errorCount > errors.length ? `(처음 ${errors.length}건만 보입니다)` : "";
  return `변경 ${received}건을 읽어 새 version ${created}건을 저장했습니다. 거부된 줄 ${errorCount}건${listed}.`;
}

export function lineErrorText({ line, reason, field }: ImportLineError): string {
  return `${line}번째 줄: ${REASON[reason]}${field ? ` (${field})` : ""}`;
}
