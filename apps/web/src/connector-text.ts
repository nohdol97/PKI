// Words for a Connector's row on the Sources screen (I01-R17).
import type { ConnectorSummary } from "@pki/contracts";

export const DELETIONS_MAY_BE_MISSED = "만료된 동안 지워진 원본을 놓쳤을 수 있음";

/** A note under the Connector's state, or nothing when there is none to make. */
export function connectorNote(connector: ConnectorSummary): string | undefined {
  return connector.deletionsMayBeMissed ? DELETIONS_MAY_BE_MISSED : undefined;
}
