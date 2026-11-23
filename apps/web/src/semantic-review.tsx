// The 지식 검토 screen (X02-R7, R8): the Semantic registry's rows by status, one item at a time, with an
// approve/reject/dispute/undo/fix-value action on every line, and the conflict pairs. An action goes to the
// existing route, then the list is read again so what the screen shows is what is stored. Names, values and
// titles are imported text: React text nodes inside <bdi> only (V02-R15).
import type { RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import { markDistinct, mergeInto } from "./entity-curation.tsx";
import { createBusy } from "./latest.ts";
import { useNav } from "./nav.tsx";
import {
  CONFLICT_TYPE_TEXT,
  CONFLICTS_EMPTY,
  CONFLICTS_TRUNCATED,
  CREATED_BY_TEXT,
  EPISTEMIC_TEXT,
  FILTER_ALL,
  PAIRS_EMPTY,
  PAIRS_HEADING,
  refusalText,
  REVIEW_EMPTY,
  REVIEW_INTRO,
  REVIEW_LOADING,
  REVIEW_MORE,
  REVIEW_REREAD_FAILED,
  STATUS_ORDER,
  STATUS_TEXT,
} from "./semantic-text.ts";

type List = RouteResponse<"semanticPage">;
type Item = List["items"][number] | List["items"][number]["members"][number];
type Status = Item["status"];
type Kind = "item" | "fact" | "relation";

/** A merge candidate pair with both names (a pair with a name the read leaves out is not listed). */
export interface Pair {
  a: { id: number; name: string };
  b: { id: number; name: string };
}
export interface Review {
  list: List;
  conflicts: RouteResponse<"conflicts">;
  pairs: Pair[];
  /** How many pages of the list were read: an action reads that many again (X02F-R5). */
  pages: number;
}
/** What an action answers: the refusal in words, and the review read again, or why it could not be. */
export interface Performed {
  review: Review | undefined;
  refusal: string | undefined;
  /** Set when the action went through but the list could not be read again. */
  rereadFailed?: string;
}
export type PairAction =
  { type: "merge"; member: number; into: number } | { type: "distinct"; a: number; b: number };
export type ReviewAction =
  | { type: "decide"; kind: Kind; id: number; action: "approve" | "reject" | "dispute" }
  | { type: "undo"; kind: Kind; id: number }
  | { type: "replace"; id: number; value: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const statusRequest = (filter: Status | "all") => (filter === "all" ? {} : { status: filter });

/** The candidate pairs and the names of their items (`exploreNames` takes 200 numbers at most). */
async function loadPairs(api: ApiClient): Promise<Pair[]> {
  const { candidates } = await api("entityCandidates");
  const ids = [...new Set(candidates.flatMap((c) => [c.a, c.b]))];
  const chunks = Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) =>
    ids.slice(i * 200, i * 200 + 200),
  );
  const names = new Map(
    (await Promise.all(chunks.map((c) => api("exploreNames", { ids: c }))))
      .flatMap((r) => r.items)
      .map((i) => [i.id, i.name]),
  );
  return candidates.flatMap((c) => {
    const a = names.get(c.a);
    const b = names.get(c.b);
    return a !== undefined && b !== undefined
      ? [{ a: { id: c.a, name: a }, b: { id: c.b, name: b } }]
      : [];
  });
}

/** The first `pages` pages of `filter`'s items (the server filters), the conflicts and the merge candidates. */
export async function loadReview(
  api: ApiClient,
  filter: Status | "all",
  pages = 1,
): Promise<Review> {
  const [first, conflicts, candidates] = await Promise.all([
    api("semanticPage", statusRequest(filter)),
    api("conflicts"),
    loadPairs(api),
  ]);
  let list = first;
  let read = 1;
  while (read < pages && list.next !== null) {
    const page = await api("semanticPage", { ...statusRequest(filter), after: list.next });
    list = { items: [...list.items, ...page.items], next: page.next };
    read += 1;
  }
  return { list, conflicts, pairs: candidates, pages: read };
}

