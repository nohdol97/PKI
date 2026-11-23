// A fact, relation or item line's detail on the 탐색 screen (X02B-R8): fix the valid interval (with one step back to
// the interval it replaced) and read the action history. Dates are typed as YYYY-MM-DD, blank is none; the API
// judges the day (S02-R17). History lines hold codes and numbers only, so nothing imported reaches this view.
import type { RouteResponse } from "@pki/contracts";
import { useRef, useState, type FormEvent } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import {
  ACTOR_TEXT,
  actionText,
  DETAIL_HISTORY_LOADING,
  DETAIL_HISTORY_NONE,
  DETAIL_HISTORY_OPEN,
  DETAIL_VALIDITY_BAD,
  DETAIL_VALIDITY_FROM,
  DETAIL_VALIDITY_HINT,
  DETAIL_VALIDITY_REVERT,
  DETAIL_VALIDITY_SAVE,
  DETAIL_VALIDITY_UNTIL,
} from "./entity-text.ts";
import { STATUS_TEXT } from "./semantic-text.ts";

type HistoryLine = RouteResponse<"semanticHistory">["lines"][number];
type Validity = RouteResponse<"semanticValidity">;
type Kind = "item" | "fact" | "relation";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sets the interval of a fact or relation; blank dates are none. */
export const fixValidity = (
  api: ApiClient,
  kind: "fact" | "relation",
  id: number,
  from: string,
  until: string,
): Promise<Validity> =>
  api("semanticValidity", { kind, id, from: from.trim() || null, until: until.trim() || null });

/** A refused interval (400) in words; any other error keeps its message. */
export const validityFailure = (error: unknown): string =>
  error instanceof ApiError && error.status === 400
    ? DETAIL_VALIDITY_BAD
    : `조치하지 못했습니다: ${message(error)}`;

/** The history of one row in time order (oldest first). */
export async function loadHistory(api: ApiClient, kind: Kind, id: number): Promise<HistoryLine[]> {
  const { lines } = await api("semanticHistory", { kind, id });
  return [...lines].sort((a, b) => a.seq - b.seq);
}

const statusChange = (line: HistoryLine) =>
  line.fromStatus === null || line.fromStatus === line.toStatus
    ? STATUS_TEXT[line.toStatus]
    : `${STATUS_TEXT[line.fromStatus]} → ${STATUS_TEXT[line.toStatus]}`;

export function HistoryView({ lines }: { lines: readonly HistoryLine[] }) {
  if (lines.length === 0) return <p>{DETAIL_HISTORY_NONE}</p>;
  return (
    <ol aria-label="조치 이력">
      {lines.map((l) => (
        <li key={l.seq}>
          <time>{l.at}</time> · {ACTOR_TEXT[l.actor]} · {actionText(l.action)} · {statusChange(l)}
        </li>
      ))}
    </ol>
  );
}

export function RowDetail({
  api,
  kind,
  id,
  name,
  validity,
  onChanged,
}: {
  api: ApiClient;
  kind: Kind;
  id: number;
  /** What the row is called to a screen reader: the controls are named by it. */
  name: string;
  /** The row's interval now; absent for an item, which has none to fix. */
  validity?: { from: string | null; until: string | null } | undefined;
  onChanged: () => void;
}) {
  const [from, setFrom] = useState(validity?.from ?? "");
  const [until, setUntil] = useState(validity?.until ?? "");
  const [previous, setPrevious] = useState<Validity["previous"]>();
  const [failure, setFailure] = useState<string>();
  const [history, setHistory] = useState<HistoryLine[] | "loading">();
  const latest = useRef(0);

  const save = (next: { from: string; until: string }, keepPrevious: boolean) => {
    if (kind === "item") return;
    fixValidity(api, kind, id, next.from, next.until).then(
      (done) => {
        setFailure(undefined);
        setFrom(next.from);
        setUntil(next.until);
        setPrevious(keepPrevious ? done.previous : undefined);
        onChanged();
      },
      (error: unknown) => setFailure(validityFailure(error)),
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save({ from, until }, true);
  };
  const toggleHistory = () => {
    const turn = ++latest.current;
    if (history !== undefined) return setHistory(undefined);
    setHistory("loading");
    loadHistory(api, kind, id).then(
      (lines) => turn === latest.current && setHistory(lines),
      (error: unknown) => {
        if (turn !== latest.current) return;
        setHistory(undefined);
        setFailure(`불러오지 못했습니다: ${message(error)}`);
      },
    );
  };
  return (
    <div>
      {validity !== undefined && (
        <form onSubmit={submit}>
          <label>
            {DETAIL_VALIDITY_FROM}{" "}
            <input
              aria-label={`${DETAIL_VALIDITY_FROM}: ${name}`}
              placeholder={DETAIL_VALIDITY_HINT}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>{" "}
          <label>
            {DETAIL_VALIDITY_UNTIL}{" "}
            <input
              aria-label={`${DETAIL_VALIDITY_UNTIL}: ${name}`}
              placeholder={DETAIL_VALIDITY_HINT}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>{" "}
          <button type="submit" aria-label={`${DETAIL_VALIDITY_SAVE}: ${name}`}>
            {DETAIL_VALIDITY_SAVE}
          </button>
          {previous !== undefined && (
            <>
              {" "}
              <button
                type="button"
                aria-label={`${DETAIL_VALIDITY_REVERT}: ${name}`}
                onClick={() =>
                  save({ from: previous.from ?? "", until: previous.until ?? "" }, false)
                }
              >
                {DETAIL_VALIDITY_REVERT}
              </button>
            </>
          )}
        </form>
      )}
      {failure && <p role="alert">{failure}</p>}
      <button type="button" aria-label={`${DETAIL_HISTORY_OPEN}: ${name}`} onClick={toggleHistory}>
        {DETAIL_HISTORY_OPEN}
      </button>
      {history === "loading" && <p role="status">{DETAIL_HISTORY_LOADING}</p>}
      {Array.isArray(history) && <HistoryView lines={history} />}
    </div>
  );
}
