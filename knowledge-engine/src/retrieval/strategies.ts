// The strategies of X01-R1: each is `(question, state) -> source version row ids, best first`. A strategy that
// reads items, relations, facts or Wiki pages judges every row it reads with the registry's `visible` for a search
// (the judge of graph-read.ts); the versions it names are judged once more by the caller at its boundary (R12).
import { AdapterUnavailableError } from "@pki/contracts";
import {
  entityGroups,
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
import { relationPaths, visibleLinks, type GraphJudge } from "../graph-read.ts";
import { findCandidates, groupLineage } from "../linking.ts";
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
  const { db, registry } = reading;
  return items
    .flatMap((item) => versionIds(db, groupLineage(db, registry, item)).sort((a, b) => b - a))
    .filter((id, i, all) => all.indexOf(id) === i)
    .slice(0, STRATEGY_LIST_LIMIT);
}

/** `concept` also adds the matched items' names and `verified` forms (shown ones) as queries to the keyword strategy. */
export function conceptQueries({ db, judge }: Reading, items: readonly number[]): string[] {
  const names = items.flatMap((id) => readItem(db, id)?.name ?? []);
  const members = new Set(items.flatMap((id) => entityGroups.membersOf(db, id)));
  const forms = listVerifiedForms(db).filter((f) => members.has(f.itemId));
  const ref = (f: { factId: number }): DerivedRef => ({ kind: "fact", id: String(f.factId) });
  const shown = judge.shown(forms.map(ref));
  return [...names, ...forms.filter((f) => shown.has(refKey(ref(f)))).map((f) => f.form)];
}

/**
 * `keyword`: one FTS5 query per content word, one for all of them together, and one per extra query; the lists are
 * merged by the rank-reciprocal sum so a source holding more of the words rises and no word has to be in every source.
 */
export function keywordIds({ db, question }: Reading, extraQueries: readonly string[]): number[] {
  const tokens = keywordTokens(question);
  const queries = [...tokens, ...(tokens.length > 1 ? [tokens.join(" ")] : []), ...extraQueries];
  const lists = queries.map((q) => searchKeyword(db, q, STRATEGY_LIST_LIMIT));
  return bestFirst(reciprocalSum(lists)).slice(0, STRATEGY_LIST_LIMIT);
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
  ).slice(0, STRATEGY_LIST_LIMIT);
}

const FACT_WINDOW = 200;

/**
 * `temporal`: the shown, valid facts that carry a time (of the matched items when there are any), narrowed to the
 * dates the question names, newest first; a question about a change puts the facts that replaced another first.
 * The sources are the current evidence of those facts.
 */
export function temporalIds(reading: Reading, items: readonly number[]): number[] {
  const { db, registry, judge, question } = reading;
  const members =
    items.length > 0 ? items.flatMap((id) => entityGroups.membersOf(db, id)) : undefined;
  const factRef = (id: number): DerivedRef => ({ kind: "fact", id: String(id) });
  const dated = listDatedFacts(db, members, FACT_WINDOW).filter((f) =>
    isValidRow(db, { kind: "fact", id: f.id }, f.status),
  );
  const shown = judge.shown(dated.map((f) => factRef(f.id)));
  const dates = explicitDates(question);
  const facts = dated
    .filter((f) => shown.has(refKey(factRef(f.id))))
    .filter(
      (f) =>
        dates.length === 0 ||
        dates.some((d) => (f.validAt ?? "").startsWith(d) || (f.validUntil ?? "").startsWith(d)),
    );
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
  const refs = ordered.flatMap((f) =>
    listEvidence(db, { factId: f.id })
      .sort((a, b) => Number(b.current) - Number(a.current) || b.id - a.id)
      .map((e) => e.sourceVersionId),
  );
  return [...new Set(refs)].slice(0, STRATEGY_LIST_LIMIT);
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
  ).slice(0, STRATEGY_LIST_LIMIT);
}

const VECTOR_REF = /^source-version:(\d+):(\d+)$/;

export type VectorOutcome =
  { status: "ok"; ids: number[] } | { status: "unavailable"; reason: string };

/**
 * `vector`: the query embedded and searched through the adapters as they are. Not ready, missing or rebuilding is
 * `unavailable` with the adapter's own reason; nothing is faked and nothing falls back to another strategy (D4, D6).
 */
export async function vectorIds(
  { db, question }: Reading,
  deps: VectorDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<VectorOutcome> {
  if (!deps)
    return { status: "unavailable", reason: "no embedding provider or vector index is configured" };
  const embedding = await deps.embedding.status();
  if (embedding !== "ready") {
    return {
      status: "unavailable",
      reason:
        typeof embedding === "string" ? `embedding model: ${embedding}` : embedding.unavailable,
    };
  }
  const index = await deps.index.status();
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
    const found = await deps.index.search(query, STRATEGY_LIST_LIMIT);
    const refs = found.flatMap(({ ref }) => {
      const m = VECTOR_REF.exec(ref);
      return m ? [{ sourceId: Number(m[1]), version: Number(m[2]) }] : [];
    });
    return { status: "ok", ids: versionIds(db, refs) };
  } catch (e) {
    if (e instanceof AdapterUnavailableError) return { status: "unavailable", reason: e.message };
    throw e;
  }
}
