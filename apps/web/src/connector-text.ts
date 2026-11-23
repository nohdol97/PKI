// Words for a Connector's row on the Sources screen (I01-R17).
import {
  CREDENTIAL_REASONS,
  type ConnectorSummary,
  type CredentialReason,
  type SyncStopCode,
} from "@pki/contracts";

export const DELETIONS_MAY_BE_MISSED = "만료된 동안 지워진 원본을 놓쳤을 수 있음";

/** A note under the Connector's state, or nothing when there is none to make. */
export function connectorNote(connector: ConnectorSummary): string | undefined {
  return connector.deletionsMayBeMissed ? DELETIONS_MAY_BE_MISSED : undefined;
}

/** Why a sync stopped, in words; a stop is a 200 answer with a code, so the screen must say it (I01-R19). */
export const SYNC_STOP_TEXT: Readonly<Record<SyncStopCode, string>> = {
  "invalid-page": "수집기가 규격에 맞지 않는 응답을 보냈습니다.",
  "no-progress": "수집기가 진행 없이 더 있다고만 답했습니다.",
  "cursor-expired": "이어 받을 위치가 만료되었고 다시 받을 수 없습니다.",
  "rate-limited": "원 시스템이 요청 한도로 거절했습니다. 잠시 뒤 다시 시도하세요.",
  "connector-error": "수집기 오류가 반복되었습니다. 잠시 뒤 다시 시도하세요.",
  "connector-failed": "수집기가 실패했습니다.",
  aborted: "동기화가 취소되었습니다.",
  "instance-busy": "이 수집기가 이미 동기화 또는 가져오기 중입니다.",
  "storage-failed": "받은 자료를 저장하지 못했습니다.",
  "credential-unusable":
    "수집기의 자격 증명을 쓸 수 없어 멈췄습니다. 값을 확인한 뒤 다시 시도하세요.",
};

export const syncStopText = (code: SyncStopCode): string => SYNC_STOP_TEXT[code];

/**
 * The stop texts by instance id after one sync: that instance's text is the new stop's, or
 * gone when its sync ended without one (or failed on HTTP, which the screen shows as an error).
 */
export function nextSyncStops(
  stops: Readonly<Record<string, string>>,
  id: string,
  stopped: SyncStopCode | undefined,
): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(stops).filter(([key]) => key !== id));
  return stopped ? { ...rest, [id]: syncStopText(stopped) } : rest;
}

/** Why an instance is unavailable for want of a usable credential, and what the user can do (I06-R9, R14). */
export const CREDENTIAL_REASON_TEXT: Readonly<Record<CredentialReason, string>> = {
  "credential-store-unavailable":
    "자격 증명 저장소를 쓸 수 없습니다. 이 PC의 OS 보호 저장소를 쓸 수 있어야 값을 저장할 수 있습니다.",
  "credential-missing": "자격 증명이 없습니다. 아래에 값을 입력하세요.",
  "credential-unreadable": "저장된 자격 증명을 읽을 수 없습니다. 값을 지우고 다시 입력하세요.",
  "credential-rejected":
    "원 시스템이 자격 증명을 거부했습니다(틀림, 만료, 철회). 값을 고쳐 입력하세요.",
};

/** A slot as the store last answered for it (I06-R13); the value is never shown. */
export const CREDENTIAL_SLOT_STATE_TEXT: Readonly<
  Record<NonNullable<ConnectorSummary["credentials"]>[number]["state"], string>
> = {
  present: "저장됨",
  missing: "없음",
  unavailable: "저장소를 쓸 수 없음",
};

/** Where there is no shell there is no store to put a credential in (I06-R14). */
export const NO_CREDENTIAL_STORE_TEXT =
  "이 실행에는 저장소가 없습니다. 자격 증명은 설치된 앱에서만 입력할 수 있습니다.";

/** The stored data binds this id to another kind; the stored kind is never shown (I05F-R7, D7). */
export const KIND_MISMATCH_TEXT =
  "같은 ID가 다른 종류의 자료에 이미 쓰이고 있어 수집기를 쓸 수 없습니다. 등록의 ID나 종류를 고쳐 다시 시작하세요.";

/** The row's reason in words, for the credential reasons and the kind mismatch; nothing for the others. */
export function connectorReasonText(connector: ConnectorSummary): string | undefined {
  const { reason } = connector;
  if (reason === "instance-kind-mismatch") return KIND_MISMATCH_TEXT;
  return reason !== undefined && (CREDENTIAL_REASONS as readonly string[]).includes(reason)
    ? CREDENTIAL_REASON_TEXT[reason as CredentialReason]
    : undefined;
}
