// The 탐색 screen (X02-R6, R8): find an item by name, see its neighbours (relation, direction, steps), its facts
// and relations in time order, and open the evidence of a line down to the source. Names, values and titles are
// imported text: React text nodes inside <bdi> only (V02-R15). Nothing is stored: the search, the chosen item and
// the filters live in this component until the user leaves the screen (X02-D2).
import type { EvidenceSource, RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent, type Ref } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { SOURCE_GONE } from "./evidence-text.ts";
import { SourceView, useFocusOn } from "./evidence-view.tsx";
import {
  directionText,
  EXPLORE_EMPTY,
  EXPLORE_EVIDENCE_NONE,
  EXPLORE_GONE,
  EXPLORE_INTRO,
  EXPLORE_LOADING,
  EXPLORE_MORE,
  EXPLORE_NO_NEIGHBOURS,
  EXPLORE_SEARCH,
  EXPLORE_SEARCH_SUBMIT,
  EXPLORE_TRUNCATED,
  intervalText,
  OPEN_WIKI,
  TIMELINE_NONE,
} from "./explore-text.ts";
import { useNav } from "./nav.tsx";
import { SemanticRowActions, act, type ReviewAction } from "./semantic-review.tsx";
import { EPISTEMIC_TEXT, STATUS_TEXT } from "./semantic-text.ts";

type Response = RouteResponse<"exploreItem">;
export type Center = NonNullable<Response["center"]>;
/** The neighbourhood answer when it is not the depth refusal. */
export interface Read {
  status: "ok";
  center: Center;
  items: NonNullable<Response["items"]>;
  edges: NonNullable<Response["edges"]>;
  truncated: boolean;
}
type Edge = Read["edges"][number];
export interface ItemsPage {
  items: RouteResponse<"exploreItems">["items"];
  next: number | null;
}
export type ListState =
  { status: "loading" } | { status: "failed"; error: string } | ({ status: "ready" } & ItemsPage);
export interface Row {
  kind: "fact" | "relation";
  id: number;
}
export interface OpenEvidence {
  label: string;
  sources: EvidenceSource[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;
/** The most sources one "근거 보기" reads (provisional). */
const MAX_SOURCES = 5;

/** The first page of a search, or with `current` the page after it, appended. */
export async function searchPage(
  api: ApiClient,
  query: string,
  current?: ItemsPage,
): Promise<ItemsPage> {
  const text = query.trim();
  const page = await api("exploreItems", {
    ...(text ? { query: text } : {}),
    ...(current?.next ? { after: current.next } : {}),
  });
  return { items: [...(current?.items ?? []), ...page.items], next: page.next };
}

/** The lines the relation-type filter leaves on (the screen filters; the API does not). */
export const shownEdges = (edges: readonly Edge[], off: ReadonlySet<string>): Edge[] =>
  edges.filter((e) => !off.has(e.type));

export interface TimelineEntry {
  kind: "fact" | "relation";
  id: number;
  validAt: string | null;
  validUntil: string | null;
}
/** Facts and relations with a valid start by start date, then those without one (ties by kind and number). */
export function timelineOf(center: Center): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...center.facts.map((f) => ({
      kind: "fact" as const,
      id: f.id,
      validAt: f.validAt,
      validUntil: f.validUntil,
    })),
    ...center.relations.map((r) => ({
      kind: "relation" as const,
      id: r.id,
      validAt: r.validAt,
      validUntil: r.validUntil,
    })),
  ];
  return entries.sort((a, b) => {
    if ((a.validAt === null) !== (b.validAt === null)) return a.validAt === null ? 1 : -1;
    return (
      (a.validAt ?? "").localeCompare(b.validAt ?? "") ||
      a.kind.localeCompare(b.kind) ||
      a.id - b.id
    );
  });
}

/**
 * The sources a fact or relation line rests on: its evidence numbers from the trace, then each read through
 * `evidenceSource`. A relation has no trace of its own, so it is found in the centre item's.
 */
export async function traceEvidence(
  api: ApiClient,
  row: Row,
  centerId: number,
): Promise<EvidenceSource[]> {
  const { chains } = await api(
    "graphTrace",
    row.kind === "fact" ? { kind: "fact", id: row.id } : { kind: "item", id: centerId },
  );
  const ids = new Set(
    chains.flatMap((chain) =>
      chain.flatMap((hop) =>
        hop.edge === "SUPPORTS" &&
        hop.from.kind === row.kind &&
        hop.from.id === row.id &&
        hop.to.kind === "evidence"
          ? [hop.to.id]
          : [],
      ),
    ),
  );
  return Promise.all(
    [...ids].slice(0, MAX_SOURCES).map((evidenceId) => api("evidenceSource", { evidenceId })),
  );
}

