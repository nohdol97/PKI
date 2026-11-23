// The "로컬 자료" section's actions (I02B-R38): the per-row buttons, the confirm dialog every destructive
// action goes through, and the skipped list. Every action is a named `button`, so the keyboard reaches all of
// them; the dialog moves focus to "취소" and closes on Escape.
import type { LocalLocationInfo, LocalSkippedResponse } from "@pki/contracts";
import { useEffect, useRef } from "react";
import { ACTION_TEXT, SKIP_REASON_TEXT } from "./local-locations-text.ts";

export type LocationAction =
  "pause" | "resume" | "rescan" | "relink" | "confirm" | "revoke" | "revokeContinue" | "skipped";

/** The actions a row offers in its state: a revocation is always among them. */
export function actionsFor(location: LocalLocationInfo): LocationAction[] {
  switch (location.state) {
    case "active":
      return ["pause", "rescan", "skipped", "revoke"];
    case "paused":
      return ["resume", "skipped", "revoke"];
    case "unavailable":
      return ["relink", "pause", "revoke"];
    case "needs-confirmation":
      return ["confirm", "pause", "skipped", "revoke"];
    case "revoking":
      return ["revokeContinue"];
  }
}

export function LocationActions({
  location,
  onAction,
}: {
  location: LocalLocationInfo;
  onAction: (action: LocationAction, location: LocalLocationInfo) => void;
}) {
  return (
    <>
      {actionsFor(location).map((action) => (
        <button key={action} type="button" onClick={() => onAction(action, location)}>
          {ACTION_TEXT[action]}
        </button>
      ))}
    </>
  );
}

export function ConfirmDialog({
  title,
  count,
  countLabel,
  warning,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  count: number;
  countLabel: string;
  warning: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <h3 id="confirm-dialog-title">{title}</h3>
      <p>
        {countLabel} {count}개
      </p>
      <p>{warning}</p>
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button type="button" ref={cancel} onClick={onCancel}>
        취소
      </button>
    </div>
  );
}

export function SkippedList({
  page,
  onReimport,
}: {
  page: LocalSkippedResponse;
  onReimport: (relativePath: string) => void;
}) {
  const perReason = new Map<string, number>();
  for (const item of page.items) perReason.set(item.reason, (perReason.get(item.reason) ?? 0) + 1);
  if (page.total === 0) return <p>건너뛴 파일이 없습니다.</p>;
  return (
    <>
      <ul aria-label="사유별 수">
        {[...perReason].map(([reason, n]) => (
          <li key={reason}>
            {SKIP_REASON_TEXT[reason as keyof typeof SKIP_REASON_TEXT]} {n}
          </li>
        ))}
      </ul>
      <table aria-label="건너뛴 파일">
        <thead>
          <tr>
            <th scope="col">상대 경로</th>
            <th scope="col">사유</th>
            <th scope="col">
              <span>동작</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((item) => (
            <tr key={`${item.reason}:${item.relativePath}`}>
              <td>
                <bdi>{item.relativePath}</bdi>
              </td>
              <td>{SKIP_REASON_TEXT[item.reason as keyof typeof SKIP_REASON_TEXT]}</td>
              <td>
                <button type="button" onClick={() => onReimport(item.relativePath)}>
                  {ACTION_TEXT.reimport}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {page.total > page.items.length && <p>처음 {page.items.length}개만 보입니다.</p>}
    </>
  );
}
