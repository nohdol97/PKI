// X01-R1~R7: one question in, `{ route, hits, notes }` out. The route is chosen by code from the question's words
// (R2), the strategies that run each give a ranked list of source versions, the lists are merged by the
// rank-reciprocal sum with the preference weight (R3, R4), and the marks and links are computed for what is left.
// Nothing here writes to the store. What the policy hides for a search is dropped from every list before the
// lists are fused (R12); the caller still judges the hits with `visible` at its boundary and drops the notes of a
// hit it drops.
import {
  readVersionHeads,
  type DerivativeRegistry,
  type SqlDriver,
  type VersionHead,
} from "@pki/storage";
import { createJudge } from "../graph-read.ts";
import { merge } from "./fusion.ts";
import { gapNotes, relatedLinks, shownVersions } from "./notes.ts";
import { routeQuestion } from "./routing.ts";
import {
  conceptIds,
  conceptQueries,
  graphIds,
  keywordIds,
  matchItems,
  temporalIds,
  vectorIds,
  wikiIds,
  type Reading,
} from "./strategies.ts";
import {
  ALWAYS_ON,
  DEFAULT_ENABLED_STRATEGIES,
  STRATEGIES,
  type Hit,
  type RetrievalConditions,
  type RetrievalResult,
  type RetrieveOptions,
  type Route,
  type StrategyName,
} from "./types.ts";

/** Whether the filter fields hold anything. */
const hasConditions = (c: RetrievalConditions) =>
  (c.connectorIds?.length ?? 0) > 0 || c.from !== undefined || c.to !== undefined;

function bound(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`${name} is not a date: ${value}`);
  return ms;
}

/**
 * R1 `metadata`: keeps the versions of the asked collectors and, when a time range is asked, those whose origin
 * time (`meta.updatedAt`, else `createdAt`, as the record gave it) lies in it; a version carrying no time cannot
 * be shown to lie in a range and is dropped when one is asked.
 */
function filterByConditions(
  db: SqlDriver,
  ids: readonly number[],
  c: RetrievalConditions,
): number[] {
  const from = bound(c.from, "from");
  const to = bound(c.to, "to");
  const collectors = new Set(c.connectorIds ?? []);
  const kept = new Set(
    readVersionHeads(db, ids)
      .filter((h) => collectors.size === 0 || collectors.has(h.connectorId))
      .filter((h) => {
        if (from === undefined && to === undefined) return true;
        const at = h.originAt === null ? Number.NaN : Date.parse(h.originAt);
        return (
          !Number.isNaN(at) && (from === undefined || at >= from) && (to === undefined || at <= to)
        );
      })
      .map((h) => h.id),
  );
  return ids.filter((id) => kept.has(id));
}

export async function retrieve(
  db: SqlDriver,
  registry: DerivativeRegistry,
  question: string,
  conditions: RetrievalConditions = {},
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const enabled = new Set<StrategyName>([
    ...ALWAYS_ON,
    ...(options.enabled ?? DEFAULT_ENABLED_STRATEGIES),
  ]);
  const judge = createJudge(db, registry, "search", false);
  const reading: Reading = { db, registry, judge, question };

  // the items the question names steer the item-based strategies; matching is skipped when none of them is on
  const itemBased = (["concept", "graph", "temporal", "wiki"] as const).some((s) => enabled.has(s));
  const items = itemBased ? matchItems(reading) : [];
  const wants = routeQuestion(question, items.length);

  const route = Object.fromEntries(STRATEGIES.map((s) => [s, { status: "off" }])) as Route;
  const lists: { strategy: StrategyName; ids: number[] }[] = [];
  const ran = (strategy: StrategyName, ids: number[]) => {
    lists.push({ strategy, ids });
    route[strategy] = { status: "used", count: ids.length };
  };
  const skipped = (strategy: StrategyName) => {
    route[strategy] = { status: "skipped" };
  };

  const useConcept = enabled.has("concept") && wants.concept;
  ran("keyword", keywordIds(reading, useConcept ? conceptQueries(reading, items) : []));
  if (enabled.has("concept")) {
    if (useConcept) ran("concept", conceptIds(reading, items));
    else skipped("concept");
  }
  if (enabled.has("graph")) {
    if (wants.graph) ran("graph", graphIds(reading, items));
    else skipped("graph");
  }
  if (enabled.has("temporal")) {
    if (wants.temporal) ran("temporal", temporalIds(reading, items));
    else skipped("temporal");
  }
  if (enabled.has("wiki")) {
    if (wants.wiki) ran("wiki", wikiIds(reading, items));
    else skipped("wiki");
  }
  if (enabled.has("vector")) {
    const outcome = await vectorIds(reading, options.vector, options.signal);
    if (outcome.status === "ok") ran("vector", outcome.ids);
    else route.vector = outcome;
  }

  if (hasConditions(conditions)) {
    let removed = 0;
    for (const list of lists) {
      const kept = filterByConditions(db, list.ids, conditions);
      removed += list.ids.length - kept.length;
      list.ids = kept;
      route[list.strategy] = { status: "used", count: kept.length };
    }
    route.metadata = { status: "used", count: removed };
  } else {
    skipped("metadata");
  }
  route.rerank = { status: "used", count: new Set(lists.flatMap((l) => l.ids)).size };

  const heads = new Map(
    readVersionHeads(db, [...new Set(lists.flatMap((l) => l.ids))]).map((h) => [h.id, h]),
  );
  // R12: what the policy hides for a search leaves each list before the lists are fused and cut, so a hidden
  // version takes no rank and no hit slot
  const searchable = shownVersions(db, registry, [...heads.keys()]);
  for (const list of lists) list.ids = list.ids.filter((id) => heads.has(id) && searchable.has(id));
  const merged = merge(
    lists,
    (id) => {
      const head = heads.get(id) as VersionHead;
      return { versionId: id, sourceId: head.sourceId, version: head.version };
    },
    options.preference,
  );
  const shown = [
    ...shownVersions(
      db,
      registry,
      merged.map((m) => m.versionId),
    ),
  ];
  const related = relatedLinks(db, judge, shown);
  const hits: Hit[] = merged.map((m, i) => {
    const head = heads.get(m.versionId) as VersionHead;
    return {
      versionId: m.versionId,
      sourceId: head.sourceId,
      version: head.version,
      rank: i + 1,
      score: m.score,
      strategies: m.strategies,
      related: related.get(m.versionId) ?? [],
    };
  });
  return { route, hits, notes: gapNotes(db, registry, judge, shown) };
}
