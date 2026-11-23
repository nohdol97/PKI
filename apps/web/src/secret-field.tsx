// The one input a secret goes into (I06F-R1): the Sources screen's Connector credential slot and the Settings
// screen's API key. The input is uncontrolled: the typed value is in the field only (not in React state, not in
// the DOM's value attribute), read once on submit and cleared before the store is asked (I06F-R2). A line break in
// anything inserted is refused in words by the way it arrives (typing, paste, drop) and the text already typed is
// left alone (I06F-R3, R4). Where the focus goes when an action ends is decided here, once (I06F-R7).
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SecretAction } from "./api-key.ts";

const HAS_LINE_BREAK = /[\r\n]/;

export function SecretField({
  inputLabel,
  showLabel = false,
  saveLabel,
  saveText,
  remove,
  disabled = false,
  onAction,
}: {
  /** The input's accessible name; with `showLabel` it is also drawn as the label's text. */
  inputLabel: string;
  showLabel?: boolean;
  /** The save button's accessible name when it differs from its text. */
  saveLabel?: string;
  saveText: string;
  /** Given only where a value is stored. */
  remove?: { label?: string; text: string };
  disabled?: boolean;
  /** Receives the action; when it ends the focus rule applies. */
  onAction: (action: SecretAction) => Promise<void> | void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const run = (action: SecretAction) => {
    working.current = true;
    setBusy(true);
    void Promise.resolve(onAction(action)).finally(() => {
      working.current = false;
      setBusy(false);
      // the focus comes back only if the user did not leave: it is in this form or nowhere (I06F-R7)
      const at = document.activeElement;
      if (!at || at === document.body || form.current?.contains(at)) field.current?.focus();
    });
  };
  // the same check for every way text can arrive; the text already in the field is not touched
  const refuseIfBroken = (event: Event, text: string | undefined) => {
    if (!HAS_LINE_BREAK.test(text ?? "")) return;
    event.preventDefault();
    run({ kind: "refused", reason: "line-break" });
  };
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    const textOf = (data: DataTransfer | null | undefined) => data?.getData("text/plain");
    const onBeforeInput = (event: InputEvent) =>
      refuseIfBroken(event, event.data || textOf(event.dataTransfer));
    const onPaste = (event: ClipboardEvent) => refuseIfBroken(event, textOf(event.clipboardData));
    const onDrop = (event: DragEvent) => refuseIfBroken(event, textOf(event.dataTransfer));
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("paste", onPaste);
    input.addEventListener("drop", onDrop);
    return () => {
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("paste", onPaste);
      input.removeEventListener("drop", onDrop);
    };
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
  const input = (
    <input
      ref={field}
      type="password"
      autoComplete="off"
      aria-label={showLabel ? undefined : inputLabel}
      disabled={disabled}
      onChange={(e) => setEmpty(e.target.value === "")}
    />
  );
  return (
    <form ref={form} aria-busy={busy} onSubmit={save}>
      {showLabel ? (
        <label>
          {inputLabel}
          {input}
        </label>
      ) : (
        input
      )}
      <button type="submit" aria-label={saveLabel} disabled={disabled || empty}>
        {saveText}
      </button>
      {remove && (
        <button
          type="button"
          aria-label={remove.label}
          disabled={busy}
          onClick={() => run({ kind: "delete" })}
        >
          {remove.text}
        </button>
      )}
    </form>
  );
}
