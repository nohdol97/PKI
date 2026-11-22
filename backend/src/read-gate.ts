// The read paths of the screens (I04-R13): what leaves the backend as a derived row passes the registry's
// `visible` first, for the purpose the path names, the same judgement the wrapped engine applies
// (knowledge-engine adapters/visible-engine.ts). A row whose source versions are not all stored and
// uncovered, or whose scopes the policy does not allow, is left out of the answer whole: no count, title,
// snippet, order or error of it reaches the caller. A registry that cannot judge throws and the call fails
// (the server answers a generic 500): a row is never shown unjudged.
import { createProductRegistry } from "@pki/knowledge-engine";
import type { SourceSummary } from "@pki/contracts";
import {
  findSources,
  listActiveInsights,
  listSources,
  readEvidenceSource,
  readInsightEvidence,
  type ActiveInsight,
  type DerivativeRegistry,
  type DerivedRef,
  type EvidenceSourceView,
  type InsightEvidenceRow,
  type ScopePurpose,
  type SqlDriver,
} from "@pki/storage";
import { INTERIM_POLICY } from "./interim-policy.ts";

/** The registry a server without a composition point runs: the product's kinds, the interim policy. */
export const defaultReadRegistry: DerivativeRegistry = createProductRegistry({
  policy: INTERIM_POLICY,
});

export interface ReadGate {
  sources(): SourceSummary[];
  searchSources(query: string): SourceSummary[];
  insights(): ActiveInsight[];
  /** undefined when the Insight is absent, not active or not shown: the same answer for each. */
  insightEvidence(
    insightId: number,
  ): { insight: ActiveInsight; evidence: InsightEvidenceRow[] } | undefined;
  /** undefined when the evidence row is absent or not shown. */
  evidenceSource(evidenceId: number): EvidenceSourceView | undefined;
}

export interface ReadGateOptions {
  /** How many sources the list and the search return (provisional: the storage reads' own limits). */
  sourcesLimit?: number;
  searchLimit?: number;
}

const SOURCES_LIMIT = 100;
const SEARCH_LIMIT = 50;
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
  /** Reads `limit` rows and, while hidden ones left the answer short, a wider window. */
  const filled = <T>(read: (n: number) => T[], keep: (rows: T[]) => T[], limit: number): T[] => {
    for (let n = limit; ; n *= 4) {
      const rows = read(n);
      const kept = keep(rows);
      if (kept.length >= limit || rows.length < n || n >= MAX_SCAN) return kept.slice(0, limit);
    }
  };
  const sourcesLimit = options.sourcesLimit ?? SOURCES_LIMIT;
  const searchLimit = options.searchLimit ?? SEARCH_LIMIT;
  const isShown = (kind: string, id: number) =>
    shown([{ kind, id: String(id) }], "display").has(String(id));
  return {
    sources: () =>
      filled(
        (n) => listSources(db, n),
        (rows) => only(rows, "source", (s) => s.id, "display"),
        sourcesLimit,
      ),
    searchSources: (query) =>
      filled(
        (n) => findSources(db, query, n),
        (rows) => only(rows, "source", (s) => s.id, "search"),
        searchLimit,
      ),
    insights: () => only(listActiveInsights(db), "insight", (i) => i.id, "display"),
    insightEvidence(insightId) {
      if (!isShown("insight", insightId)) return undefined;
      const read = readInsightEvidence(db, insightId);
      if (!read) return undefined;
      return {
        insight: read.insight,
        evidence: only(read.evidence, "evidence", (e) => e.id, "display"),
      };
    },
    evidenceSource(evidenceId) {
      return isShown("evidence", evidenceId) ? readEvidenceSource(db, evidenceId) : undefined;
    },
  };
}
