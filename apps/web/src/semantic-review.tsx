// The 지식 검토 screen (X02-R7, R8): the Semantic registry's rows by status, one item at a time, with an
// approve/reject/dispute/undo/fix-value action on every line, and the conflict pairs. An action goes to the
// existing route, then the list is read again so what the screen shows is what is stored. Names, values and
// titles are imported text: React text nodes inside <bdi> only (V02-R15).
import type { RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import { useNav } from "./nav.tsx";
import {
  CONFLICT_TYPE_TEXT,
  CONFLICTS_EMPTY,
  CONFLICTS_TRUNCATED,
  CREATED_BY_TEXT,
  EPISTEMIC_TEXT,
  FILTER_ALL,
  refusalText,
  REVIEW_EMPTY,
  REVIEW_INTRO,
  REVIEW_LOADING,
  REVIEW_TRUNCATED,
  STATUS_ORDER,
  STATUS_TEXT,
} from "./semantic-text.ts";

type List = RouteResponse<"semantic">;
type Item = List["items"][number] | List["items"][number]["members"][number];
type Status = Item["status"];
type Kind = "item" | "fact" | "relation";

export interface Review {
  list: List;
  conflicts: RouteResponse<"conflicts">;
}
export type ReviewAction =
  | { type: "decide"; kind: Kind; id: number; action: "approve" | "reject" | "dispute" }
  | { type: "undo"; kind: Kind; id: number }
  | { type: "replace"; id: number; value: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadReview(api: ApiClient): Promise<Review> {
  const [list, conflicts] = await Promise.all([api("semantic"), api("conflicts")]);
  return { list, conflicts };
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

/** An action and then the list read again: the review as stored now, with the refusal's words if there was one. */
export async function perform(
  api: ApiClient,
  action: ReviewAction,
): Promise<{ review: Review; refusal: string | undefined }> {
  const refusal = await act(api, action);
  return { review: await loadReview(api), refusal };
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
  onAct,
  onFilter,
}: {
  review: Review;
  filter: Status | "all";
  notice?: string | undefined;
  onAct: (action: ReviewAction) => void;
  onFilter: (filter: Status | "all") => void;
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
      {review.list.truncated && <p role="status">{REVIEW_TRUNCATED}</p>}
      {shown.length === 0 && <p>{REVIEW_EMPTY}</p>}
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
  const load = useCallback(
    () =>
      loadReview(api).then(setReview, (error: unknown) =>
        setFailure(`불러오지 못했습니다: ${message(error)}`),
      ),
    [api],
  );
  useEffect(() => void load(), [load]);
  const run = (action: ReviewAction) =>
    perform(api, action).then(
      ({ review: next, refusal }) => {
        setReview(next);
        setNotice(refusal);
      },
      (error: unknown) => setNotice(`조치하지 못했습니다: ${message(error)}`),
    );
  if (failure) return <p role="alert">{failure}</p>;
  if (!review) return <p role="status">{REVIEW_LOADING}</p>;
  return (
    <ReviewView
      review={review}
      filter={filter}
      notice={notice}
      onAct={(a) => void run(a)}
      onFilter={setFilter}
    />
  );
}