/** The page after the one `review` holds, appended; the rest of the review stays as it was. */
export async function loadMore(
  api: ApiClient,
  review: Review,
  filter: Status | "all",
): Promise<Review> {
  if (review.list.next === null) return review;
  const page = await api("semanticPage", { ...statusRequest(filter), after: review.list.next });
  return {
    ...review,
    list: { items: [...review.list.items, ...page.items], next: page.next },
    pages: review.pages + 1,
  };
}

/** Runs one action; a refusal comes back as words, an error is thrown. */
export async function act(api: ApiClient, action: ReviewAction): Promise<string | undefined> {
  const outcome =
    action.type === "decide"
      ? await api("semanticDecide", { kind: action.kind, id: action.id, action: action.action })
      : action.type === "undo"
        ? await api("semanticUndo", { kind: action.kind, id: action.id })
        : await api("semanticCorrect", {
            correction: { action: "replace", id: action.id, value: action.value },
          });
  return outcome.status === "refused" && outcome.reason
    ? refusalText(outcome.reason, "unmet" in outcome ? outcome.unmet : undefined)
    : undefined;
}

/** The list read again after an action: the review, or the reason it could not be read (the action stands). */
async function reread(
  api: ApiClient,
  filter: Status | "all",
  pages: number,
  refusal: string | undefined,
): Promise<Performed> {
  try {
    return { review: await loadReview(api, filter, pages), refusal };
  } catch (error) {
    return { review: undefined, refusal, rereadFailed: message(error) };
  }
}

/** An action and then the list read again, as many pages as were held: the refusal's words if there was one. */
export async function perform(
  api: ApiClient,
  action: ReviewAction,
  filter: Status | "all",
  pages = 1,
): Promise<Performed> {
  return reread(api, filter, pages, await act(api, action));
}

/** A merge or "다른 것" mark of a candidate pair and then the review read again, without the pair if it is settled. */
export async function performPair(
  api: ApiClient,
  action: PairAction,
  filter: Status | "all",
  pages = 1,
): Promise<Performed> {
  let refusal: string | undefined;
  if (action.type === "merge") refusal = await mergeInto(api, action.member, action.into);
  else await markDistinct(api, action.a, action.b, true);
  return reread(api, filter, pages, refusal);
}

