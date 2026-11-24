// The 탐색 screen (X02-R6, R8): find an item by name, see its neighbours (relation, direction, steps), its facts
// and relations in time order, and open the evidence of a line down to the source. Names, values and titles are
// imported text: React text nodes inside <bdi> only (V02-R15). Nothing is stored: the search, the chosen item and
// the filters live in this component until the user leaves the screen (X02-D2).
import type { EvidenceSource, RouteResponse } from "@pki/contracts";
import { useEffect, useMemo, useState, type FormEvent, type Ref } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { EntityCuration } from "./entity-curation.tsx";
import { SOURCE_GONE } from "./evidence-text.ts";
import { SourceView, useFocusOn } from "./evidence-view.tsx";
import { DETAIL_HINT, DetailPane, PaneHead, Props, Row as PaneRow } from "./panes.tsx";
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
import { createLatest } from "./latest.ts";
import { NeighbourGraph } from "./neighbour-graph.tsx";
import { useNav } from "./nav.tsx";
import { previousKey, rememberPrevious, RowDetail, type Previous } from "./row-detail.tsx";
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
  /** The submitted query that made this list; "더 보기" continues with it. */
  query: string;
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
  return { items: [...(current?.items ?? []), ...page.items], next: page.next, query };
}

/** The page after `list`, for the query that made it (not the input's current text). */
export const searchMore = (api: ApiClient, list: ItemsPage): Promise<ItemsPage> =>
  searchPage(api, list.query, list);

/** The lines the relation-type filter leaves on (the screen filters; the API does not). */
export const shownEdges = (edges: readonly Edge[], off: ReadonlySet<string>): Edge[] =>
  edges.filter((e) => !off.has(e.type));

