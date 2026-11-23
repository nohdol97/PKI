// The read paths of the screens (I04-R13): what leaves the backend as a derived row passes the registry's
// `visible` first, for the purpose the path names, the same judgement the wrapped engine applies
// (knowledge-engine adapters/visible-engine.ts). A row whose source versions are not all stored and
// uncovered, or whose scopes the policy does not allow, is left out of the answer whole: no count, title,
// snippet, order or error of it reaches the caller. A registry that cannot judge throws and the call fails
// (the server answers a generic 500): a row is never shown unjudged.
import { createProductRegistry, listMergeCandidates } from "@pki/knowledge-engine";
import type { RouteResponse, SemanticKind, SemanticList, SourceSummary } from "@pki/contracts";
import {
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
  type DerivativeRegistry,
  type DerivedRef,
  type ElementRule,
  type EvidenceSourceView,
  type InsightEvidenceRow,
  type InsightUserInputRow,
  defaultScopePolicy,
  type ScopePurpose,
  type SqlDriver,
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
  /** The Semantic registry's items with the facts and relations shown (S01-R23): a hidden row is left out whole. */
  semantic(): SemanticList;
  /**
   * The merge candidates whose two items are both shown (S02-R25): a pair with a hidden end is left out whole.
   * R24's path check on this list is S02-T09's.
   */
  mergeCandidates(): RouteResponse<"entityCandidates">;
  /** Whether the registry row is stored and shown: the one answer for a row that is absent, deleted or hidden. */
  semanticShown(kind: SemanticKind, id: number): boolean;
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
  return {
    sources: () => filled((n) => listSources(db, n), "source", "display", sourcesLimit),
    searchSources: (query) =>
      filled((n) => findSources(db, query, n), "source", "search", searchLimit),
    insights: () =>
      only(listActiveInsights(db), "insight", (i) => i.id, "display").map((insight) => ({
        ...insight,
        evidenceCount: shownEvidence(insight.id).length + shownUserInputs(insight.id).length,
      })),
    insightEvidence(insightId) {
      if (!isShown("insight", insightId)) return undefined;
      const read = readInsightEvidence(db, insightId);
      if (!read) return undefined;
      const evidence = only(read.evidence, "evidence", (e) => e.id, "display");
      const userInputs = shownUserInputs(insightId);
      return {
        insight: { ...read.insight, evidenceCount: evidence.length + userInputs.length },
        evidence,
        userInputs,
      };
    },
    evidenceSource(evidenceId) {
      return isShown("evidence", evidenceId) ? readEvidenceSource(db, evidenceId) : undefined;
    },
    semantic() {
      // one more than the limit tells whether the list was cut
      const rowsOf = <T extends { id: number }>(item: T) => ({
        ...item,
        facts: only(listSemanticFacts(db, item.id), "fact", (f) => f.id, "display"),
        relations: only(listSemanticRelations(db, item.id), "relation", (r) => r.id, "display"),
      });
      // `mergedInto` is the nearest item along the chain the caller may see: a hidden item is named nowhere,
      // and a member with none visible is left out
      const nearestShown = <T extends { mergedInto: number }>(members: T[]): T[] =>
        members.flatMap((m) => {
          for (
            let at: number | undefined = m.mergedInto, n = 0;
            at !== undefined && n < 1000;
            n++
          ) {
            if (isShown("item", at)) return [{ ...m, mergedInto: at }];
            at = mergedIntoOf(db, at);
          }
          return [];
        });
      // a member is listed under its representative, not as an entry of its own (S02-R13)
      const items = filled((n) => listSemanticItems(db, n), "item", "display", semanticLimit + 1);
      return {
        items: items.slice(0, semanticLimit).map((item) => ({
          ...rowsOf(item),
          members: nearestShown(
            only(listSemanticMembers(db, item.id), "item", (m) => m.id, "display"),
          ).map(rowsOf),
        })),
        truncated: items.length > semanticLimit,
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
        const kept = rows.filter((r) => ids.has(String(r.a)) && ids.has(String(r.b)));
        if (kept.length >= limit || rows.length < n || n >= cap) {
          return {
            candidates: kept.slice(0, semanticLimit),
            truncated: kept.length > semanticLimit,
          };
        }
      }
    },
    semanticShown: (kind, id) =>
      readSemanticState(db, { kind, id }) !== undefined && isShown(kind, id),
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