/** The actions of one registry row. A fact's value can be fixed here too. */
export function SemanticRowActions({
  kind,
  id,
  name,
  onAct,
}: {
  kind: Kind;
  id: number;
  /** What the row is called to a screen reader: the buttons are named by it. */
  name: string;
  onAct: (action: ReviewAction) => void;
}) {
  const [value, setValue] = useState("");
  const fix = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "") return;
    onAct({ type: "replace", id, value });
    setValue("");
  };
  const decide = (action: "approve" | "reject" | "dispute", label: string) => (
    <button
      type="button"
      aria-label={`${label}: ${name}`}
      onClick={() => onAct({ type: "decide", kind, id, action })}
    >
      {label}
    </button>
  );
  return (
    <span>
      {decide("approve", "승인")} {decide("reject", "기각")} {decide("dispute", "이의")}{" "}
      <button
        type="button"
        aria-label={`되돌리기: ${name}`}
        onClick={() => onAct({ type: "undo", kind, id })}
      >
        되돌리기
      </button>
      {kind === "fact" && (
        <form onSubmit={fix}>
          <label>
            새 값{" "}
            <input
              aria-label={`새 값: ${name}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>{" "}
          <button type="submit" aria-label={`값 고치기: ${name}`}>
            값 고치기
          </button>
        </form>
      )}
    </span>
  );
}

const itemsOf = (list: List): Item[] => list.items.flatMap((i) => [i, ...i.members]);

/** Item, fact and relation lines of the item and its members that have `filter`'s status. */
function entriesOf(item: Item, filter: Status | "all") {
  const wanted = (status: Status) => filter === "all" || status === filter;
  return {
    item: wanted(item.status),
    facts: item.facts.filter((f) => wanted(f.status)),
    relations: item.relations.filter((r) => wanted(r.status)),
  };
}

export function ReviewView({
  review,
  filter,
  notice,
  loading,
  onAct,
  onPair,
  onFilter,
  onMore,
}: {
  review: Review;
  filter: Status | "all";
  notice?: string | undefined;
  /** A page is being read: the list below is the previous one. */
  loading?: boolean | undefined;
  onAct: (action: ReviewAction) => void;
  onPair: (action: PairAction) => void;
  onFilter: (filter: Status | "all") => void;
  onMore: () => void;
}) {
  const { go } = useNav();
  const items = itemsOf(review.list);
  const nameOf = (id: number) => items.find((i) => i.id === id)?.name;
  const factOf = (id: number) => items.flatMap((i) => i.facts).find((f) => f.id === id);
  const shown = items.flatMap((item) => {
    const entries = entriesOf(item, filter);
    return entries.item || entries.facts.length > 0 || entries.relations.length > 0
      ? [{ item, entries }]
      : [];
  });
  const side = (factId: number, itemId: number) => {
    const fact = factOf(factId);
    const itemName = nameOf(itemId);
    return (
      <>
        <bdi>{itemName ?? `항목 ${itemId}`}</bdi>
        {fact ? (
          <>
            {" "}
            · {fact.kind}: <bdi>{fact.value}</bdi>
          </>
        ) : (
          <> · 사실 {factId}</>
        )}
      </>
    );
  };
  return (
    <>
      <p>{REVIEW_INTRO}</p>
      {notice && <p role="alert">{notice}</p>}
      <p>
        <label>
          상태{" "}
          <select value={filter} onChange={(e) => onFilter(e.target.value as Status | "all")}>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_TEXT[s]}
              </option>
            ))}
            <option value="all">{FILTER_ALL}</option>
          </select>
        </label>
      </p>
      {loading && <p role="status">{REVIEW_LOADING}</p>}
      {!loading && shown.length === 0 && review.list.next === null && <p>{REVIEW_EMPTY}</p>}
      <ul aria-label="지식 목록">
        {shown.map(({ item, entries }) => (
          <li key={item.id}>
            <h3>
              <bdi>{item.name}</bdi> ({item.type}){" "}
              <button type="button" onClick={() => go("explore", { itemId: item.id })}>
                탐색에서 보기
              </button>
            </h3>
            <ul>
              {entries.item && (
                <li>
                  항목 · {STATUS_TEXT[item.status]} · {EPISTEMIC_TEXT[item.epistemic]}{" "}
                  <SemanticRowActions
                    kind="item"
                    id={item.id}
                    name={`항목 ${item.name}`}
                    onAct={onAct}
                  />
                </li>
              )}
              {entries.facts.map((f) => (
                <li key={`f${f.id}`}>
                  사실 · {f.kind}: <bdi>{f.value}</bdi> · {STATUS_TEXT[f.status]} ·{" "}
                  {EPISTEMIC_TEXT[f.epistemic]} · 근거 {f.evidenceCount}{" "}
                  <SemanticRowActions
                    kind="fact"
                    id={f.id}
                    name={`사실 ${f.kind} ${f.value}`}
                    onAct={onAct}
                  />
                </li>
              ))}
              {entries.relations.map((r) => (
                <li key={`r${r.id}`}>
                  관계 · {r.type} → <bdi>{nameOf(r.objectId) ?? `항목 ${r.objectId}`}</bdi> ·{" "}
                  {STATUS_TEXT[r.status]} · {EPISTEMIC_TEXT[r.epistemic]} · 근거 {r.evidenceCount}{" "}
                  <SemanticRowActions
                    kind="relation"
                    id={r.id}
                    name={`관계 ${r.type} ${r.id}`}
                    onAct={onAct}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {review.list.next !== null && (
        <button type="button" disabled={loading} onClick={onMore}>
          {REVIEW_MORE}
        </button>
      )}
      <h2>{PAIRS_HEADING}</h2>
      {review.pairs.length === 0 && <p>{PAIRS_EMPTY}</p>}
      <ul aria-label="합치기 후보 목록">
        {review.pairs.map((p) => (
          <li key={`${p.a.id}-${p.b.id}`}>
            <bdi>{p.a.name}</bdi> · <bdi>{p.b.name}</bdi>{" "}
            <button
              type="button"
              aria-label={`${p.b.name}을(를) ${p.a.name}에 합치기`}
              onClick={() => onPair({ type: "merge", member: p.b.id, into: p.a.id })}
            >
              <bdi>{p.a.name}</bdi>에 합치기
            </button>{" "}
            <button
              type="button"
              aria-label={`${p.a.name}을(를) ${p.b.name}에 합치기`}
              onClick={() => onPair({ type: "merge", member: p.a.id, into: p.b.id })}
            >
              <bdi>{p.b.name}</bdi>에 합치기
            </button>{" "}
            <button
              type="button"
              aria-label={`다른 것: ${p.a.name}, ${p.b.name}`}
              onClick={() => onPair({ type: "distinct", a: p.a.id, b: p.b.id })}
            >
              다른 것
            </button>
          </li>
        ))}
      </ul>
      <h2>충돌</h2>
      {review.conflicts.truncated && <p role="status">{CONFLICTS_TRUNCATED}</p>}
      {review.conflicts.links.length === 0 && <p>{CONFLICTS_EMPTY}</p>}
      <ul aria-label="충돌 목록">
        {review.conflicts.links.map((l) => (
          <li key={l.id}>
            {CONFLICT_TYPE_TEXT[l.type]} ({CREATED_BY_TEXT[l.createdBy]}):{" "}
            {side(l.from.factId, l.from.itemId)}
            {" ↔ "}
            {side(l.to.factId, l.to.itemId)}{" "}
            <button
              type="button"
              aria-label={`기각: 사실 ${l.from.factId}`}
              onClick={() =>
                onAct({ type: "decide", kind: "fact", id: l.from.factId, action: "reject" })
              }
            >
              앞 사실 기각
            </button>{" "}
            <button
              type="button"
              aria-label={`기각: 사실 ${l.to.factId}`}
              onClick={() =>
                onAct({ type: "decide", kind: "fact", id: l.to.factId, action: "reject" })
              }
            >
              뒤 사실 기각
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function SemanticReview({ api }: { api: ApiClient }) {
  const [review, setReview] = useState<Review>();
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState<Status | "all">("candidate");
  const [loading, setLoading] = useState(false);
  /** The newest read: an older answer arriving later is dropped (last request wins). */
  const newest = useRef(0);
  const read = useCallback(
    <T,>(work: Promise<T>, apply: (done: T) => void, onError: (text: string) => void) => {
      const turn = ++newest.current;
      setLoading(true);
      work.then(
        (done) => {
          if (turn !== newest.current) return;
          setLoading(false);
          apply(done);
        },
        (error: unknown) => {
          if (turn !== newest.current) return;
          setLoading(false);
          onError(message(error));
        },
      );
    },
    [],
  );
  const load = useCallback(
    (at: Status | "all") =>
      read(
        loadReview(api, at),
        (next) => {
          setFailure(undefined);
          setReview(next);
        },
        (text) => setFailure(`불러오지 못했습니다: ${text}`),
      ),
    [api, read],
  );
  useEffect(() => load("candidate"), [load]);
  // one action out at a time: a second press before the answer is not sent (X02F-R6)
  const [busy] = useState(createBusy);
  const afterAction = (start: () => Promise<Performed>) => {
    const work = busy(start);
    if (work)
      read(
        work,
        ({ review: next, refusal, rereadFailed }) => {
          if (next) setReview(next);
          setNotice(rereadFailed === undefined ? refusal : (refusal ?? REVIEW_REREAD_FAILED));
        },
        (text) => setNotice(`조치하지 못했습니다: ${text}`),
      );
  };
  if (failure) return <p role="alert">{failure}</p>;
  if (!review) return <p role="status">{REVIEW_LOADING}</p>;
  return (
    <ReviewView
      review={review}
      filter={filter}
      notice={notice}
      loading={loading}
      onAct={(a) => afterAction(() => perform(api, a, filter, review.pages))}
      onPair={(a) => afterAction(() => performPair(api, a, filter, review.pages))}
      onFilter={(next) => {
        setFilter(next);
        setNotice(undefined);
        load(next);
      }}
      onMore={() =>
        read(loadMore(api, review, filter), setReview, (text) =>
          setNotice(`불러오지 못했습니다: ${text}`),
        )
      }
    />
  );
}
