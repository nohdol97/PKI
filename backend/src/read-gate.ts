// The read paths of the screens (I04-R13): what leaves the backend as a derived row passes the registry's
// `visible` first, for the purpose the path names, the same judgement the wrapped engine applies
// (knowledge-engine adapters/visible-engine.ts). A row whose source versions are not all stored and
// uncovered, or whose scopes the policy does not allow, is left out of the answer whole: no count, title,
// snippet, order or error of it reaches the caller. A registry that cannot judge throws and the call fails
// (the server answers a generic 500): a row is never shown unjudged.
import {
  createJudge,
  createProductRegistry,
  listMergeCandidates,
  relationPaths,
  traceChains,
  visibleLinks,
} from "@pki/knowledge-engine";
import { EXPLORE_PAGE_SIZE, LIST_PAGE_SIZE } from "@pki/contracts";
import type {
  RouteRequest,
  RouteResponse,
  SemanticKind,
  SemanticList,
  SourceSummary,
} from "@pki/contracts";
import {
  dataChecksUnmet,
  describeKnowledgeSchema,
  findSources,
  listActiveInsights,
  listOntologyElements,
  listInsightEvidenceIds,
  listInsightUserInputs,
  listSemanticFacts,
  listSemanticItems,
  listSemanticMembers,
  mergedIntoOf,
  listSemanticRelations,
  listSources,
  readEvidenceSource,
  readOntologyElementById,
  readInsightEvidence,
  readSemanticState,
  type ActiveInsight,
  type DataCheckUnmet,
  type DerivativeRegistry,
  type DerivedRef,
  type HeldCounts,
  type ElementRule,
  type EvidenceSourceView,
  type InsightEvidenceRow,
  type InsightUserInputRow,
  defaultScopePolicy,
  type ScopePurpose,
  type SemanticItemView,
  type SqlDriver,
  effectiveUntil,
  entityGroups,
  listAssertionLinks,
  supersedingStands,
  readFact,
  unionOfVersions,
} from "@pki/storage";

/** The registry a server without a composition point runs: the product's kinds, the default scope policy. */
export const defaultReadRegistry: DerivativeRegistry = createProductRegistry({
  policy: defaultScopePolicy,
});

const plainFact = ({
  dataChecks,
  ...rule
}: Extract<ElementRule, { elementKind: "fact-kind" }>) => ({
  ...rule,
  itemTypes: [...rule.itemTypes],
  ...(dataChecks ? { dataChecks: [...dataChecks] } : {}),
});

/** A rule as the contract types it: mutable lists. */
const plain = (rule: ElementRule): RouteResponse<"ontology">["elements"][number]["rule"] =>
  rule.elementKind === "fact-kind"
    ? plainFact(rule)
    : rule.elementKind === "relation-type"
      ? { ...rule, subjectTypes: [...rule.subjectTypes], objectTypes: [...rule.objectTypes] }
      : rule;

