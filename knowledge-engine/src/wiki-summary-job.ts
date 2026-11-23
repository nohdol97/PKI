// The `wiki-summary` job (K01-R12, R13): one Wiki page's LLM summary. It has no source and no version fence:
// its target names a page and the content hash it was asked at. It ends without a Provider call when the
// setting is off, the page is gone or an Insight page, is already summarized at its current content, has no
// lineage or too many versions, the policy will not put its lineage together, or its documents do not fit
// one call. Otherwise it makes one Broker call of IDs only (the lineage's version rows and the page's item);
// the Broker grades, and asks consent and egress. A call that was not answered goes back to the runner as the
// Broker gave it (a blocked one holds the job); no other Provider is tried. A sentence is kept only when its
// quote is found, exactly once, in the stored body of the document it names; the code computes the position.
// The result is written to the page row through commitDerived, and only while the page still has the content
// hash it was made for.
import {
  WIKI_SUMMARY_SCHEMA_VERSION,
  type BrokerResult,
  type WikiSummaryOutput,
} from "@pki/providers";
import {
  findSourceVersionId,
  lineageOfWikiPage,
  readSourceVersion,
  readStoredWikiPage,
  readWikiSummary,
  WIKI_SUMMARY_KIND,
  WIKI_SUMMARY_MAX_VERSIONS,
  writeWikiSummary,
  type DerivedItem,
  type DerivativeRegistry,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_CODE_POINTS, type RunBroker } from "./extraction.ts";
import { locateQuote } from "./quote.ts";
import { WIKI_PAGE_KIND_NAME } from "./wiki-kind.ts";

/** Provisional (K01-R13): sentences kept per page. */
export const WIKI_SUMMARY_MAX_SENTENCES = 5;

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type WikiSummaryResult =
  { status: "succeeded"; items: readonly DerivedItem[] } | Exclude<BrokerResult, { status: "ok" }>;

export interface WikiSummaryHandlerOptions {
  db: SqlDriver;
  /** The registry whose policy says whether a lineage may be put together; default the entries' own. */
  registry?: Pick<DerivativeRegistry, "combinable">;
}

const nothing: WikiSummaryResult = { status: "succeeded", items: [] };

export function createWikiSummaryHandler(options: WikiSummaryHandlerOptions) {
  const { db } = options;
  const registry = options.registry ?? derivativeRegistry;

  return async (job: StoredJob, context: { broker: RunBroker }): Promise<WikiSummaryResult> => {
    // the target is `<key>#<content hash>`; the page is summarized as it is now
    const key = job.target.slice(0, job.target.lastIndexOf("#"));
    const page = readStoredWikiPage(db, key);
    if (!readWikiSummary(db) || !page || page.kind === "syntheses") return nothing;
    if (page.summaryHash === page.contentHash) return nothing;
    const lineage = lineageOfWikiPage(db, key);
    if (lineage.length === 0 || lineage.length > WIKI_SUMMARY_MAX_VERSIONS) return nothing;
    // R9: a combination the policy refuses is not put in one call, and so not in one summary
    if (!registry.combinable(db, lineage)) return nothing;

    const documents = new Map<string, { sourceId: number; version: number; body: string }>();
    let size = 0;
    for (const ref of lineage) {
      const id = findSourceVersionId(db, ref.sourceId, ref.version);
      const stored = id === undefined ? undefined : readSourceVersion(db, id);
      if (id === undefined || !stored) return nothing;
      size += [...stored.title].length + [...stored.body].length;
      documents.set(String(id), { ...ref, body: stored.body });
    }
    if (size > MAX_EXTRACT_CODE_POINTS) return nothing;

    const result = await context.broker.call({
      taskKind: WIKI_SUMMARY_KIND,
      sourceVersionIds: [...documents.keys()],
      candidateItemIds: [page.target],
      origin: { jobId: String(job.id), leaseToken: String(job.leaseToken) },
      schemaVersion: WIKI_SUMMARY_SCHEMA_VERSION,
      budget: { timeoutMs: EXTRACT_TIMEOUT_MS },
      retryable: false,
    });
    if (result.status !== "ok") return result;

    // the Broker checked the answer against the schema
    const kept = (result.output as WikiSummaryOutput).sentences
      .flatMap((s) => {
        const document = documents.get(s.documentId);
        const span = document && locateQuote(document.body, s.quote);
        return document && span && !("dropped" in span)
          ? [
              {
                sentence: s.text,
                sourceId: document.sourceId,
                version: document.version,
                start: span.start,
                end: span.end,
              },
            ]
          : [];
      })
      .slice(0, WIKI_SUMMARY_MAX_SENTENCES);
    const hash = page.contentHash;
    return {
      status: "succeeded",
      items: [
        {
          kind: WIKI_PAGE_KIND_NAME,
          itemKey: `summary:${key}`,
          lineage,
          write: (tx: SqlDriver) => void writeWikiSummary(tx, key, hash, JSON.stringify(kept)),
        },
      ],
    };
  };
}
