// Item curation on the 탐색 screen (X02B-R7) and the calls the 지식 검토 screen's merge candidates share (R10):
// merge another item into the one on screen, take a member back out, split rows off into a new item, and mark two
// items as different (the marks listed, each with a button that clears it). Every action goes to the existing gated
// route and is followed by the caller's re-read, so the screen shows what is stored. Names are imported text: <bdi>
// only.
import { useRef, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import {
  CURATE_FAILED,
  CURATE_HEADING,
  CURATE_KEEP_DISTINCT,
  CURATE_LOADING,
  CURATE_MEMBERS,
  CURATE_MEMBERS_NONE,
  CURATE_MERGE_NONE,
  CURATE_MERGE_SEARCH,
  CURATE_MERGE_SEARCH_SUBMIT,
  CURATE_SPLIT,
  CURATE_SPLIT_NAME,
  CURATE_SPLIT_NONE,
  CURATE_SPLIT_OPEN,
  CURATE_SPLIT_SUBMIT,
  MERGE_REFUSAL_TEXT,
  SPLIT_REFUSAL_TEXT,
} from "./entity-text.ts";
import { DistinctMarksSection } from "./entity-distinct.tsx";
import type { Center } from "./explore.tsx";
import { createBusy } from "./latest.ts";

export interface SplitRow {
  kind: "fact" | "relation";
  id: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Merges `member` into `into`; a refusal comes back as words, an error is thrown. */
export async function mergeInto(
  api: ApiClient,
  member: number,
  into: number,
): Promise<string | undefined> {
  const outcome = await api("entityMerge", { member, into });
  return outcome.status === "refused" && outcome.reason
    ? MERGE_REFUSAL_TEXT[outcome.reason]
    : undefined;
}

export const unmerge = (api: ApiClient, mergeId: number, keepDistinct: boolean) =>
  api("entityUnmerge", { mergeId, keepDistinct });

/** Moves `rows` of the item to a new item named `name`: the created item, or the refusal in words. */
export async function splitOff(
  api: ApiClient,
  itemId: number,
  rows: readonly SplitRow[],
  name: string,
): Promise<{ created: number } | { refusal: string }> {
  const outcome = await api("entitySplit", { itemId, rows: [...rows], name });
  return outcome.status === "applied" && outcome.created !== undefined
    ? { created: outcome.created }
    : { refusal: SPLIT_REFUSAL_TEXT[outcome.reason ?? "nothing-selected"] };
}

export const markDistinct = (api: ApiClient, a: number, b: number, on: boolean) =>
  api("entityDistinct", { a, b, on });

/** The centre's own fact and relation lines, which are the ones a split may take (members' lines are not its own). */
export const splitRowsOf = (center: Center) => [
  ...center.facts
    .filter((f) => f.itemId === center.id)
    .map((f) => ({ kind: "fact" as const, id: f.id, label: `사실 ${f.kind} ${f.value}` })),
  ...center.relations
    .filter((r) => r.subjectId === center.id || r.objectId === center.id)
    .map((r) => ({ kind: "relation" as const, id: r.id, label: `관계 ${r.type} ${r.id}` })),
];

export function SplitResult({
  created,
  onOpen,
}: {
  created: number;
  onOpen: (id: number) => void;
}) {
  return (
    <button type="button" onClick={() => onOpen(created)}>
      {CURATE_SPLIT_OPEN}
    </button>
  );
}

type Found = { id: number; type: string; name: string }[];
type Search = { status: "idle" } | { status: "loading" } | { status: "ready"; items: Found };
const rowKey = (r: SplitRow) => `${r.kind}${r.id}`;

export function EntityCuration({
  api,
  center,
  onChanged,
  onOpen,
}: {
  api: ApiClient;
  center: Center;
  /** Read the centre item again. */
  onChanged: () => void;
  onOpen: (itemId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ status: "idle" });
  const [notice, setNotice] = useState<string>();
  const [keepDistinct, setKeepDistinct] = useState(true);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [splitName, setSplitName] = useState("");
  const [created, setCreated] = useState<number>();
  const [marksVersion, setMarksVersion] = useState(0);
  const latest = useRef(0);

  // one action out at a time: a second press before the answer is not sent (X02F-R6)
  const [busy] = useState(createBusy);
  const attempt = (work: () => Promise<void>) =>
    busy(() => work().catch((error: unknown) => setNotice(`${CURATE_FAILED}: ${message(error)}`)));
  const find = (event: FormEvent) => {
    event.preventDefault();
    const turn = ++latest.current;
    setSearch({ status: "loading" });
    api("exploreItems", { query: query.trim() }).then(
      (page) => {
        if (turn !== latest.current) return;
        const skip = new Set([center.id, ...center.members.map((m) => m.id)]);
        setSearch({ status: "ready", items: page.items.filter((i) => !skip.has(i.id)) });
      },
      (error: unknown) => {
        if (turn !== latest.current) return;
        setSearch({ status: "idle" });
        setNotice(`${CURATE_FAILED}: ${message(error)}`);
      },
    );
  };
  const merge = (id: number) =>
    attempt(async () => {
      setNotice(await mergeInto(api, id, center.id));
      setSearch({ status: "idle" });
      onChanged();
    });
  const mark = (id: number) =>
    attempt(async () => {
      await markDistinct(api, center.id, id, true);
      setMarksVersion((v) => v + 1);
      setNotice(undefined);
    });
  const split = (event: FormEvent) => {
    event.preventDefault();
    const rows = splitRowsOf(center)
      .filter((r) => chosen.has(rowKey(r)))
      .map(({ kind, id }) => ({ kind, id }));
    void attempt(async () => {
      const done = await splitOff(api, center.id, rows, splitName.trim());
      if ("created" in done) {
        setCreated(done.created);
        setNotice(undefined);
        setChosen(new Set());
        setSplitName("");
        onChanged();
      } else setNotice(done.refusal);
    });
  };
  const toggle = (r: SplitRow) =>
    setChosen((s) => {
      const next = new Set(s);
      if (!next.delete(rowKey(r))) next.add(rowKey(r));
      return next;
    });
  const rows = splitRowsOf(center);
  return (
    <section aria-label={CURATE_HEADING}>
      <h3>{CURATE_HEADING}</h3>
      {notice && <p role="alert">{notice}</p>}
      <h4>{CURATE_MEMBERS}</h4>
      {center.members.length === 0 ? (
        <p>{CURATE_MEMBERS_NONE}</p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={keepDistinct}
              onChange={(e) => setKeepDistinct(e.target.checked)}
            />{" "}
            {CURATE_KEEP_DISTINCT}
          </label>
          <ul aria-label="구성원 목록">
            {center.members.map((m) => (
              <li key={m.id}>
                <bdi>{m.name}</bdi> ({m.type}){" "}
                {m.mergeId !== null && (
                  <button
                    type="button"
                    aria-label={`합치기 되돌리기: ${m.name}`}
                    onClick={() =>
                      void attempt(async () => {
                        await unmerge(api, m.mergeId as number, keepDistinct);
                        setNotice(undefined);
                        onChanged();
                      })
                    }
                  >
                    합치기 되돌리기
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <form onSubmit={find}>
        <label>
          {CURATE_MERGE_SEARCH} <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>{" "}
        <button type="submit">{CURATE_MERGE_SEARCH_SUBMIT}</button>
      </form>
      {search.status === "loading" && <p role="status">{CURATE_LOADING}</p>}
      {search.status === "ready" && search.items.length === 0 && <p>{CURATE_MERGE_NONE}</p>}
      {search.status === "ready" && search.items.length > 0 && (
        <ul aria-label="합칠 항목 후보">
          {search.items.map((i) => (
            <li key={i.id}>
              <bdi>{i.name}</bdi> ({i.type}){" "}
              <button
                type="button"
                aria-label={`중심 항목에 합치기: ${i.name}`}
                onClick={() => void merge(i.id)}
              >
                중심 항목에 합치기
              </button>{" "}
              <button
                type="button"
                aria-label={`다른 것 표시: ${i.name}`}
                onClick={() => void mark(i.id)}
              >
                다른 것 표시
              </button>
            </li>
          ))}
        </ul>
      )}
      <DistinctMarksSection api={api} itemId={center.id} version={marksVersion} />
      <h4>{CURATE_SPLIT}</h4>
      {rows.length === 0 ? (
        <p>{CURATE_SPLIT_NONE}</p>
      ) : (
        <form onSubmit={split}>
          <ul aria-label="나눌 줄 고르기">
            {rows.map((r) => (
              <li key={rowKey(r)}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(rowKey(r))}
                    onChange={() => toggle(r)}
                  />{" "}
                  <bdi>{r.label}</bdi>
                </label>
              </li>
            ))}
          </ul>
          <label>
            {CURATE_SPLIT_NAME}{" "}
            <input value={splitName} onChange={(e) => setSplitName(e.target.value)} />
          </label>{" "}
          <button type="submit" aria-label="선택한 줄을 새 항목으로 나누기">
            {CURATE_SPLIT_SUBMIT}
          </button>
        </form>
      )}
      {created !== undefined && <SplitResult created={created} onOpen={onOpen} />}
    </section>
  );
}
