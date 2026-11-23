// The Sources screen's Connector table: state, the note of I01-R17, the sync button,
// the reason a sync stopped, from its code only (I01-R19), and for an instance that declared
// credential slots the slots' states with the input, save and delete (I06-R14).
import type { ConnectorSummary } from "@pki/contracts";
import type { SecretAction } from "./api-key.ts";
import { SecretField } from "./secret-field.tsx";
import {
  connectorNote,
  connectorReasonText,
  CREDENTIAL_SLOT_STATE_TEXT,
  NO_CREDENTIAL_STORE_TEXT,
} from "./connector-text.ts";

const CONNECTOR_STATE: Record<ConnectorSummary["state"], string> = {
  ready: "사용 가능",
  "not-implemented": "미구현(배포처 후속)",
  unavailable: "사용 불가",
};

type Slot = NonNullable<ConnectorSummary["credentials"]>[number];

/** One slot: its state, and where the shell is there the secret field for its value (I06-R14). */
function SlotEntry({
  connectorId,
  slot,
  canEnter,
  onChange,
}: {
  connectorId: string;
  slot: Slot;
  canEnter: boolean;
  onChange: (connectorId: string, name: string, action: SecretAction) => Promise<void> | void;
}) {
  const label = `${connectorId} ${slot.slot}`;
  return (
    <li>
      {slot.slot}: {CREDENTIAL_SLOT_STATE_TEXT[slot.state]}
      {canEnter && (
        <SecretField
          inputLabel={`${label} 값`}
          saveLabel={`${label} 저장`}
          saveText="저장"
          {...(slot.state === "present" && { remove: { label: `${label} 삭제`, text: "삭제" } })}
          onAction={(action) => onChange(connectorId, slot.name, action)}
        />
      )}
    </li>
  );
}

export function ConnectorTable({
  connectors,
  syncStops,
  onSync,
  canEnterCredentials = false,
  credentialNotes = {},
  onCredentialChange = () => {},
}: {
  connectors: readonly ConnectorSummary[];
  /** By instance id: the text naming why that instance's last sync stopped. */
  syncStops: Readonly<Record<string, string>>;
  onSync: (id: string) => void;
  /** True where the shell's store is (Electron); without it a slot is shown but takes no value (I06-R14). */
  canEnterCredentials?: boolean;
  /** By instance id: what became of the last credential action. */
  credentialNotes?: Readonly<Record<string, string>>;
  onCredentialChange?: (
    connectorId: string,
    name: string,
    action: SecretAction,
  ) => Promise<void> | void;
}) {
  return (
    <>
      <table>
        <tbody>
          {connectors.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.id}</th>
              <td>{c.kind}</td>
              <td>{CONNECTOR_STATE[c.state]}</td>
              <td>
                {connectorNote(c)}
                {connectorReasonText(c) && <p>{connectorReasonText(c)}</p>}
                {syncStops[c.id] && <p role="alert">{syncStops[c.id]}</p>}
                {c.credentials && (
                  <>
                    <ul aria-label={`${c.id} 자격 증명`}>
                      {c.credentials.map((slot) => (
                        <SlotEntry
                          key={slot.slot}
                          connectorId={c.id}
                          slot={slot}
                          canEnter={canEnterCredentials}
                          onChange={onCredentialChange}
                        />
                      ))}
                    </ul>
                    {!canEnterCredentials && <p>{NO_CREDENTIAL_STORE_TEXT}</p>}
                    {credentialNotes[c.id] && <p role="status">{credentialNotes[c.id]}</p>}
                  </>
                )}
              </td>
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