export interface TimelineEntry {
  kind: "fact" | "relation";
  id: number;
  validAt: string | null;
  validUntil: string | null;
}
/**
 * Facts and relations with a valid start by start date, then those with only an end date, then those with
 * neither (ties by kind and number).
 */
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
  const group = (e: TimelineEntry) => (e.validAt !== null ? 0 : e.validUntil !== null ? 1 : 2);
  return entries.sort((a, b) => {
    return (
      group(a) - group(b) ||
      (a.validAt ?? "").localeCompare(b.validAt ?? "") ||
      (a.validUntil ?? "").localeCompare(b.validUntil ?? "") ||
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
  selected,
  onOpen,
  onMore,
}: {
  state: ListState;
  /** The open item, whose row is marked. */
  selected?: number | undefined;
  onOpen: (itemId: number) => void;
  onMore: () => void;
}) {
  if (state.status === "loading") return <p role="status">{EXPLORE_LOADING}</p>;
  if (state.status === "failed") return <p role="alert">불러오지 못했습니다: {state.error}</p>;
  return (
    <>
      {state.items.length === 0 && <p>{EXPLORE_EMPTY}</p>}
      <ul className="rows" aria-label="항목 목록">
        {state.items.map((i) => (
          <li key={i.id}>
            <PaneRow
              title={<bdi>{i.name}</bdi>}
              meta={
                <>
                  {i.type}
                  {i.alias !== null && (
                    <>
                      {" · "}
                      <bdi>{i.alias}</bdi>
                    </>
                  )}
                </>
              }
              selected={i.id === selected}
              onClick={() => onOpen(i.id)}
            />
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
  api,
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
  onChanged,
  onWiki,
}: {
  api: ApiClient;
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
  onAct: (action: ReviewAction) => boolean | undefined;
  /** Read the centre item again after a curation action. */
  onChanged: () => void;
  onWiki: (key: string) => void;
}) {
  const { center } = read;
  /** Each row's replaced interval lives here, not in its line: a re-read can move the line between timeline groups and mount it anew. */
  const [previous, setPrevious] = useState<ReadonlyMap<string, Previous>>(new Map());
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
        {row && (
          <RowDetail
            api={api}
            kind={e.kind}
            id={e.id}
            name={`${e.kind === "fact" ? "사실" : "관계"} ${label}`}
            validity={{ from: row.validAt, until: row.validUntil }}
            previous={previous.get(previousKey(e.kind, e.id))}
            onPrevious={(p) =>
              setPrevious((held) => rememberPrevious(held, previousKey(e.kind, e.id), p))
            }
            onChanged={onChanged}
          />
        )}
      </li>
    );
  };
  const dated = timeline.filter((e) => e.validAt !== null || e.validUntil !== null);
  const undated = timeline.filter((e) => e.validAt === null && e.validUntil === null);
  return (
    <DetailPane
      label="항목 상세"
      head={{
        title: "항목",
        right: center.wikiKey !== null && (
          <button
            type="button"
            className="btn-text"
            onClick={() => onWiki(center.wikiKey as string)}
          >
            {OPEN_WIKI}
          </button>
        ),
      }}
    >
      <h2 className="detail-title" tabIndex={-1} ref={headingRef}>
        <bdi>{center.name}</bdi>
      </h2>
      <Props items={[["유형", center.type]]} />
      <RowDetail
        key={`detail:${center.id}`}
        api={api}
        kind="item"
        id={center.id}
        name={`항목 ${center.name}`}
        onChanged={onChanged}
      />
      <div className="sec">
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
        {edges.length > 0 && (
          <NeighbourGraph
            center={center}
            items={read.items}
            edges={read.edges}
            off={off}
            onOpen={onOpen}
          />
        )}
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
      </div>
      <div className="sec">
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
      </div>
      <EntityCuration
        key={`curation:${center.id}`}
        api={api}
        center={center}
        onChanged={onChanged}
        onOpen={onOpen}
      />
      {evidence && (
        <section className="sec" aria-label="근거 원본">
          <h3 tabIndex={-1} ref={sourceHeadingRef}>
            근거: <bdi>{evidence.label}</bdi>
          </h3>
          {evidence.sources.length === 0 && <p>{EXPLORE_EVIDENCE_NONE}</p>}
          {evidence.sources.map((s) => (
            <SourceView key={s.evidenceId} source={s} />
          ))}
        </section>
      )}
    </DetailPane>
  );
}

/** What the session hands back to the screen: it draws, the session decides which answers still count. */
export interface ExploreShow {
  list(state: ListState): void;
  /** `fresh` is an item the user just chose (focus, and nothing carried over). */
  read(read: Read | undefined, fresh: boolean): void;
  evidence(evidence: OpenEvidence | undefined): void;
  notice(text: string | undefined): void;
}

/**
 * The 탐색 screen's requests and what each answer may do (X02F-R4). Out of the component so the rules are
 * reachable without a DOM (X02F-D5): the newest search wins; an item read answers only while it is the newest;
 * an evidence read answers only while no other item or line was opened after it; a re-read after an action
 * happens only while the item the action was made on is still the open one.
 */
export function createExploreSession(api: ApiClient, show: ExploreShow) {
  const lists = createLatest();
  const reads = createLatest();
  const evidences = createLatest();
  let current: { id: number; depth: number } | undefined;

  const load = (id: number, depth: number, fresh: boolean) => {
    const newest = reads.begin();
    return api("exploreItem", { itemId: id, depth }).then(
      (r) => {
        if (!newest() || r.status !== "ok") return;
        show.read(r as Read, fresh);
      },
      (error: unknown) => {
        if (!newest()) return;
        show.read(undefined, false);
        show.notice(gone(error) ? EXPLORE_GONE : `불러오지 못했습니다: ${message(error)}`);
      },
    );
  };
  const reload = (forId: number) => {
    if (current?.id === forId) void load(forId, current.depth, false);
  };
  const listed = (read: () => Promise<ItemsPage>) => {
    const newest = lists.begin();
    read().then(
      (page) => newest() && show.list({ status: "ready", ...page }),
      (error: unknown) => newest() && show.list({ status: "failed", error: message(error) }),
    );
  };
  return {
    search(text: string) {
      show.list({ status: "loading" });
      listed(() => searchPage(api, text));
    },
    more(list: ListState) {
      if (list.status === "ready") listed(() => searchMore(api, list));
    },
    open(id: number) {
      current = { id, depth: 1 };
      evidences.begin();
      void load(id, 1, true);
    },
    depth(depth: number) {
      if (!current) return;
      current = { ...current, depth };
      void load(current.id, depth, false);
    },
    evidence(row: Row, label: string, forId: number) {
      if (current?.id !== forId) return;
      const newest = evidences.begin();
      traceEvidence(api, row, current.id).then(
        (sources) => newest() && show.evidence({ label, sources }),
        (error: unknown) =>
          newest() &&
          show.notice(gone(error) ? SOURCE_GONE : `불러오지 못했습니다: ${message(error)}`),
      );
    },
    act(action: ReviewAction, forId: number) {
      return act(api, action).then(
        (refusal) => {
          show.notice(refusal);
          reload(forId);
        },
        (error: unknown) => show.notice(`조치하지 못했습니다: ${message(error)}`),
      );
    },
    /** A curation or detail change was made on item `forId`. */
    changed: reload,
  };
}

export function Explore({ api }: { api: ApiClient }) {
  const nav = useNav();
  const wanted = nav.target("explore")?.itemId;
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [depth, setDepth] = useState(1);
  const [read, setRead] = useState<Read>();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [evidence, setEvidence] = useState<OpenEvidence>();
  const [notice, setNotice] = useState<string>();
  const [opens, setOpens] = useState(0);
  const [sourceOpens, setSourceOpens] = useState(0);
  const headingRef = useFocusOn(opens, read !== undefined);
  const sourceHeadingRef = useFocusOn(sourceOpens, evidence !== undefined);
  const session = useMemo(
    () =>
      createExploreSession(api, {
        list: setList,
        read(next, fresh) {
          setRead(next);
          if (!fresh) return;
          setEvidence(undefined);
          setNotice(undefined);
          setOff(new Set());
          setOpens((n) => n + 1);
        },
        evidence(next) {
          setEvidence(next);
          setSourceOpens((n) => n + 1);
        },
        notice: setNotice,
      }),
    [api],
  );
  useEffect(() => session.search(""), [session]);

  const open = (id: number) => {
    setDepth(1);
    session.open(id);
  };
  useEffect(() => {
    if (wanted !== undefined) open(wanted);
    // the target alone starts it: `open` only sets state and reads
  }, [wanted]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    session.search(query);
  };
  return (
    <>
      <div className="pane-list">
        <PaneHead
          title="탐색"
          as="h1"
          count={list.status === "ready" ? list.items.length : undefined}
        />
        <div className="pane-body">
          <p>{EXPLORE_INTRO}</p>
          <form onSubmit={submit}>
            <label>
              {EXPLORE_SEARCH} <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>{" "}
            <button type="submit">{EXPLORE_SEARCH_SUBMIT}</button>
          </form>
          <ItemList
            state={list}
            selected={read?.center.id}
            onOpen={open}
            onMore={() => session.more(list)}
          />
          {notice && <p role="alert">{notice}</p>}
        </div>
      </div>
      {read ? (
        <Neighbourhood
          api={api}
          read={read}
          depth={depth}
          off={off}
          headingRef={headingRef}
          sourceHeadingRef={sourceHeadingRef}
          evidence={evidence}
          onDepth={(next) => {
            setDepth(next);
            session.depth(next);
          }}
          onToggleType={(type) =>
            setOff((s) => {
              const next = new Set(s);
              if (!next.delete(type)) next.add(type);
              return next;
            })
          }
          onOpen={open}
          onEvidence={(row, label) => session.evidence(row, label, read.center.id)}
          onAct={(a) => void session.act(a, read.center.id)}
          onChanged={() => session.changed(read.center.id)}
          onWiki={(key) => nav.go("wiki", { wikiKey: key })}
        />
      ) : (
        <DetailPane label="항목 상세" head={{ title: "항목" }}>
          <p className="hint">{DETAIL_HINT}</p>
        </DetailPane>
      )}
    </>
  );
}
