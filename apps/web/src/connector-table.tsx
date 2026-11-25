// The Sources screen's Connector table: state, the note of I01-R17, the sync button,
// the reason a sync stopped, from its code only (I01-R19), and for an instance that declared
// credential slots the slots' states with the input, save and delete (I06-R14).
import { useState } from "react";
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

/**
 * One slot: its state, and where the shell is there the secret field for its value (I06-R14). The session
 * slot of an interactive-login instance takes no value: it shows the login button and, where a session is
 * stored, the delete (I06S-R2).
 */
function SlotEntry({
  connectorId,
  slot,
  canEnter,
  canLogin,
  onChange,
  onLogin,
}: {
  connectorId: string;
  slot: Slot;
  canEnter: boolean;
  canLogin: boolean;
  onChange: (connectorId: string, name: string, action: SecretAction) => Promise<void> | void;
  onLogin: (connectorId: string) => Promise<void> | void;
}) {
  const label = `${connectorId} ${slot.slot}`;
  const [opening, setOpening] = useState(false);
  if (slot.login) {
    return (
      <li>
        {slot.slot}: {CREDENTIAL_SLOT_STATE_TEXT[slot.state]}
        {canLogin && (
          <button
            type="button"
            aria-label={`${label} 로그인 창 열기`}
            disabled={opening}
            onClick={() => {
              setOpening(true);
              void Promise.resolve(onLogin(connectorId)).finally(() => setOpening(false));
            }}
          >
            로그인 창 열기
          </button>
        )}
        {canEnter && slot.state === "present" && (
          <button
            type="button"
            aria-label={`${label} 삭제`}
            onClick={() => void onChange(connectorId, slot.name, { kind: "delete" })}
          >
            로그아웃
          </button>
        )}
      </li>
    );
  }
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
  canLogin = false,
  credentialNotes = {},
  onCredentialChange = () => {},
  onLogin = () => {},
}: {
  connectors: readonly ConnectorSummary[];
  /** By instance id: the text naming why that instance's last sync stopped. */
  syncStops: Readonly<Record<string, string>>;
  onSync: (id: string) => void;
  /** True where the shell's store is (Electron); without it a slot is shown but takes no value (I06-R14). */
  canEnterCredentials?: boolean;
  /** True where the shell can open a login window (the preload's `openLogin`, I06S-R2). */
  canLogin?: boolean;
  /** By instance id: what became of the last credential action. */
  credentialNotes?: Readonly<Record<string, string>>;
  onCredentialChange?: (
    connectorId: string,
    name: string,
    action: SecretAction,
  ) => Promise<void> | void;
  /** The login button of an interactive-login instance's session slot; given the instance's id only. */
  onLogin?: (connectorId: string) => Promise<void> | void;
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
                          canLogin={canLogin}
                          onChange={onCredentialChange}
                          onLogin={onLogin}
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