export interface ReadGate {
  sources(): SourceSummary[];
  searchSources(query: string): SourceSummary[];
  insights(): ActiveInsight[];
  /** undefined when the Insight is absent, not active or not shown: the same answer for each. */
  insightEvidence(
    insightId: number,
  ):
    | { insight: ActiveInsight; evidence: InsightEvidenceRow[]; userInputs: InsightUserInputRow[] }
    | undefined;
  /** undefined when the evidence row is absent or not shown. */
  evidenceSource(evidenceId: number): EvidenceSourceView | undefined;
  /** Whether both end items of the stored Insight are shown (P01-R15, D30); false when no row is stored. */
  insightEndsShown(insightId: number): boolean;
  /** Whether the source version is stored and shown: the one answer for a version that is absent, deleted or hidden. */
  sourceShown(versionId: number): boolean;
  /** The Semantic registry's items with the facts and relations shown (S01-R23): a hidden row is left out whole. */
  semantic(): SemanticList;
  /**
   * One page of the Semantic list by status (X02B-R3): representatives only, ascending, 50 a page. With a `status`, an
   * item stays when its own row, a shown member's or a shown fact or relation of either has that status; hidden rows
   * count for nothing, and a hidden item takes no slot of the page or place of `next`.
   */
  semanticPage(request: RouteRequest<"semanticPage">): RouteResponse<"semanticPage">;
  /** One page of the source list, newest first, over the sources shown (X02B-R4). */
  sourcesPage(request: RouteRequest<"sourcesPage">): RouteResponse<"sourcesPage">;
  /**
   * The merge candidates (S02-R24, R25): a pair is listed only when both items and every member of their two groups
   * are shown and the policy lets the two groups' sources be put together; one with a hidden end is left out whole.
   */
  mergeCandidates(): RouteResponse<"entityCandidates">;
  /**
   * The conflict list (S02-R19, R24, R25): a link is listed only when it and both its facts are shown and the policy lets their sources be put together; each fact's
   * effective end is computed from the listed SUPERSEDES links alone, so nothing of a hidden side shows.
   */
  conflicts(): RouteResponse<"conflicts">;
  /** S02-R21, R24: undefined when the start is absent, not active or not shown. */
  graphTrace(start: RouteRequest<"graphTrace">): RouteResponse<"graphTrace"> | undefined;
  /** S02-R22, R24: undefined when an end is absent or not shown; the depth refusal is an answer. */
  graphPaths(query: RouteRequest<"graphPaths">): RouteResponse<"graphPaths"> | undefined;
  /** Whether the registry row is stored and shown: the one answer for a row that is absent, deleted or hidden. */
  semanticShown(kind: SemanticKind, id: number): boolean;
  /**
   * The unmet data conditions of a refused approval as the caller sees them (S03 decision 36 ①): judged over the
   * rows shown; `check-missing` alone when only hidden rows block.
   */
  dataUnmetShown(factId: number): readonly DataCheckUnmet[];
  /** What hangs on an item, counting shown rows only (S03 decision 36 ②). */
  heldShown(itemId: number): HeldCounts;
  /**
   * The type definitions shown (S01-R23). A `candidate` or `rejected` element follows its lineage and
   * is judged like any derived row; a `verified` or retired one has none and is always shown.
   */
  ontology(): RouteResponse<"ontology">;
  /** Whether the element is stored and shown: the one answer for an id that is absent, deleted or hidden. */
  ontologyShown(id: number): boolean;
  /**
   * The knowledge-schema list (S02-R25): the catalogue against the type definitions shown. A definition the
   * gate hides counts as absent, so the list does not reveal a candidate of a source the caller may not see.
   */
  knowledgeSchema(): RouteResponse<"knowledgeSchema">;
}

export interface ReadGateOptions {
  /** How many sources the list and the search return (provisional: the storage reads' own limits). */
  sourcesLimit?: number;
  searchLimit?: number;
  /** How many items the Semantic list returns. */
  semanticLimit?: number;
  /** The most rows read to fill a limit (default 10000; a test lowers it). */
  maxScan?: number;
}

const SOURCES_LIMIT = 100;
const SEARCH_LIMIT = 50;
/** Provisional (S01-T02): the Semantic list's items per answer; `truncated` says more exist. */
const SEMANTIC_LIMIT = 100;
/** Items read per round while filling a page of `semanticPage`. */
const SEMANTIC_BATCH = 100;
/** The most rows read to fill a limit when many are hidden (the window grows fourfold until then). */
const MAX_SCAN = 10_000;

