// The "다른 것" marks on the item shown in 항목 정리 (DPF-R3): who left each, and a button that clears it. The list is
// read by the item's own number, so the screen around it needs no change to show it. Names are imported text: <bdi> only.
import type { RouteResponse } from "@pki/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";
import {
  CURATE_DISTINCT_BY,
  CURATE_DISTINCT_HEADING,
  CURATE_DISTINCT_NONE,
  CURATE_DISTINCT_TRUNCATED,
  CURATE_DISTINCT_UNDO,
  CURATE_FAILED,
  CURATE_LOADING,
} from "./entity-text.ts";
import { createBusy, createLatest } from "./latest.ts";

export type DistinctMarks = RouteResponse<"entityDistinctMarks">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const loadMarks = (api: ApiClient, itemId: number): Promise<DistinctMarks> =>
  api("entityDistinctMarks", { itemId });

/** Clears the mark between the two items, then reads the list again. */
export async function releaseMark(
  api: ApiClient,
  itemId: number,
  otherId: number,
): Promise<DistinctMarks> {
  await api("entityDistinct", { a: itemId, b: otherId, on: false });
  return loadMarks(api, itemId);
}

export function DistinctList({
  marks,
  truncated,
  onRelease,
}: {
  marks: Readonly<DistinctMarks["marks"]>;
  truncated: boolean;
  onRelease: (otherId: number) => void;
}) {
  if (marks.length === 0) return <p>{CURATE_DISTINCT_NONE}</p>;
  return (
    <>
      <ul aria-label={CURATE_DISTINCT_HEADING}>
        {marks.map((m) => (
          <li key={m.id}>
            <bdi>{m.name}</bdi> ({m.type}) · {CURATE_DISTINCT_BY[m.by]} · {m.at}{" "}
            <button
              type="button"
              aria-label={`${CURATE_DISTINCT_UNDO}: ${m.name}`}
              onClick={() => onRelease(m.id)}
            >
              {CURATE_DISTINCT_UNDO}
            </button>
          </li>
        ))}
      </ul>
      {truncated && <p>{CURATE_DISTINCT_TRUNCATED}</p>}
    </>
  );
}

type State = { status: "loading" } | ({ status: "ready" } & DistinctMarks);

/** Reads the list when the item changes or `version` does (a mark was just made), and clears one mark on a press. */
export function DistinctMarksSection({
  api,
  itemId,
  version,
}: {
  api: ApiClient;
  itemId: number;
  version: number;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<string>();
  const [latest] = useState(createLatest);
  const [busy] = useState(createBusy);

  useEffect(() => {
    const current = latest.begin();
    setState({ status: "loading" });
    loadMarks(api, itemId).then(
      (list) => {
        if (current()) setState({ status: "ready", ...list });
      },
      (error: unknown) => {
        if (current()) setNotice(`${CURATE_FAILED}: ${message(error)}`);
      },
    );
  }, [api, itemId, version, latest]);

  const release = (otherId: number) => {
    void busy(() => {
      const current = latest.begin();
      return releaseMark(api, itemId, otherId).then(
        (list) => {
          if (!current()) return;
          setNotice(undefined);
          setState({ status: "ready", ...list });
        },
        (error: unknown) => setNotice(`${CURATE_FAILED}: ${message(error)}`),
      );
    });
  };

  return (
    <>
      <h4>{CURATE_DISTINCT_HEADING}</h4>
      {notice && <p role="alert">{notice}</p>}
      {state.status === "loading" ? (
        <p role="status">{CURATE_LOADING}</p>
      ) : (
        <DistinctList marks={state.marks} truncated={state.truncated} onRelease={release} />
      )}
    </>
  );
}
