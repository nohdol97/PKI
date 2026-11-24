// The strategies of X01-R1: each is `(question, state) -> source version row ids, best first`. A strategy that
// reads items, relations, facts or Wiki pages judges every row it reads with the registry's `visible` for a search
// (the judge of graph-read.ts); the versions it names are judged once more by the caller at its boundary (R12).
import { AdapterUnavailableError } from "@pki/contracts";
import {
  findSourceVersionId,
  isValidRow,
  linksOfFacts,
  listDatedFacts,
  listEvidence,
  listVerifiedForms,
  readItem,
  readStoredWikiPage,
  searchKeyword,
  supersedingStands,
  type DerivativeRegistry,
  type DerivedRef,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";
import { groupView, relationPaths, visibleLinks, type GraphJudge } from "../graph-read.ts";
import { findCandidates } from "../linking.ts";
import { pageKindOfType } from "../wiki-render.ts";
import { WIKI_PAGE_KIND_NAME } from "../wiki-kind.ts";
import { reciprocalSum, bestFirst } from "./fusion.ts";
import { explicitDates, hasChangeWord, keywordTokens } from "./routing.ts";
import { STRATEGY_LIST_LIMIT, type VectorDeps } from "./types.ts";

export interface Reading {
  db: SqlDriver;
  registry: DerivativeRegistry;
  judge: GraphJudge;
  question: string;
}

const refKey = (r: DerivedRef) => `${r.kind}:${r.id}`;
const itemRef = (id: number): DerivedRef => ({ kind: "item", id: String(id) });

/** The version row ids of source versions (those no longer stored are left out), each once, in order. */
function versionIds(db: SqlDriver, refs: readonly SourceVersionRef[]): number[] {
  return [...new Set(refs.flatMap((v) => findSourceVersionId(db, v.sourceId, v.version) ?? []))];
}

/**
 * The items the question's words name (X01-R1 `concept`): the group representatives whose name or `verified` form
 * the question holds, as `findCandidates` finds them for extraction, kept only when the policy shows the item.
 * Cost: one pass over the item names and the verified forms per question (the same pass extraction makes per source).
 */
export function matchItems({ db, registry, judge, question }: Reading): number[] {
  const found = findCandidates(db, question, registry);
  const shown = judge.shown(found.map(itemRef));
  return found.filter((id) => shown.has(refKey(itemRef(id))));
}

/** `concept`: the sources the matched items rest on, newest version first within an item. */
export function conceptIds(reading: Reading, items: readonly number[]): number[] {
  const { db, registry, judge } = reading;
  const groups = groupView(db, judge);
  return items
    .flatMap((item) =>
      versionIds(
        db,
        groups
          .membersOfTop(groups.topOf(item))
          .flatMap((m) => registry.lineage(db, { kind: "item", id: String(m) })),
      ).sort((a, b) => b - a),
    )
    .filter((id, i, all) => all.indexOf(id) === i);
}

/** `concept` also adds the matched items' names and `verified` forms (shown ones) as queries to the keyword strategy. */
export function conceptQueries({ db, judge }: Reading, items: readonly number[]): string[] {
  const names = items.flatMap((id) => readItem(db, id)?.name ?? []);
  const groups = groupView(db, judge);
  const members = new Set(items.flatMap((id) => groups.membersOfTop(groups.topOf(id))));
  const forms = listVerifiedForms(db).filter((f) => members.has(f.itemId));
  const ref = (f: { factId: number }): DerivedRef => ({ kind: "fact", id: String(f.factId) });
  const shown = judge.shown(forms.map(ref));
  return [...names, ...forms.filter((f) => shown.has(refKey(ref(f)))).map((f) => f.form)];
}

/** X01-D19: a query is read in pages of `size` matches, at most `pages` pages. */
export const KEYWORD_PAGING = { size: 100, pages: 5 } as const;

/**
 * `keyword`: one FTS5 query per content word, one for all of them together, and one per extra query; the lists are
 * merged by the rank-reciprocal sum so a source holding more of the words rises and no word has to be in every source.
 * Each query is read page by page in FTS order and every page goes through `admit` (R12 visibility, then the
 * conditions) before the cut, so a hidden source takes no slot; the read stops at the list limit, at the last page
 * or at the page limit (X01-R20).
 */
export function keywordIds(
  { db, question }: Reading,
  extraQueries: readonly string[],
  admit: (ids: readonly number[]) => number[],
  paging: { size: number; pages: number } = KEYWORD_PAGING,
): number[] {
  const tokens = keywordTokens(question);
  const queries = [...tokens, ...(tokens.length > 1 ? [tokens.join(" ")] : []), ...extraQueries];
  const lists = queries.map((q) => {
    const kept: number[] = [];
    for (let page = 0; page < paging.pages; page++) {
      const rows = searchKeyword(db, q, paging.size, page * paging.size);
      kept.push(...admit(rows));
      if (kept.length >= STRATEGY_LIST_LIMIT || rows.length < paging.size) break;
    }
    return kept.slice(0, STRATEGY_LIST_LIMIT);
  });
  return bestFirst(reciprocalSum(lists));
}

/** Pairs asked at most, and paths read from one item, so a question naming many items stays cheap. */
const PAIR_LIMIT = 6;
const PATH_LIMIT = 30;
const GRAPH_DEPTH = 2;

/**
 * `graph`: the relation paths (depth 2) between each two matched items, or from the one matched item; the sources
 * are those the relations on the paths rest on, shortest paths first. `relationPaths` judges every edge and the
 * whole path (S02-R23, R24).
 */
export function graphIds(reading: Reading, items: readonly number[]): number[] {
  const { db, registry } = reading;
  const asks =
    items.length >= 2
      ? items
          .flatMap((a, i) => items.slice(i + 1).map((b) => ({ from: a, to: b })))
          .slice(0, PAIR_LIMIT)
      : items.map((from) => ({ from, to: undefined }));
  const relationIds: number[] = [];
  for (const ask of asks) {
    const read = relationPaths(db, registry, { ...ask, depth: GRAPH_DEPTH }, "search");
    if (read?.status !== "ok") continue;
    for (const path of read.paths.slice(0, PATH_LIMIT)) {
      for (const hop of path) relationIds.push(hop.relationId);
    }
  }
  return versionIds(
    db,
    [...new Set(relationIds)].flatMap((id) =>
      registry.lineage(db, { kind: "relation", id: String(id) }),
    ),
  );
}

/** RSP-D1: the dated facts are read in pages of `size`, at most `pages` pages. */
export const TEMPORAL_PAGING = { size: 200, pages: 5 } as const;

/**
 * `temporal`: the shown, valid facts that carry a time (of the matched items when there are any), narrowed to the
 * dates the question names, newest first; a question about a change puts the facts that replaced another first.
 * The sources are the current evidence of those facts. The facts are read page by page and each page goes through
 * `admit` (R12 visibility, then the conditions) on its sources before the cut, so a hidden fact takes no place; the
 * read stops at STRATEGY_LIST_LIMIT admitted sources, at the last page or at the page limit (RSP-R1). The
 * change-first order runs over the facts read.
 */
export function temporalIds(
  reading: Reading,
  items: readonly number[],
  admit: (ids: readonly number[]) => number[],
  paging: { size: number; pages: number } = TEMPORAL_PAGING,
): number[] {
  const { db, registry, judge, question } = reading;
  const groups = groupView(db, judge);
  const members =
    items.length > 0 ? items.flatMap((id) => groups.membersOfTop(groups.topOf(id))) : undefined;
  const factRef = (id: number): DerivedRef => ({ kind: "fact", id: String(id) });
  const dates = explicitDates(question);
  const sourcesOf = (factId: number) =>
    listEvidence(db, { factId })
      .sort((a, b) => Number(b.current) - Number(a.current) || b.id - a.id)
      .map((e) => e.sourceVersionId);
  const facts: { id: number }[] = [];
  const admitted = new Set<number>();
  for (let page = 0; page < paging.pages; page++) {
    const rows = listDatedFacts(db, members, paging.size, page * paging.size);
    const dated = rows.filter((f) => isValidRow(db, { kind: "fact", id: f.id }, f.status));
    const shown = judge.shown(dated.map((f) => factRef(f.id)));
    const kept = dated
      .filter((f) => shown.has(refKey(factRef(f.id))))
      .filter(
        (f) =>
          dates.length === 0 ||
          dates.some((d) => (f.validAt ?? "").startsWith(d) || (f.validUntil ?? "").startsWith(d)),
      );
    facts.push(...kept);
    for (const id of admit(kept.flatMap((f) => sourcesOf(f.id)))) admitted.add(id);
    if (admitted.size >= STRATEGY_LIST_LIMIT || rows.length < paging.size) break;
  }
  const replacing = new Set(
    visibleLinks(
      db,
      registry,
      judge,
      linksOfFacts(
        db,
        facts.map((f) => f.id),
      ),
    )
      .filter((l) => supersedingStands(db, l))
      .map((l) => l.fromFactId),
  );
  const first = hasChangeWord(question) ? (id: number) => (replacing.has(id) ? 0 : 1) : () => 0;
  const ordered = [...facts].sort((a, b) => first(a.id) - first(b.id));
  return [...new Set(ordered.flatMap((f) => sourcesOf(f.id)))];
}

/** `wiki`: the sources the matched items' Wiki pages rest on (a page that is absent or not shown gives none; D11: the page text is a clue, never evidence). */
export function wikiIds(reading: Reading, items: readonly number[]): number[] {
  const { db, registry, judge } = reading;
  const refs = items.flatMap((id) => {
    const type = readItem(db, id)?.type;
    if (type === undefined) return [];
    const key = `${pageKindOfType(type)}/${id}`;
    return readStoredWikiPage(db, key) ? [{ kind: WIKI_PAGE_KIND_NAME, id: key }] : [];
  });
  const shown = judge.shown(refs);
  return versionIds(
    db,
    refs.filter((r) => shown.has(refKey(r))).flatMap((r) => registry.lineage(db, r)),
  );
}

const VECTOR_REF = /^source-version:(\d+):(\d+)$/;

export type VectorOutcome =
  { status: "ok"; ids: number[] } | { status: "unavailable"; reason: string };

/** X01-R22: a status check that throws is `unavailable` with a fixed reason; the error's own text is never carried. */
async function statusOf<T>(
  status: () => Promise<T>,
  what: string,
): Promise<T | { unavailable: string }> {
  try {
    return await status();
  } catch {
    return { unavailable: `${what}: status check failed` };
  }
}

/** RSP-D3: the index is asked for `k` = 50, then doubled each time, at most `rounds` asks (50, 100, 200, 400). */
export const VECTOR_GROWTH = { k: STRATEGY_LIST_LIMIT, rounds: 4 } as const;

/**
 * `vector`: the query embedded once and searched through the adapters as they are. Not ready, missing or rebuilding is
 * `unavailable` with the adapter's own reason; nothing is faked and nothing falls back to another strategy (D4, D6).
 * While fewer than STRATEGY_LIST_LIMIT of the answers pass `admit` and the index gave all `k` it was asked for, it is
 * asked again with `k` doubled, up to the round limit, so hidden sources do not take the places (RSP-R2).
 */
export async function vectorIds(
  { db, question }: Reading,
  deps: VectorDeps | undefined,
  signal: AbortSignal | undefined,
  admit: (ids: readonly number[]) => number[],
  growth: { k: number; rounds: number } = VECTOR_GROWTH,
): Promise<VectorOutcome> {
  if (!deps)
    return { status: "unavailable", reason: "no embedding provider or vector index is configured" };
  const embedding = await statusOf(() => deps.embedding.status(), "embedding model");
  if (embedding !== "ready") {
    return {
      status: "unavailable",
      reason:
        typeof embedding === "string" ? `embedding model: ${embedding}` : embedding.unavailable,
    };
  }
  const index = await statusOf(() => deps.index.status(), "vector index");
  if (index !== "ready") {
    return {
      status: "unavailable",
      reason: typeof index === "string" ? `vector index: ${index}` : index.unavailable,
    };
  }
  try {
    const [query] = await deps.embedding.embed([question], "query", signal);
    if (!query)
      return { status: "unavailable", reason: "the embedding provider returned no vector" };
    let ids: number[] = [];
    for (let round = 0, k = growth.k; round < growth.rounds; round++, k *= 2) {
      const found = await deps.index.search(query, k);
      const refs = found.flatMap(({ ref }) => {
        const m = VECTOR_REF.exec(ref);
        return m ? [{ sourceId: Number(m[1]), version: Number(m[2]) }] : [];
      });
      ids = versionIds(db, refs);
      if (found.length < k || admit(ids).length >= STRATEGY_LIST_LIMIT) break;
    }
    return { status: "ok", ids };
  } catch (e) {
    if (e instanceof AdapterUnavailableError) return { status: "unavailable", reason: e.message };
    throw e;
  }
}