export function ItemList({
  state,
  onOpen,
  onMore,
}: {
  state: ListState;
  onOpen: (itemId: number) => void;
  onMore: () => void;
}) {
  if (state.status === "loading") return <p role="status">{EXPLORE_LOADING}</p>;
  if (state.status === "failed") return <p role="alert">불러오지 못했습니다: {state.error}</p>;
  return (
    <>
      {state.items.length === 0 && <p>{EXPLORE_EMPTY}</p>}
      <ul aria-label="항목 목록">
        {state.items.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => onOpen(i.id)}>
              <bdi>{i.name}</bdi>
            </button>{" "}
            ({i.type})
          </li>
        ))}
      </ul>
      {state.next !== null && (
        <button type="button" onClick={onMore}>
          {EXPLORE_MORE}
        </button>
      )}
    </>
  );
}

export function Neighbourhood({
  read,
  depth,
  off,
  headingRef,
  sourceHeadingRef,
  evidence,
  onDepth,
  onToggleType,
  onOpen,
  onEvidence,
  onAct,
  onWiki,
}: {
  read: Read;
  depth: number;
  off: ReadonlySet<string>;
  headingRef: Ref<HTMLHeadingElement>;
  sourceHeadingRef: Ref<HTMLHeadingElement>;
  evidence: OpenEvidence | undefined;
  onDepth: (depth: number) => void;
  onToggleType: (type: string) => void;
  onOpen: (itemId: number) => void;
  onEvidence: (row: Row, label: string) => void;
  onAct: (action: ReviewAction) => void;
  onWiki: (key: string) => void;
}) {
  const { center } = read;
  const nameOf = (id: number) =>
    id === center.id ? center.name : (read.items.find((i) => i.id === id)?.name ?? `항목 ${id}`);
  const types = [...new Set(read.edges.map((e) => e.type))].sort();
  const edges = shownEdges(read.edges, off);
  const labelOf = (e: TimelineEntry) => {
    if (e.kind === "fact") {
      const f = center.facts.find((x) => x.id === e.id);
      return f ? `${f.kind}: ${f.value}` : `사실 ${e.id}`;
    }
    const r = center.relations.find((x) => x.id === e.id);
    return r ? `${r.type} → ${nameOf(r.objectId)}` : `관계 ${e.id}`;
  };
  const statusOf = (e: TimelineEntry) =>
    e.kind === "fact"
      ? center.facts.find((x) => x.id === e.id)
      : center.relations.find((x) => x.id === e.id);
  const timeline = timelineOf(center);
  const line = (e: TimelineEntry) => {
    const label = labelOf(e);
    const row = statusOf(e);
    return (
      <li key={`${e.kind}${e.id}`}>
        {e.kind === "fact" ? "사실" : "관계"} · <bdi>{label}</bdi>
        {row && (
          <>
            {" "}
            · {STATUS_TEXT[row.status]} · {EPISTEMIC_TEXT[row.epistemic]}
          </>
        )}{" "}
        <button
          type="button"
          aria-label={`근거 보기: ${label}`}
          onClick={() => onEvidence({ kind: e.kind, id: e.id }, label)}
        >
          근거 보기
        </button>{" "}
        <SemanticRowActions kind={e.kind} id={e.id} name={label} onAct={onAct} />
      </li>
    );
  };
  const dated = timeline.filter((e) => e.validAt !== null);
  const undated = timeline.filter((e) => e.validAt === null);
  return (
    <section aria-label="선택한 항목">
      <h2 tabIndex={-1} ref={headingRef}>
        <bdi>{center.name}</bdi>
      </h2>
      <p>
        {center.type}{" "}
        {center.wikiKey !== null && (
          <button type="button" onClick={() => onWiki(center.wikiKey as string)}>
            {OPEN_WIKI}
          </button>
        )}
      </p>
      <h3>이웃</h3>
      <p>
        <label>
          깊이{" "}
          <select value={depth} onChange={(e) => onDepth(Number(e.target.value))}>
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </p>
      {types.length > 0 && (
        <fieldset>
          <legend>관계 종류</legend>
          {types.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={!off.has(t)} onChange={() => onToggleType(t)} />{" "}
              {t}{" "}
            </label>
          ))}
        </fieldset>
      )}
      {read.truncated && <p role="status">{EXPLORE_TRUNCATED}</p>}
      {edges.length === 0 ? (
        <p>{EXPLORE_NO_NEIGHBOURS}</p>
      ) : (
        <table aria-label="이웃 표">
          <thead>
            <tr>
              <th scope="col">상대 항목</th>
              <th scope="col">관계 종류</th>
              <th scope="col">방향</th>
              <th scope="col">걸음 수</th>
              <th scope="col">이어진 곳</th>
            </tr>
          </thead>
          <tbody>
            {edges.map((e) => (
              <tr key={e.relationId}>
                <td>
                  <button type="button" onClick={() => onOpen(e.to)}>
                    <bdi>{nameOf(e.to)}</bdi>
                  </button>
                </td>
                <td>{e.type}</td>
                <td>{directionText(e.direction)}</td>
                <td>{e.step}</td>
                <td>
                  <bdi>{nameOf(e.from)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>타임라인</h3>
      <ol aria-label="시작 날짜순">
        {dated.map((e) => (
          <li key={`${e.kind}${e.id}`}>
            <time>{intervalText(e.validAt, e.validUntil)}</time>
            <ul>{line(e)}</ul>
          </li>
        ))}
        {undated.length > 0 && (
          <li>
            {TIMELINE_NONE}
            <ul>{undated.map(line)}</ul>
          </li>
        )}
      </ol>
      {evidence && (
        <section aria-label="근거 원본">
          <h3 tabIndex={-1} ref={sourceHeadingRef}>
            근거: <bdi>{evidence.label}</bdi>
          </h3>
          {evidence.sources.length === 0 && <p>{EXPLORE_EVIDENCE_NONE}</p>}
          {evidence.sources.map((s) => (
            <SourceView key={s.evidenceId} source={s} />
          ))}
        </section>
      )}
    </section>
  );
}

export function Explore({ api }: { api: ApiClient }) {
  const nav = useNav();
  const wanted = nav.target("explore")?.itemId;
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [itemId, setItemId] = useState<number>();
  const [depth, setDepth] = useState(1);
  const [read, setRead] = useState<Read>();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [evidence, setEvidence] = useState<OpenEvidence>();
  const [notice, setNotice] = useState<string>();
  const [opens, setOpens] = useState(0);
  const [sourceOpens, setSourceOpens] = useState(0);
  const headingRef = useFocusOn(opens, read !== undefined);
  const sourceHeadingRef = useFocusOn(sourceOpens, evidence !== undefined);

  const search = useCallback(
    (text: string) => {
      setList({ status: "loading" });
      searchPage(api, text).then(
        (page) => setList({ status: "ready", ...page }),
        (error: unknown) => setList({ status: "failed", error: message(error) }),
      );
    },
    [api],
  );
  useEffect(() => search(""), [search]);

  /** Reads the neighbourhood of `id`; `fresh` is an item the user just chose (focus, and nothing carried over). */
  const load = useCallback(
    (id: number, at: number, fresh: boolean) =>
      api("exploreItem", { itemId: id, depth: at }).then(
        (r) => {
          if (r.status !== "ok") return;
          setRead(r as Read);
          if (fresh) {
            setEvidence(undefined);
            setNotice(undefined);
            setOff(new Set());
            setOpens((n) => n + 1);
          }
        },
        (error: unknown) => {
          setRead(undefined);
          setNotice(gone(error) ? EXPLORE_GONE : `불러오지 못했습니다: ${message(error)}`);
        },
      ),
    [api],
  );
  const open = (id: number) => {
    setItemId(id);
    setDepth(1);
    void load(id, 1, true);
  };
  useEffect(() => {
    if (wanted !== undefined) open(wanted);
    // the target alone starts it: `open` only sets state and reads
  }, [wanted]);

  const changeDepth = (next: number) => {
    setDepth(next);
    if (itemId !== undefined) void load(itemId, next, false);
  };
  const showEvidence = (row: Row, label: string) => {
    if (!read) return;
    traceEvidence(api, row, read.center.id).then(
      (sources) => {
        setEvidence({ label, sources });
        setSourceOpens((n) => n + 1);
      },
      (error: unknown) =>
        setNotice(gone(error) ? SOURCE_GONE : `불러오지 못했습니다: ${message(error)}`),
    );
  };
  const run = (action: ReviewAction) =>
    act(api, action).then(
      (refusal) => {
        setNotice(refusal);
        if (itemId !== undefined) void load(itemId, depth, false);
      },
      (error: unknown) => setNotice(`조치하지 못했습니다: ${message(error)}`),
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    search(query);
  };
  return (
    <>
      <p>{EXPLORE_INTRO}</p>
      <form onSubmit={submit}>
        <label>
          {EXPLORE_SEARCH} <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>{" "}
        <button type="submit">{EXPLORE_SEARCH_SUBMIT}</button>
      </form>
      <ItemList
        state={list}
        onOpen={open}
        onMore={() => {
          if (list.status !== "ready") return;
          searchPage(api, query, list).then(
            (page) => setList({ status: "ready", ...page }),
            (error: unknown) => setList({ status: "failed", error: message(error) }),
          );
        }}
      />
      {notice && <p role="alert">{notice}</p>}
      {read && (
        <Neighbourhood
          read={read}
          depth={depth}
          off={off}
          headingRef={headingRef}
          sourceHeadingRef={sourceHeadingRef}
          evidence={evidence}
          onDepth={changeDepth}
          onToggleType={(type) =>
            setOff((s) => {
              const next = new Set(s);
              if (!next.delete(type)) next.add(type);
              return next;
            })
          }
          onOpen={open}
          onEvidence={showEvidence}
          onAct={(a) => void run(a)}
          onWiki={(key) => nav.go("wiki", { wikiKey: key })}
        />
      )}
    </>
  );
}
