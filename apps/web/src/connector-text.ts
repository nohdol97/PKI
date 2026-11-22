// Words for a Connector's row on the Sources screen (I01-R17).
import type { ConnectorSummary, SyncStopCode } from "@pki/contracts";

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
