// The Sources screen's Connector table: state, the note of I01-R17, the sync button,
// and the reason a sync stopped, from its code only (I01-R19).
import type { ConnectorSummary } from "@pki/contracts";
import { connectorNote } from "./connector-text.ts";

const CONNECTOR_STATE: Record<ConnectorSummary["state"], string> = {
  ready: "사용 가능",
  "not-implemented": "미구현(배포처 후속)",
  unavailable: "사용 불가",
};

export function ConnectorTable({
  connectors,
  syncStop,
  onSync,
}: {
  connectors: readonly ConnectorSummary[];
  /** The text naming why the last sync stopped, if it did. */
  syncStop: string | undefined;
  onSync: (id: string) => void;
}) {
  return (
    <>
      {syncStop && <p role="alert">{syncStop}</p>}
      <table>
        <tbody>
          {connectors.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.id}</th>
              <td>{c.kind}</td>
              <td>{CONNECTOR_STATE[c.state]}</td>
              <td>{connectorNote(c)}</td>
              <td>
                {c.state === "ready" && (
                  <button type="button" aria-label={`${c.id} 동기화`} onClick={() => onSync(c.id)}>
                    동기화
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