export function createReadGate(
  db: SqlDriver,
  registry: DerivativeRegistry,
  options: ReadGateOptions = {},
): ReadGate {
  const shown = (refs: DerivedRef[], purpose: ScopePurpose) =>
    new Set(registry.visible(db, refs, purpose).map((r) => r.id));
  const only = <T>(rows: T[], kind: string, idOf: (row: T) => number, purpose: ScopePurpose) => {
    const ids = shown(
      rows.map((row) => ({ kind, id: String(idOf(row)) })),
      purpose,
    );
    return rows.filter((row) => ids.has(String(idOf(row))));
  };
  /**
   * Reads `limit` rows and, while hidden ones left the answer short, a window fourfold wider, never
   * past the cap. A row is judged once per call: the wider read repeats the rows already judged.
   */
  const filled = <T extends { id: number }>(
    read: (n: number) => T[],
    kind: string,
    purpose: ScopePurpose,
    limit: number,
  ): T[] => {
    const verdict = new Map<number, boolean>();
    const cap = Math.max(maxScan, 1);
    for (let n = Math.min(limit, cap); ; n = Math.min(n * 4, cap)) {
      const rows = read(n);
      const fresh = rows.filter((row) => !verdict.has(row.id));
      const ids = shown(
        fresh.map((row) => ({ kind, id: String(row.id) })),
        purpose,
      );
      for (const row of fresh) verdict.set(row.id, ids.has(String(row.id)));
      const kept = rows.filter((row) => verdict.get(row.id));
      if (kept.length >= limit || rows.length < n || n >= cap) return kept.slice(0, limit);
    }
  };
  /** The evidence ids of an Insight that are shown: the count the API gives is of these, never of the stored links. */
  const shownEvidence = (insightId: number) => {
    const ids = listInsightEvidenceIds(db, insightId);
    const ok = shown(
      ids.map((id) => ({ kind: "evidence", id: String(id) })),
      "display",
    );
    return ids.filter((id) => ok.has(String(id)));
  };
  /** The user-input rows of an Insight that are shown (S01-R15): a fact or relation is judged under its own lineage. */
  const shownUserInputs = (insightId: number): InsightUserInputRow[] => {
    const inputs = listInsightUserInputs(db, insightId);
    const kept = (target: "fact" | "relation") =>
      only(
        inputs.filter((u) => u.target === target),
        target,
        (u) => u.id,
        "display",
      );
    return [...kept("fact"), ...kept("relation")];
  };
  const maxScan = options.maxScan ?? MAX_SCAN;
  const sourcesLimit = options.sourcesLimit ?? SOURCES_LIMIT;
  const searchLimit = options.searchLimit ?? SEARCH_LIMIT;
  const semanticLimit = options.semanticLimit ?? SEMANTIC_LIMIT;
  const isShown = (kind: string, id: number) =>
    shown([{ kind, id: String(id) }], "display").has(String(id));
  const rowsOf = <T extends { id: number }>(item: T) => ({
    ...item,
    facts: only(listSemanticFacts(db, item.id), "fact", (f) => f.id, "display"),
    relations: only(listSemanticRelations(db, item.id), "relation", (r) => r.id, "display"),
  });
  // `mergedInto` is the nearest item along the chain the caller may see: a hidden item is named nowhere,
  // and a member with none visible is left out
  const nearestShown = <T extends { mergedInto: number }>(members: T[]): T[] =>
    members.flatMap((m) => {
      for (let at: number | undefined = m.mergedInto, n = 0; at !== undefined && n < 1000; n++) {
        if (isShown("item", at)) return [{ ...m, mergedInto: at }];
        at = mergedIntoOf(db, at);
      }
      return [];
    });
  const semanticItem = (item: SemanticItemView) => ({
    ...rowsOf(item),
    members: nearestShown(
      only(listSemanticMembers(db, item.id), "item", (m) => m.id, "display"),
    ).map(rowsOf),
  });
  const hasStatus = (view: ReturnType<typeof semanticItem>, status: string) =>
    [view, ...view.members].some(
      (row) =>
        row.status === status ||
        row.facts.some((f) => f.status === status) ||
        row.relations.some((r) => r.status === status),
    );
  const endsShown = (x: number, y: number) => isShown("item", x) && isShown("item", y);
  return {
    sources: () => filled((n) => listSources(db, n), "source", "display", sourcesLimit),
    searchSources: (query) =>
      filled((n) => findSources(db, query, n), "source", "search", searchLimit),
    insights() {
      const rows = only(listActiveInsights(db), "insight", (i) => i.id, "display");
      // P01-R15: an end item with a fact from a hidden source hides the Insight too
      const items = shown(
        rows.flatMap((i) => [
          { kind: "item", id: String(i.xItemId) },
          { kind: "item", id: String(i.yItemId) },
        ]),
        "display",
      );
      return rows
        .filter((i) => items.has(String(i.xItemId)) && items.has(String(i.yItemId)))
        .map((insight) => ({
          ...insight,
          evidenceCount: shownEvidence(insight.id).length + shownUserInputs(insight.id).length,
        }));
    },
    insightEvidence(insightId) {
      if (!isShown("insight", insightId)) return undefined;
      const read = readInsightEvidence(db, insightId);
      if (!read) return undefined;
      if (!endsShown(read.insight.xItemId, read.insight.yItemId)) return undefined;
      const evidence = only(read.evidence, "evidence", (e) => e.id, "display");
      const userInputs = shownUserInputs(insightId);
      return {
        insight: { ...read.insight, evidenceCount: evidence.length + userInputs.length },
        evidence,
        userInputs,
      };
    },
    insightEndsShown(insightId) {
      const ends = db.all("SELECT x_item_id AS x, y_item_id AS y FROM insights WHERE id = ?", [
        insightId,
      ])[0];
      return ends !== undefined && endsShown(ends.x as number, ends.y as number);
    },
    evidenceSource(evidenceId) {
      return isShown("evidence", evidenceId) ? readEvidenceSource(db, evidenceId) : undefined;
    },
    sourceShown: (versionId) => isShown("source", versionId),
    semantic() {
      // one more than the limit tells whether the list was cut
      // a member is listed under its representative, not as an entry of its own (S02-R13)
      const items = filled((n) => listSemanticItems(db, n), "item", "display", semanticLimit + 1);
      return {
        items: items.slice(0, semanticLimit).map(semanticItem),
        truncated: items.length > semanticLimit,
      };
    },
    semanticPage({ status, after }) {
      const kept: ReturnType<typeof semanticItem>[] = [];
      let cursor = after ?? 0;
      let scanned = 0;
      // read on until a page and one more are kept: the one more says `next` exists
      while (kept.length <= EXPLORE_PAGE_SIZE && scanned < maxScan) {
        const rows = listSemanticItems(db, SEMANTIC_BATCH, cursor);
        for (const row of only(rows, "item", (i) => i.id, "display")) {
          const view = semanticItem(row);
          if (status === undefined || hasStatus(view, status)) kept.push(view);
          if (kept.length > EXPLORE_PAGE_SIZE) break;
        }
        cursor = rows.at(-1)?.id ?? cursor;
        scanned += rows.length;
        if (rows.length < SEMANTIC_BATCH) break;
      }
      const page = kept.slice(0, EXPLORE_PAGE_SIZE);
      return {
        items: page,
        next: kept.length > EXPLORE_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
      };
    },
    sourcesPage({ before }) {
      const rows = filled(
        (n) => listSources(db, n, before),
        "source",
        "display",
        LIST_PAGE_SIZE + 1,
      );
      const page = rows.slice(0, LIST_PAGE_SIZE);
      return {
        sources: page,
        next: rows.length > LIST_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
      };
    },
    mergeCandidates() {
      // one more than the limit tells whether the list was cut; a wider read while hidden pairs left it short
      const cap = Math.max(maxScan, 1);
      const limit = semanticLimit + 1;
      for (let n = Math.min(limit, cap); ; n = Math.min(n * 4, cap)) {
        const rows = listMergeCandidates(db, n);
        const ids = shown(
          [...new Set(rows.flatMap((r) => [r.a, r.b]))].map((id) => ({
            kind: "item",
            id: String(id),
          })),
          "display",
        );
        const groups = new Map(
          [...new Set(rows.flatMap((r) => [r.a, r.b]))].map((id) => [
            id,
            entityGroups.membersOf(db, id),
          ]),
        );
        const memberIds = shown(
          [...new Set([...groups.values()].flat())].map((id) => ({ kind: "item", id: String(id) })),
          "display",
        );
        // the two groups' sources together must be allowed too (R24): a signal may come from any member
        const kept = rows.filter(
          (r) =>
            ids.has(String(r.a)) &&
            ids.has(String(r.b)) &&
            [...(groups.get(r.a) ?? []), ...(groups.get(r.b) ?? [])].every((m) =>
              memberIds.has(String(m)),
            ) &&
            registry.combinable(
              db,
              unionOfVersions(entityGroups.lineageOf(db, r.a), entityGroups.lineageOf(db, r.b)),
            ),
        );
        if (kept.length >= limit || rows.length < n || n >= cap) {
          return {
            candidates: kept.slice(0, semanticLimit),
            truncated: kept.length > semanticLimit,
          };
        }
      }
    },
    conflicts() {
      const read = listAssertionLinks(db, Math.max(maxScan, 1));
      // the link's lineage is both facts' together: the policy must also let the two be put together (S02-R24)
      const listed = visibleLinks(db, registry, createJudge(db, registry, "display", false), read);
      const facts = new Map(
        [...new Set(listed.flatMap((l) => [l.fromFactId, l.toFactId]))].flatMap((id) => {
          const fact = readFact(db, id);
          return fact ? [[id, fact] as const] : [];
        }),
      );
      const end = (factId: number) =>
        effectiveUntil(
          facts.get(factId)?.validUntil ?? null,
          listed
            .filter((l) => l.toFactId === factId && supersedingStands(db, l))
            .map((l) => facts.get(l.fromFactId)?.validAt ?? null),
        );
      const side = (factId: number) => ({
        factId,
        itemId: facts.get(factId)?.itemId as number,
        effectiveUntil: end(factId),
      });
      return {
        links: listed.slice(0, semanticLimit).map((l) => ({
          id: l.id,
          type: l.type,
          createdBy: l.createdBy,
          from: side(l.fromFactId),
          to: side(l.toFactId),
        })),
        truncated: listed.length > semanticLimit,
      };
    },
    graphTrace: (start) => traceChains(db, registry, start, "display"),
    graphPaths: (query) => relationPaths(db, registry, query, "display"),
    semanticShown: (kind, id) =>
      readSemanticState(db, { kind, id }) !== undefined && isShown(kind, id),
    dataUnmetShown: (factId) => {
      const list = dataChecksUnmet(db, { kind: "fact", id: factId }, (kind, id) =>
        shown([{ kind, id }], "display").has(id),
      );
      return list.length > 0 ? list : ["check-missing"];
    },
    heldShown: (itemId) => {
      const ids = (sql: string, params: number[]) => db.all(sql, params).map((r) => r.id as number);
      // a merge line, distinct mark or split record counts when the other item it names is shown
      const others = (sql: string) =>
        db.all(sql, [itemId, itemId]).filter((r) => {
          const other = (r.a as number) === itemId ? (r.b as number) : (r.a as number);
          return isShown("item", other);
        }).length;
      return {
        facts: ids("SELECT id FROM facts WHERE item_id = ?", [itemId]).filter((id) =>
          isShown("fact", id),
        ).length,
        relations: ids("SELECT id FROM relations WHERE subject_id = ? OR object_id = ?", [
          itemId,
          itemId,
        ]).filter((id) => isShown("relation", id)).length,
        merges: others(
          "SELECT member_id AS a, representative_id AS b FROM item_merges WHERE member_id = ? OR representative_id = ?",
        ),
        distinct: others(
          "SELECT item_a AS a, item_b AS b FROM item_distinct WHERE item_a = ? OR item_b = ?",
        ),
        splitMoves: others(
          "SELECT from_item_id AS a, to_item_id AS b FROM item_split_moves WHERE from_item_id = ? OR to_item_id = ?",
        ),
      };
    },
    ontology: () => ({
      elements: only(listOntologyElements(db), "ontology", (e) => e.id, "display").map((e) => ({
        ...e,
        rule: plain(e.rule),
      })),
    }),
    knowledgeSchema: () =>
      describeKnowledgeSchema(only(listOntologyElements(db), "ontology", (e) => e.id, "display")),
    ontologyShown: (id) => readOntologyElementById(db, id) !== undefined && isShown("ontology", id),
  };
}
