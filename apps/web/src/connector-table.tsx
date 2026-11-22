// The Sources screen's Connector table: state, the note of I01-R17, the sync button,
// the reason a sync stopped, from its code only (I01-R19), and for an instance that declared
// credential slots the slots' states with the input, save and delete (I06-R14).
import type { ConnectorSummary } from "@pki/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CredentialAction } from "./connector-credential.ts";
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
 * One slot: its state, and where the shell is there the input, save and (for a stored value) delete. The
 * input is uncontrolled: the typed value is in the field only (not in React state, not in the DOM's value
 * attribute), read on submit and cleared at once. A line break or a value over the limit is refused in words
 * and never altered (I06-T04 decision, F3). The input stays enabled so the focus is kept (F4).
 */
function SlotEntry({
  connectorId,
  slot,
  canEnter,
  onChange,
}: {
  connectorId: string;
  slot: Slot;
  canEnter: boolean;
  onChange: (connectorId: string, name: string, action: CredentialAction) => Promise<void> | void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const label = `${connectorId} ${slot.slot}`;
  const run = (action: CredentialAction) => {
    working.current = true;
    setBusy(true);
    void Promise.resolve(onChange(connectorId, slot.name, action)).finally(() => {
      working.current = false;
      setBusy(false);
      field.current?.focus();
    });
  };
  const refuseLineBreak = () => {
    if (field.current) field.current.value = "";
    setEmpty(true);
    run({ kind: "refused", reason: "line-break" });
  };
  // typed or inserted text with a line break: the field would turn it into a space
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    const onBeforeInput = (event: InputEvent) => {
      if (/[\r\n]/.test(event.data ?? "")) {
        event.preventDefault();
        refuseLineBreak();
      }
    };
    input.addEventListener("beforeinput", onBeforeInput);
    return () => input.removeEventListener("beforeinput", onBeforeInput);
  });
  const save = (event: FormEvent) => {
    event.preventDefault();
    const input = field.current;
    if (!input || working.current || input.value === "") return;
    const typed = input.value;
    input.value = ""; // the value leaves the page as soon as it is handed over
    setEmpty(true);
    run({ kind: "save", value: typed });
  };
  return (
    <li aria-busy={busy}>
      {slot.slot}: {CREDENTIAL_SLOT_STATE_TEXT[slot.state]}
      {canEnter && (
        <form onSubmit={save}>
          <input
            ref={field}
            type="password"
            autoComplete="off"
            aria-label={`${label} 값`}
            onChange={(e) => setEmpty(e.target.value === "")}
            onPaste={(e) => {
              if (/[\r\n]/.test(e.clipboardData.getData("text"))) {
                e.preventDefault();
                refuseLineBreak();
              }
            }}
          />
          <button type="submit" aria-label={`${label} 저장`} disabled={empty}>
            저장
          </button>
          {slot.state === "present" && (
            <button
              type="button"
              aria-label={`${label} 삭제`}
              disabled={busy}
              onClick={() => run({ kind: "delete" })}
            >
              삭제
            </button>
          )}
        </form>
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
    action: CredentialAction,
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
